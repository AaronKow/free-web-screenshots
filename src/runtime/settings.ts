import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";

export type GoogleDriveMode = "appdata" | "visible-folder";

export interface RuntimeSettings {
  targetUrls: string[];
  cronSchedule: string;
  screenshotDir: string;
  screenshotFullPage: boolean;
  viewportWidth: number;
  viewportHeight: number;
  pageTimeoutMs: number;
  extraWaitMs: number;
  deleteLocalAfterUpload: boolean;
  retryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  googleDriveMode: GoogleDriveMode;
  googleDriveFolderId?: string;
}

export interface RuntimeSettingsInput {
  targetUrls: string;
  cronSchedule: string;
  screenshotDir: string;
  screenshotFullPage: string;
  viewportWidth: string;
  viewportHeight: string;
  pageTimeoutMs: string;
  extraWaitMs: string;
  deleteLocalAfterUpload: string;
  retryAttempts: string;
  retryBaseDelayMs: string;
  retryMaxDelayMs: string;
  googleDriveMode: string;
  googleDriveFolderId: string;
}

function parseBoolean(raw: string, key: string, errors: string[]): boolean {
  const normalized = (raw || "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  errors.push(`${key} must be a boolean`);
  return false;
}

function parseIntField(raw: string, key: string, min: number, errors: string[]): number {
  const parsed = Number.parseInt((raw || "").trim(), 10);
  if (Number.isNaN(parsed)) {
    errors.push(`${key} must be an integer`);
    return min;
  }
  if (parsed < min) {
    errors.push(`${key} must be >= ${min}`);
  }
  return parsed;
}

function parseUrls(raw: string, errors: string[]): string[] {
  const urls = (raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    errors.push("TARGET_URLS must include at least one URL");
    return [];
  }

  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith("http")) {
        errors.push(`Unsupported URL protocol: ${url}`);
      }
    } catch {
      errors.push(`Invalid URL: ${url}`);
    }
  }

  return urls;
}

export function buildDefaultRuntimeSettings(): RuntimeSettings {
  return {
    targetUrls: [],
    cronSchedule: "0 * * * *",
    screenshotDir: "/data/screenshots",
    screenshotFullPage: false,
    viewportWidth: 1366,
    viewportHeight: 768,
    pageTimeoutMs: 30000,
    extraWaitMs: 0,
    deleteLocalAfterUpload: true,
    retryAttempts: 3,
    retryBaseDelayMs: 1000,
    retryMaxDelayMs: 10000,
    googleDriveMode: "appdata",
    googleDriveFolderId: ""
  };
}

export function runtimeSettingsToInput(settings: RuntimeSettings): RuntimeSettingsInput {
  return {
    targetUrls: settings.targetUrls.join(","),
    cronSchedule: settings.cronSchedule,
    screenshotDir: settings.screenshotDir,
    screenshotFullPage: String(settings.screenshotFullPage),
    viewportWidth: String(settings.viewportWidth),
    viewportHeight: String(settings.viewportHeight),
    pageTimeoutMs: String(settings.pageTimeoutMs),
    extraWaitMs: String(settings.extraWaitMs),
    deleteLocalAfterUpload: String(settings.deleteLocalAfterUpload),
    retryAttempts: String(settings.retryAttempts),
    retryBaseDelayMs: String(settings.retryBaseDelayMs),
    retryMaxDelayMs: String(settings.retryMaxDelayMs),
    googleDriveMode: settings.googleDriveMode,
    googleDriveFolderId: settings.googleDriveFolderId || ""
  };
}

export function parseRuntimeSettingsInput(input: RuntimeSettingsInput): { value?: RuntimeSettings; errors: string[] } {
  const errors: string[] = [];

  const targetUrls = parseUrls(input.targetUrls, errors);
  const cronSchedule = (input.cronSchedule || "").trim();
  if (!cron.validate(cronSchedule)) {
    errors.push("CRON_SCHEDULE is invalid");
  }

  const screenshotDir = path.resolve((input.screenshotDir || "").trim() || "/data/screenshots");
  const screenshotFullPage = parseBoolean(input.screenshotFullPage, "SCREENSHOT_FULL_PAGE", errors);
  const viewportWidth = parseIntField(input.viewportWidth, "VIEWPORT_WIDTH", 1, errors);
  const viewportHeight = parseIntField(input.viewportHeight, "VIEWPORT_HEIGHT", 1, errors);
  const pageTimeoutMs = parseIntField(input.pageTimeoutMs, "PAGE_TIMEOUT_MS", 1000, errors);
  const extraWaitMs = parseIntField(input.extraWaitMs, "EXTRA_WAIT_MS", 0, errors);
  const deleteLocalAfterUpload = parseBoolean(input.deleteLocalAfterUpload, "DELETE_LOCAL_AFTER_UPLOAD", errors);
  const retryAttempts = parseIntField(input.retryAttempts, "RETRY_ATTEMPTS", 0, errors);
  const retryBaseDelayMs = parseIntField(input.retryBaseDelayMs, "RETRY_BASE_DELAY_MS", 1, errors);
  const retryMaxDelayMs = parseIntField(input.retryMaxDelayMs, "RETRY_MAX_DELAY_MS", 1, errors);

  const googleDriveMode = (input.googleDriveMode || "").trim() as GoogleDriveMode;
  if (!["appdata", "visible-folder"].includes(googleDriveMode)) {
    errors.push("GOOGLE_DRIVE_MODE must be appdata or visible-folder");
  }

  const googleDriveFolderId = (input.googleDriveFolderId || "").trim();
  if (googleDriveMode === "visible-folder" && !googleDriveFolderId) {
    errors.push("GOOGLE_DRIVE_FOLDER_ID is required for visible-folder mode");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors,
    value: {
      targetUrls,
      cronSchedule,
      screenshotDir,
      screenshotFullPage,
      viewportWidth,
      viewportHeight,
      pageTimeoutMs,
      extraWaitMs,
      deleteLocalAfterUpload,
      retryAttempts,
      retryBaseDelayMs,
      retryMaxDelayMs,
      googleDriveMode,
      googleDriveFolderId
    }
  };
}

