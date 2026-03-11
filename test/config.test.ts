import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { parseRuntimeSettingsInput } from "../src/runtime/settings";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token"
  };
}

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig(baseEnv());
    expect(config.port).toBe(8080);
    expect(config.oauthSetupPath).toBe("/oauth/start");
    expect(config.googleRedirectUri).toBe("http://localhost:8080/callback");
  });

  it("allows no refresh token when oauth setup enabled", () => {
    const config = loadConfig({
      ...baseEnv(),
      GOOGLE_REFRESH_TOKEN: "",
      OAUTH_SETUP_ENABLED: "true",
      APP_BASE_URL: "https://screenshots.example.com",
      OAUTH_STATE_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      GOOGLE_TOKEN_FILE: "/tmp/google-token.json"
    });

    expect(config.googleRefreshToken).toBeUndefined();
    expect(config.oauthSetupEnabled).toBe(true);
    expect(config.googleRedirectUri).toBe("https://screenshots.example.com/callback");
  });

  it("requires app user and pass together", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        APP_USER: "admin"
      })
    ).toThrow(/APP_USER and APP_PASS/);
  });

  it("derives callback from app base url", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        GOOGLE_REFRESH_TOKEN: "",
        OAUTH_SETUP_ENABLED: "true",
        APP_BASE_URL: "https://screenshots.example.com:8443",
        OAUTH_STATE_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
        GOOGLE_TOKEN_FILE: "/tmp/google-token.json"
      })
    ).not.toThrow();

    const config = loadConfig({
      ...baseEnv(),
      GOOGLE_REFRESH_TOKEN: "",
      OAUTH_SETUP_ENABLED: "true",
      APP_BASE_URL: "https://screenshots.example.com:8443",
      OAUTH_STATE_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
      GOOGLE_TOKEN_FILE: "/tmp/google-token.json"
    });
    expect(config.googleRedirectUri).toBe("https://screenshots.example.com:8443/callback");
  });
});

describe("parseRuntimeSettingsInput", () => {
  it("accepts valid settings", () => {
    const parsed = parseRuntimeSettingsInput({
      targetUrls: "https://example.com,https://example.org",
      preScreenshotScript: "",
      cronSchedule: "0 * * * *",
      screenshotDir: "/data/screenshots",
      captureMode: "screenshot",
      screenshotFullPage: "false",
      videoDurationSec: "15",
      videoWidth: "960",
      videoHeight: "540",
      viewportWidth: "1366",
      viewportHeight: "768",
      pageTimeoutMs: "30000",
      extraWaitMs: "0",
      deleteLocalAfterUpload: "true",
      retryAttempts: "3",
      retryBaseDelayMs: "1000",
      retryMaxDelayMs: "10000",
      googleDriveMode: "appdata",
      googleDriveFolderId: ""
    });

    expect(parsed.errors).toHaveLength(0);
    expect(parsed.value?.targetUrls).toHaveLength(2);
  });

  it("rejects visible-folder without folder id", () => {
    const parsed = parseRuntimeSettingsInput({
      targetUrls: "https://example.com",
      preScreenshotScript: "",
      cronSchedule: "0 * * * *",
      screenshotDir: "/data/screenshots",
      captureMode: "screenshot",
      screenshotFullPage: "false",
      videoDurationSec: "15",
      videoWidth: "960",
      videoHeight: "540",
      viewportWidth: "1366",
      viewportHeight: "768",
      pageTimeoutMs: "30000",
      extraWaitMs: "0",
      deleteLocalAfterUpload: "true",
      retryAttempts: "3",
      retryBaseDelayMs: "1000",
      retryMaxDelayMs: "10000",
      googleDriveMode: "visible-folder",
      googleDriveFolderId: ""
    });

    expect(parsed.value).toBeUndefined();
    expect(parsed.errors.join(" ")).toMatch(/GOOGLE_DRIVE_FOLDER_ID/);
  });

  it("accepts video capture mode", () => {
    const parsed = parseRuntimeSettingsInput({
      targetUrls: "https://example.com",
      preScreenshotScript: "",
      cronSchedule: "*/15 * * * *",
      screenshotDir: "/data/screenshots",
      captureMode: "video",
      screenshotFullPage: "false",
      videoDurationSec: "15",
      videoWidth: "960",
      videoHeight: "540",
      viewportWidth: "1366",
      viewportHeight: "768",
      pageTimeoutMs: "30000",
      extraWaitMs: "0",
      deleteLocalAfterUpload: "true",
      retryAttempts: "3",
      retryBaseDelayMs: "1000",
      retryMaxDelayMs: "10000",
      googleDriveMode: "appdata",
      googleDriveFolderId: ""
    });

    expect(parsed.errors).toHaveLength(0);
    expect(parsed.value?.captureMode).toBe("video");
    expect(parsed.value?.videoDurationSec).toBe(15);
  });
});
