import fs from "node:fs/promises";
import { BrowserContext, Page, chromium } from "playwright";
import type { RunConfig } from "../config";
import { logger } from "../logger";
import type { StorageUploader } from "../storage/types";
import { buildScreenshotFilename, buildScreenshotPath } from "../utils/filename";
import { withRetry } from "../utils/retry";

export interface UrlRunResult {
  url: string;
  success: boolean;
  screenshotPath?: string;
  uploadedFileId?: string;
  uploadedFileName?: string;
  error?: string;
}

export interface CaptureRunSummary {
  startedAt: string;
  finishedAt: string;
  results: UrlRunResult[];
}

export class ScreenshotService {
  constructor(
    private readonly config: RunConfig,
    private readonly uploader: StorageUploader
  ) {}

  async runOnce(): Promise<CaptureRunSummary> {
    await fs.mkdir(this.config.screenshotDir, { recursive: true });

    const start = new Date();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: {
        width: this.config.viewportWidth,
        height: this.config.viewportHeight
      }
    });

    const results: UrlRunResult[] = [];

    try {
      for (const url of this.config.targetUrls) {
        const result = await this.processUrl(context, url);
        results.push(result);

        if (result.success) {
          logger.info(
            {
              url,
              screenshotPath: result.screenshotPath,
              uploadedFileId: result.uploadedFileId,
              uploadedFileName: result.uploadedFileName
            },
            "Screenshot captured and uploaded"
          );
        } else {
          logger.error({ url, error: result.error }, "Screenshot run failed for URL");
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }

    return {
      startedAt: start.toISOString(),
      finishedAt: new Date().toISOString(),
      results
    };
  }

  private async processUrl(context: BrowserContext, url: string): Promise<UrlRunResult> {
    const filename = buildScreenshotFilename(url, new Date());
    const screenshotPath = buildScreenshotPath(this.config.screenshotDir, filename);

    try {
      await withRetry(
        async () => {
          const page = await context.newPage();
          try {
            await page.goto(url, {
              timeout: this.config.pageTimeoutMs,
              waitUntil: "domcontentloaded"
            });

            await this.waitForStability(page);

            if (this.config.extraWaitMs > 0) {
              await page.waitForTimeout(this.config.extraWaitMs);
            }

            await page.screenshot({
              path: screenshotPath,
              fullPage: this.config.screenshotFullPage,
              type: "png"
            });
          } finally {
            await page.close();
          }
        },
        {
          retries: this.config.retryAttempts,
          baseDelayMs: this.config.retryBaseDelayMs,
          maxDelayMs: this.config.retryMaxDelayMs,
          shouldRetry: (error) => isRetryablePageError(error)
        },
        (attempt, error, nextDelayMs) => {
          logger.warn(
            {
              url,
              attempt,
              nextDelayMs,
              errorMessage: error instanceof Error ? error.message : String(error)
            },
            "Retrying screenshot capture"
          );
        }
      );

      const upload = await this.uploader.uploadFile({
        localPath: screenshotPath,
        fileName: filename,
        mimeType: "image/png"
      });

      if (this.config.deleteLocalAfterUpload) {
        await fs.rm(screenshotPath, { force: true });
      }

      return {
        url,
        success: true,
        screenshotPath,
        uploadedFileId: upload.fileId,
        uploadedFileName: upload.fileName
      };
    } catch (error) {
      return {
        url,
        success: false,
        screenshotPath,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async waitForStability(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("networkidle", { timeout: this.config.pageTimeoutMs });
    } catch {
      logger.warn("Timed out waiting for network idle; proceeding with screenshot");
    }
  }
}

function isRetryablePageError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("navigation") ||
    message.includes("timeout") ||
    message.includes("net::") ||
    message.includes("temporar") ||
    message.includes("connection")
  );
}
