import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleRefreshToken?: string;
  googleTokenFile?: string;
  oauthSetupEnabled: boolean;
  appBaseUrl?: string;
  oauthStateSecret?: string;
  oauthSetupPath: string;
  oauthCallbackPath: string;
  appUser?: string;
  appPass?: string;
  appRuntimeConfigFile: string;
  appRuntimeEnvFile: string;
  logLevel: string;
  port: number;
}

export interface RunConfig {
  targetUrls: string[];
  cronSchedule: string;
  screenshotDir: string;
  preScreenshotScript: string;
  screenshotFullPage: boolean;
  viewportWidth: number;
  viewportHeight: number;
  pageTimeoutMs: number;
  extraWaitMs: number;
  deleteLocalAfterUpload: boolean;
  retryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  googleDriveMode: "appdata" | "visible-folder";
  googleDriveFolderId?: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googleRefreshToken: string;
  googleTokenFile?: string;
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

function normalizePathInput(raw: string | undefined, fallback: string): string {
  const value = (raw?.trim() || fallback).trim();
  if (!value.startsWith("/")) {
    throw new Error(`Path must begin with '/': ${value}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];

  const credentialsFromFile = maybeLoadCredentialFile(env);
  const tokenFromFile = maybeLoadTokenFile(env);

  const googleClientId =
    env.GOOGLE_CLIENT_ID?.trim() || credentialsFromFile.client_id || required(undefined, "GOOGLE_CLIENT_ID", errors);
  const googleClientSecret =
    env.GOOGLE_CLIENT_SECRET?.trim() ||
    credentialsFromFile.client_secret ||
    required(undefined, "GOOGLE_CLIENT_SECRET", errors);
  const googleRedirectUriFromEnv = env.GOOGLE_REDIRECT_URI?.trim();

  const googleRefreshToken = env.GOOGLE_REFRESH_TOKEN?.trim() || tokenFromFile.refreshToken;

  let oauthSetupEnabled = false;
  try {
    oauthSetupEnabled = parseBoolean(env.OAUTH_SETUP_ENABLED, false);
  } catch (error) {
    errors.push((error as Error).message);
  }

  let oauthSetupPath = "/oauth/start";
  let oauthCallbackPath = "/callback";
  let port = 8080;

  try {
    oauthSetupPath = normalizePathInput(env.OAUTH_SETUP_PATH, "/oauth/start");
    oauthCallbackPath = normalizePathInput(env.OAUTH_CALLBACK_PATH, "/callback");
    port = parseInteger(env.PORT, 8080, "PORT", 1);
  } catch (error) {
    errors.push((error as Error).message);
  }

  const appBaseUrl = env.APP_BASE_URL?.trim();
  const oauthStateSecret = env.OAUTH_STATE_SECRET?.trim();
  let googleRedirectUri = googleRedirectUriFromEnv || credentialsFromFile.redirect_uri || "";

  if (oauthSetupEnabled) {
    if (!tokenFromFile.tokenFile) {
      errors.push("GOOGLE_TOKEN_FILE is required when OAUTH_SETUP_ENABLED=true");
    }

    if (!appBaseUrl) {
      errors.push("APP_BASE_URL is required when OAUTH_SETUP_ENABLED=true");
    }

    if (!oauthStateSecret || oauthStateSecret.length < 32) {
      errors.push("OAUTH_STATE_SECRET is required and must be at least 32 chars when OAUTH_SETUP_ENABLED=true");
    }

    if (appBaseUrl) {
      try {
        const parsedBase = new URL(appBaseUrl);
        if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "localhost") {
          errors.push("APP_BASE_URL must use https in non-local environments");
        }

        const expectedRedirect = new URL(oauthCallbackPath, parsedBase).toString();
        // In hosted setup mode, callback should follow deployment URL.
        // We still fail fast if user explicitly sets a conflicting redirect URI.
        if (googleRedirectUriFromEnv && googleRedirectUriFromEnv !== expectedRedirect) {
          errors.push(`GOOGLE_REDIRECT_URI must equal ${expectedRedirect} when OAUTH_SETUP_ENABLED=true`);
        }
        googleRedirectUri = expectedRedirect;
      } catch {
        errors.push("APP_BASE_URL must be a valid URL");
      }
    }
  }

  if (!googleRedirectUri) {
    errors.push("GOOGLE_REDIRECT_URI is required");
  }

  const appUser = env.APP_USER?.trim();
  const appPass = env.APP_PASS?.trim();
  if ((appUser && !appPass) || (!appUser && appPass)) {
    errors.push("APP_USER and APP_PASS must be set together");
  }

  const appRuntimeConfigFile = path.resolve(env.APP_RUNTIME_CONFIG_FILE?.trim() || "/data/runtime-config.json");
  const appRuntimeEnvFile = path.resolve(env.APP_RUNTIME_ENV_FILE?.trim() || "/data/runtime.env");

  if (!oauthSetupEnabled && !googleRefreshToken) {
    errors.push("GOOGLE_REFRESH_TOKEN is required unless OAUTH_SETUP_ENABLED=true with GOOGLE_TOKEN_FILE");
  }

  if (errors.length > 0) {
    throw new Error(`Configuration error(s):\n- ${errors.join("\n- ")}`);
  }

  return {
    googleClientId,
    googleClientSecret,
    googleRedirectUri,
    googleRefreshToken,
    googleTokenFile: tokenFromFile.tokenFile,
    oauthSetupEnabled,
    appBaseUrl,
    oauthStateSecret,
    oauthSetupPath,
    oauthCallbackPath,
    appUser,
    appPass,
    appRuntimeConfigFile,
    appRuntimeEnvFile,
    logLevel: env.LOG_LEVEL?.trim() || "info",
    port
  };
}
