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
  captures: CaptureArtifact[];
  screenshotPath?: string;
  uploadedFileId?: string;
  uploadedFileName?: string;
  error?: string;
}

interface CaptureArtifact {
  stepName: string;
  screenshotPath: string;
  uploadedFileId: string;
  uploadedFileName: string;
}

interface ScriptCaptureStep {
  name?: string;
  actionScript?: string;
  waitMs?: number;
  fullPage?: boolean;
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
    const browser = await chromium.launch({
      headless: true,
      // Helps WebGL-dependent pages work reliably in headless/container contexts.
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    });
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
              captureCount: result.captures.length,
              captures: result.captures
            },
            "Screenshot(s) captured and uploaded"
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
    try {
      let captures: CaptureArtifact[] = [];

      await withRetry(
        async () => {
          const page = await context.newPage();
          try {
            await page.goto(url, {
              timeout: this.config.pageTimeoutMs,
              waitUntil: "domcontentloaded"
            });

            await this.waitForStability(page);

            const steps = await this.runPreScreenshotScript(page, url);
            captures = await this.captureStepsForPage(page, url, steps);
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

      return {
        url,
        success: true,
        captures,
        screenshotPath: captures[0]?.screenshotPath,
        uploadedFileId: captures[0]?.uploadedFileId,
        uploadedFileName: captures[0]?.uploadedFileName
      };
    } catch (error) {
      return {
        url,
        success: false,
        captures: [],
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

  private async runPreScreenshotScript(page: Page, url: string): Promise<ScriptCaptureStep[]> {
    const script = this.config.preScreenshotScript.trim();
    if (!script) return [];

    try {
      const output = await page.evaluate(
        async (payload: { source: string; context: { url: string } }) => {
          const run = new Function("context", payload.source);
          return await Promise.resolve(run(payload.context));
        },
        {
          source: script,
          context: { url }
        }
      );
      if (!Array.isArray(output)) {
        return [];
      }

      return output.map((step, index) => normalizeScriptStep(step, index));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PRE_SCREENSHOT_SCRIPT failed for ${url}: ${message}`);
    }
  }

  private async captureStepsForPage(page: Page, url: string, scriptSteps: ScriptCaptureStep[]): Promise<CaptureArtifact[]> {
    const steps = scriptSteps.length > 0 ? scriptSteps : [{ name: "default" }];
    const captured: CaptureArtifact[] = [];

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];

      if (step.actionScript?.trim()) {
        await this.runStepActionScript(page, url, step, i);
      }

      const waitMs = step.waitMs ?? this.config.extraWaitMs;
      if (waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }

      const filename = this.buildStepFilename(url, step, i);
      const screenshotPath = buildScreenshotPath(this.config.screenshotDir, filename);
      await page.screenshot({
        path: screenshotPath,
        fullPage: step.fullPage ?? this.config.screenshotFullPage,
        type: "png"
      });

      const upload = await this.uploader.uploadFile({
        localPath: screenshotPath,
        fileName: filename,
        mimeType: "image/png"
      });

      if (this.config.deleteLocalAfterUpload) {
        await fs.rm(screenshotPath, { force: true });
      }

      captured.push({
        stepName: step.name || `shot-${i + 1}`,
        screenshotPath,
        uploadedFileId: upload.fileId,
        uploadedFileName: upload.fileName
      });
    }

    return captured;
  }

  private async runStepActionScript(page: Page, url: string, step: ScriptCaptureStep, index: number): Promise<void> {
    const script = step.actionScript?.trim();
    if (!script) return;

    try {
      await page.evaluate(
        async (payload: { source: string; context: { url: string; stepIndex: number; stepName: string } }) => {
          const run = new Function("context", payload.source);
          await Promise.resolve(run(payload.context));
        },
        {
          source: script,
          context: {
            url,
            stepIndex: index,
            stepName: step.name || `shot-${index + 1}`
          }
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`PRE_SCREENSHOT_SCRIPT step ${index + 1} actionScript failed for ${url}: ${message}`);
    }
  }

  private buildStepFilename(url: string, step: ScriptCaptureStep, index: number): string {
    const base = buildScreenshotFilename(url, new Date()).replace(/\.png$/i, "");
    const safeName = sanitizeFileToken(step.name || `shot-${index + 1}`);
    return `${base}__${safeName}.png`;
  }
}

function normalizeScriptStep(raw: unknown, index: number): ScriptCaptureStep {
  if (raw == null || typeof raw !== "object") {
    throw new Error(`PRE_SCREENSHOT_SCRIPT step ${index + 1} must be an object`);
  }

  const step = raw as Record<string, unknown>;
  const name =
    typeof step.name === "string" && step.name.trim().length > 0 ? step.name.trim().slice(0, 60) : `shot-${index + 1}`;

  const actionScript =
    typeof step.actionScript === "string" && step.actionScript.trim().length > 0 ? step.actionScript : undefined;

  const waitMs = normalizeWait(step.waitMs, index);
  const fullPage = typeof step.fullPage === "boolean" ? step.fullPage : undefined;

  return {
    name,
    actionScript,
    waitMs,
    fullPage
  };
}

function normalizeWait(raw: unknown, index: number): number | undefined {
  if (raw == null) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`PRE_SCREENSHOT_SCRIPT step ${index + 1} waitMs must be a non-negative number`);
  }
  if (value > 120000) {
    throw new Error(`PRE_SCREENSHOT_SCRIPT step ${index + 1} waitMs cannot exceed 120000`);
  }
  return Math.floor(value);
}

function sanitizeFileToken(value: string): string {
  return (
    value
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_.]+|[-_.]+$/g, "")
      .toLowerCase() || "shot"
  );
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
