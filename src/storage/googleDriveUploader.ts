import fs from "node:fs";
import path from "node:path";
import { drive_v3, google } from "googleapis";
import { logger } from "../logger";
import type { RunConfig } from "../config";
import type { StorageUploader, UploadFileRequest, UploadResult } from "./types";
import { withRetry } from "../utils/retry";

const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const VISIBLE_FOLDER_SCOPE = "https://www.googleapis.com/auth/drive.file";

export class GoogleDriveUploader implements StorageUploader {
  private readonly drive: drive_v3.Drive;
  private readonly oauthClient;

  constructor(private readonly config: RunConfig) {
    if (!config.googleRefreshToken) {
      throw new Error("GOOGLE_REFRESH_TOKEN is required to initialize GoogleDriveUploader");
    }

    const scope = config.googleDriveMode === "appdata" ? APP_DATA_SCOPE : VISIBLE_FOLDER_SCOPE;

    this.oauthClient = new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.googleRedirectUri
    );

    this.oauthClient.setCredentials({
      refresh_token: config.googleRefreshToken,
      scope
    });

    this.oauthClient.on("tokens", (tokens) => {
      if (!config.googleTokenFile) {
        return;
      }
      if (!tokens.refresh_token && !tokens.access_token) {
        return;
      }

      const current = this.readTokenFile(config.googleTokenFile);
      const next = {
        refresh_token: tokens.refresh_token || current.refresh_token,
        access_token: tokens.access_token || current.access_token,
        expiry_date: tokens.expiry_date || current.expiry_date,
        token_type: tokens.token_type || current.token_type,
        scope
      };

      fs.mkdirSync(path.dirname(config.googleTokenFile), { recursive: true });
      fs.writeFileSync(config.googleTokenFile, JSON.stringify(next, null, 2), { mode: 0o600 });
      logger.info({ tokenFile: config.googleTokenFile }, "Updated OAuth token file");
    });

    this.drive = google.drive({
      version: "v3",
      auth: this.oauthClient
    });
  }

  async uploadFile(input: UploadFileRequest): Promise<UploadResult> {
    return withRetry(
      async () => {
        const media = {
          mimeType: input.mimeType,
          body: fs.createReadStream(input.localPath)
        };

        const requestBody: drive_v3.Schema$File = {
          name: input.fileName
        };

        let spaces: string | undefined;
        if (this.config.googleDriveMode === "appdata") {
          requestBody.parents = ["appDataFolder"];
          spaces = "appDataFolder";
        } else if (this.config.googleDriveFolderId) {
          requestBody.parents = [this.config.googleDriveFolderId];
        }

        const response = await this.drive.files.create({
          requestBody,
          media,
          fields: "id,name",
          supportsAllDrives: false,
          uploadType: "resumable",
          ...(spaces ? { spaces } : {})
        });

        const fileId = response.data.id;
        const fileName = response.data.name;

        if (!fileId || !fileName) {
          throw new Error("Drive upload succeeded but response did not include file id/name");
        }

        return {
          fileId,
          fileName
        };
      },
      {
        retries: this.config.retryAttempts,
        baseDelayMs: this.config.retryBaseDelayMs,
        maxDelayMs: this.config.retryMaxDelayMs,
        shouldRetry: (error) => isRetryableDriveError(error)
      },
      (attempt, error, nextDelayMs) => {
        logger.warn(
          {
            attempt,
            nextDelayMs,
            errorMessage: error instanceof Error ? error.message : String(error)
          },
          "Retrying Drive upload"
        );
      }
    );
  }

  private readTokenFile(tokenFile: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(tokenFile)) {
        return {};
      }
      const raw = fs.readFileSync(tokenFile, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed;
    } catch {
      return {};
    }
  }
}

function isRetryableDriveError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const asAny = error as unknown as Record<string, unknown>;
  const code = asAny.code;
  if (typeof code === "number") {
    return [408, 429, 500, 502, 503, 504].includes(code);
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("temporar") ||
    message.includes("rate limit")
  );
}
