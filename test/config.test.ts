import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    TARGET_URLS: "https://example.com",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "http://localhost/oauth2callback",
    GOOGLE_REFRESH_TOKEN: "refresh-token"
  };
}

describe("loadConfig", () => {
  it("loads defaults", () => {
    const config = loadConfig(baseEnv());
    expect(config.googleDriveMode).toBe("appdata");
    expect(config.cronSchedule).toBe("0 * * * *");
    expect(config.deleteLocalAfterUpload).toBe(true);
    expect(config.targetUrls).toEqual(["https://example.com"]);
  });

  it("requires folder id in visible-folder mode", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        GOOGLE_DRIVE_MODE: "visible-folder"
      })
    ).toThrow(/GOOGLE_DRIVE_FOLDER_ID is required/);
  });

  it("rejects invalid cron", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        CRON_SCHEDULE: "not-a-cron"
      })
    ).toThrow(/CRON_SCHEDULE is invalid/);
  });

  it("rejects invalid target urls", () => {
    expect(() =>
      loadConfig({
        ...baseEnv(),
        TARGET_URLS: "ftp://example.com"
      })
    ).toThrow(/unsupported protocol/);
  });
});
