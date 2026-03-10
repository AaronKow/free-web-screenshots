import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";

export type GoogleDriveMode = "appdata" | "visible-folder";

export interface AppConfig {
  targetUrls: string[];
  cronSchedule: string;
  screenshotDir: string;
  screenshotFullPage: boolean;
  viewportWidth: number;
  viewportHeight: number;
  pageTimeoutMs: number;
  extraWaitMs: number;
  deleteLocalAfterUpload: boolean;
  googleDriveMode: GoogleDriveMode;
  googleDriveFolderId?: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleRefreshToken: string;
  googleTokenFile?: string;
  logLevel: string;
  port: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

interface CredentialFileShape {
  client_id?: string;
  client_secret?: string;
  redirect_uri?: string;
  installed?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
  web?: {
    client_id?: string;
    client_secret?: string;
    redirect_uris?: string[];
  };
}

interface TokenFileShape {
  refresh_token?: string;
}

function required(value: string | undefined, key: string, errors: string[]): string {
  if (!value || value.trim() === "") {
    errors.push(`${key} is required`);
    return "";
  }
  return value.trim();
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseInteger(value: string | undefined, fallback: number, key: string, min?: number): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  if (min != null && parsed < min) {
    throw new Error(`${key} must be >= ${min}`);
  }
  return parsed;
}

function parseUrls(raw: string | undefined, errors: string[]): string[] {
  if (!raw || raw.trim() === "") {
    errors.push("TARGET_URLS is required");
    return [];
  }

  const urls = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    errors.push("TARGET_URLS must contain at least one URL");
    return [];
  }

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        errors.push(`TARGET_URLS contains unsupported protocol for URL: ${url}`);
      }
    } catch {
      errors.push(`TARGET_URLS contains invalid URL: ${url}`);
    }
  }

  return urls;
}

function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

function maybeLoadCredentialFile(env: NodeJS.ProcessEnv): Partial<CredentialFileShape> {
  const file = env.GOOGLE_CREDENTIALS_FILE?.trim();
  if (!file) {
    return {};
  }
  const resolved = path.resolve(file);
  const parsed = readJsonFile<CredentialFileShape>(resolved);
  const installed = parsed.installed;
  const web = parsed.web;
  return {
    client_id: parsed.client_id || installed?.client_id || web?.client_id,
    client_secret: parsed.client_secret || installed?.client_secret || web?.client_secret,
    redirect_uri: parsed.redirect_uri || installed?.redirect_uris?.[0] || web?.redirect_uris?.[0]
  };
}

function maybeLoadTokenFile(env: NodeJS.ProcessEnv): { refreshToken?: string; tokenFile?: string } {
  const file = env.GOOGLE_TOKEN_FILE?.trim();
  if (!file) {
    return {};
  }

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    return { tokenFile: resolved };
  }

  const parsed = readJsonFile<TokenFileShape>(resolved);
  return {
    refreshToken: parsed.refresh_token,
    tokenFile: resolved
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];

  const credentialsFromFile = maybeLoadCredentialFile(env);
  const tokenFromFile = maybeLoadTokenFile(env);

  const targetUrls = parseUrls(env.TARGET_URLS, errors);

  const cronSchedule = env.CRON_SCHEDULE?.trim() || "0 * * * *";
  if (!cron.validate(cronSchedule)) {
    errors.push(`CRON_SCHEDULE is invalid: ${cronSchedule}`);
  }

  const screenshotDir = path.resolve(env.SCREENSHOT_DIR?.trim() || "/tmp/screenshots");

  let screenshotFullPage = false;
  let deleteLocalAfterUpload = true;
  try {
    screenshotFullPage = parseBoolean(env.SCREENSHOT_FULL_PAGE, false);
    deleteLocalAfterUpload = parseBoolean(env.DELETE_LOCAL_AFTER_UPLOAD, true);
  } catch (error) {
    errors.push((error as Error).message);
  }

  let viewportWidth = 1366;
  let viewportHeight = 768;
  let pageTimeoutMs = 30000;
  let extraWaitMs = 0;
  let port = 8080;
  let retryAttempts = 3;
  let retryBaseDelayMs = 1000;
  let retryMaxDelayMs = 10000;

  try {
    viewportWidth = parseInteger(env.VIEWPORT_WIDTH, 1366, "VIEWPORT_WIDTH", 1);
    viewportHeight = parseInteger(env.VIEWPORT_HEIGHT, 768, "VIEWPORT_HEIGHT", 1);
    pageTimeoutMs = parseInteger(env.PAGE_TIMEOUT_MS, 30000, "PAGE_TIMEOUT_MS", 1000);
    extraWaitMs = parseInteger(env.EXTRA_WAIT_MS, 0, "EXTRA_WAIT_MS", 0);
    port = parseInteger(env.PORT, 8080, "PORT", 1);
    retryAttempts = parseInteger(env.RETRY_ATTEMPTS, 3, "RETRY_ATTEMPTS", 0);
    retryBaseDelayMs = parseInteger(env.RETRY_BASE_DELAY_MS, 1000, "RETRY_BASE_DELAY_MS", 1);
    retryMaxDelayMs = parseInteger(env.RETRY_MAX_DELAY_MS, 10000, "RETRY_MAX_DELAY_MS", 1);
  } catch (error) {
    errors.push((error as Error).message);
  }

  const googleDriveMode = (env.GOOGLE_DRIVE_MODE?.trim() || "appdata") as GoogleDriveMode;
  if (!["appdata", "visible-folder"].includes(googleDriveMode)) {
    errors.push("GOOGLE_DRIVE_MODE must be either appdata or visible-folder");
  }

  const googleDriveFolderId = env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  if (googleDriveMode === "visible-folder" && !googleDriveFolderId) {
    errors.push("GOOGLE_DRIVE_FOLDER_ID is required when GOOGLE_DRIVE_MODE=visible-folder");
  }

  const googleClientId =
    env.GOOGLE_CLIENT_ID?.trim() || credentialsFromFile.client_id || required(undefined, "GOOGLE_CLIENT_ID", errors);
  const googleClientSecret =
    env.GOOGLE_CLIENT_SECRET?.trim() ||
    credentialsFromFile.client_secret ||
    required(undefined, "GOOGLE_CLIENT_SECRET", errors);
  const googleRedirectUri =
    env.GOOGLE_REDIRECT_URI?.trim() ||
    credentialsFromFile.redirect_uri ||
    required(undefined, "GOOGLE_REDIRECT_URI", errors);

  const googleRefreshToken =
    env.GOOGLE_REFRESH_TOKEN?.trim() || tokenFromFile.refreshToken || required(undefined, "GOOGLE_REFRESH_TOKEN", errors);

  if (errors.length > 0) {
    throw new Error(`Configuration error(s):\n- ${errors.join("\n- ")}`);
  }

  return {
    targetUrls,
    cronSchedule,
    screenshotDir,
    screenshotFullPage,
    viewportWidth,
    viewportHeight,
    pageTimeoutMs,
    extraWaitMs,
    deleteLocalAfterUpload,
    googleDriveMode,
    googleDriveFolderId,
    googleClientId,
    googleClientSecret,
    googleRedirectUri,
    googleRefreshToken,
    googleTokenFile: tokenFromFile.tokenFile,
    logLevel: env.LOG_LEVEL?.trim() || "info",
    port,
    retryAttempts,
    retryBaseDelayMs,
    retryMaxDelayMs
  };
}
