import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { auth } from "googleapis/build/src/apis/drive";
import type { AppConfig } from "../config";
import { logger } from "../logger";
import type { GoogleDriveMode } from "../runtime/settings";

const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const VISIBLE_FOLDER_SCOPE = "https://www.googleapis.com/auth/drive.file";

interface StatePayload {
  exp: number;
  nonce: string;
}

function writeHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(html);
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function signPayload(payloadB64: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function buildState(secret: string): string {
  const payload: StatePayload = {
    exp: Date.now() + 10 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString("hex")
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = signPayload(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

function verifyState(state: string, secret: string): boolean {
  const [payloadB64, signature] = state.split(".");
  if (!payloadB64 || !signature) {
    return false;
  }

  const expected = signPayload(payloadB64, secret);
  if (!constantTimeEqual(expected, signature)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as StatePayload;
    return typeof parsed.exp === "number" && parsed.exp >= Date.now();
  } catch {
    return false;
  }
}

function getScope(mode: GoogleDriveMode): string {
  return mode === "appdata" ? APP_DATA_SCOPE : VISIBLE_FOLDER_SCOPE;
}

function resolvePublicBaseUrl(req: IncomingMessage, fallbackBaseUrl?: string): string {
  const forwardedProto = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim().toLowerCase();
  const forwardedHost = (req.headers["x-forwarded-host"] || "").toString().split(",")[0].trim();
  const host = forwardedHost || (req.headers.host || "").toString().trim();
  const encrypted = (req.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted;
  const scheme = forwardedProto || (encrypted ? "https" : "http");

  if (host) {
    return `${scheme}://${host}`;
  }

  if (fallbackBaseUrl) {
    return fallbackBaseUrl;
  }

  return "http://localhost:8080";
}

export class OAuthSetupHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly getDriveMode: () => GoogleDriveMode,
    private readonly onRefreshToken: (refreshToken: string) => Promise<void>
  ) {}

  createAuthorizationUrl(req: IncomingMessage): string {
    const redirectUri = new URL(this.config.oauthCallbackPath, resolvePublicBaseUrl(req, this.config.appBaseUrl)).toString();
    const oauth2 = new auth.OAuth2(
      this.config.googleClientId,
      this.config.googleClientSecret,
      redirectUri
    );

    const state = buildState(this.config.oauthStateSecret || "");
    return oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [getScope(this.getDriveMode())],
      state
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!this.config.oauthSetupEnabled) {
      return false;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method !== "GET" || url.pathname !== this.config.oauthCallbackPath) {
      return false;
    }

    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    const oauthError = url.searchParams.get("error") || "";

    if (oauthError) {
      writeHtml(res, 400, `<h1>OAuth Error</h1><p>${escapeHtml(oauthError)}</p>`);
      return true;
    }

    if (!code || !state) {
      writeHtml(res, 400, "<h1>Invalid callback</h1><p>Missing code/state.</p>");
      return true;
    }

    if (!verifyState(state, this.config.oauthStateSecret || "")) {
      writeHtml(res, 400, "<h1>Invalid state</h1><p>OAuth state verification failed.</p>");
      return true;
    }

    try {
      const redirectUri = new URL(this.config.oauthCallbackPath, resolvePublicBaseUrl(req, this.config.appBaseUrl)).toString();
      const oauth2 = new auth.OAuth2(
        this.config.googleClientId,
        this.config.googleClientSecret,
        redirectUri
      );

      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        writeHtml(
          res,
          400,
          "<h1>Missing refresh token</h1><p>Revoke existing consent and retry setup.</p>"
        );
        return true;
      }

      if (!this.config.googleTokenFile) {
        throw new Error("GOOGLE_TOKEN_FILE is not configured");
      }

      fs.mkdirSync(path.dirname(this.config.googleTokenFile), { recursive: true });
      fs.writeFileSync(
        this.config.googleTokenFile,
        JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2),
        { mode: 0o600 }
      );

      await this.onRefreshToken(tokens.refresh_token);

      writeHtml(
        res,
        200,
        "<h1>Setup complete</h1><p>Refresh token stored securely. Return to <a href='/'>dashboard</a>.</p>"
      );
      return true;
    } catch (error) {
      logger.error({ err: error }, "OAuth callback handling failed");
      writeJson(res, 500, { status: "error", message: "OAuth callback failed" });
      return true;
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
