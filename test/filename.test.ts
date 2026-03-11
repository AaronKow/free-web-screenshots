import { describe, expect, it } from "vitest";
import { buildScreenshotFilename } from "../src/utils/filename";

describe("buildScreenshotFilename", () => {
  it("generates sanitized UTC timestamped file name", () => {
    const date = new Date("2026-03-10T12:34:56.000Z");
    const name = buildScreenshotFilename("https://example.com/some/path?x=1", date);
    expect(name).toBe("example.com__some-path__20260310T123456Z.avif");
  });

  it("falls back to root for empty path", () => {
    const date = new Date("2026-03-10T00:00:00.000Z");
    const name = buildScreenshotFilename("https://example.com", date);
    expect(name).toContain("__root__");
  });

  it("throws for invalid url", () => {
    expect(() => buildScreenshotFilename("not-a-url")).toThrow(/Invalid URL/);
  });
});