export function loadRuntimeSettings(filePath: string): RuntimeSettings | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as RuntimeSettings;
    const normalized = runtimeSettingsToInput(parsed);
    const checked = parseRuntimeSettingsInput(normalized);
    return checked.value;
  } catch {
    return undefined;
  }
}

export function saveRuntimeSettings(filePath: string, envFilePath: string, settings: RuntimeSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  const dotenv = [
    `TARGET_URLS=${settings.targetUrls.join(",")}`,
    `CRON_SCHEDULE=${settings.cronSchedule}`,
    `SCREENSHOT_DIR=${settings.screenshotDir}`,
    `SCREENSHOT_FULL_PAGE=${settings.screenshotFullPage}`,
    `VIEWPORT_WIDTH=${settings.viewportWidth}`,
    `VIEWPORT_HEIGHT=${settings.viewportHeight}`,
    `PAGE_TIMEOUT_MS=${settings.pageTimeoutMs}`,
    `EXTRA_WAIT_MS=${settings.extraWaitMs}`,
    `DELETE_LOCAL_AFTER_UPLOAD=${settings.deleteLocalAfterUpload}`,
    `RETRY_ATTEMPTS=${settings.retryAttempts}`,
    `RETRY_BASE_DELAY_MS=${settings.retryBaseDelayMs}`,
    `RETRY_MAX_DELAY_MS=${settings.retryMaxDelayMs}`,
    `GOOGLE_DRIVE_MODE=${settings.googleDriveMode}`,
    `GOOGLE_DRIVE_FOLDER_ID=${settings.googleDriveFolderId || ""}`
  ].join("\n");

  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  fs.writeFileSync(envFilePath, `${dotenv}\n`, { mode: 0o600 });
}

export function buildRuntimeSettingsFromEnv(env: NodeJS.ProcessEnv): RuntimeSettings {
  const defaults = buildDefaultRuntimeSettings();
  return {
    targetUrls: (env.TARGET_URLS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    cronSchedule: env.CRON_SCHEDULE?.trim() || defaults.cronSchedule,
    screenshotDir: path.resolve(env.SCREENSHOT_DIR?.trim() || defaults.screenshotDir),
    screenshotFullPage: ["1", "true", "yes", "y", "on"].includes((env.SCREENSHOT_FULL_PAGE || "").toLowerCase()),
    viewportWidth: Number.parseInt(env.VIEWPORT_WIDTH || `${defaults.viewportWidth}`, 10),
    viewportHeight: Number.parseInt(env.VIEWPORT_HEIGHT || `${defaults.viewportHeight}`, 10),
    pageTimeoutMs: Number.parseInt(env.PAGE_TIMEOUT_MS || `${defaults.pageTimeoutMs}`, 10),
    extraWaitMs: Number.parseInt(env.EXTRA_WAIT_MS || `${defaults.extraWaitMs}`, 10),
    deleteLocalAfterUpload: !["0", "false", "no", "n", "off"].includes(
      (env.DELETE_LOCAL_AFTER_UPLOAD || "true").toLowerCase()
    ),
    retryAttempts: Number.parseInt(env.RETRY_ATTEMPTS || `${defaults.retryAttempts}`, 10),
    retryBaseDelayMs: Number.parseInt(env.RETRY_BASE_DELAY_MS || `${defaults.retryBaseDelayMs}`, 10),
    retryMaxDelayMs: Number.parseInt(env.RETRY_MAX_DELAY_MS || `${defaults.retryMaxDelayMs}`, 10),
    googleDriveMode: (env.GOOGLE_DRIVE_MODE?.trim() as GoogleDriveMode) || defaults.googleDriveMode,
    googleDriveFolderId: env.GOOGLE_DRIVE_FOLDER_ID?.trim() || ""
  };
}
