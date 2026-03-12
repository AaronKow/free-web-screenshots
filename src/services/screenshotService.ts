import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { BrowserContext, Page, chromium } from "playwright";
import sharp from "sharp";
import type { RunConfig } from "../config";
import { logger } from "../logger";
import type { StorageUploader } from "../storage/types";
import { buildScreenshotFilename, buildScreenshotPath, buildVideoFilename, buildVideoPath } from "../utils/filename";
import { withRetry } from "../utils/retry";

export interface UrlRunResult {
  url: string;
  success: boolean;
  captures: CaptureArtifact[];
  screenshotPath?: string;
  videoPath?: string;
  uploadedFileId?: string;
  uploadedFileName?: string;
  error?: string;
}

interface CaptureArtifact {
  stepName: string;
  type: "screenshot" | "video";
  localPath: string;
  mimeType: string;
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

const AVIF_QUALITY = 58;
const AVIF_EFFORT = 4;
const AV1_CRF = 36;
const AV1_PRESET = 8;
const AV1_GOP = 120;

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
      },
      recordVideo: this.shouldCaptureVideo()
        ? {
            dir: this.config.screenshotDir,
            size: {
              width: this.config.videoWidth,
              height: this.config.videoHeight
            }
          }
        : undefined
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
            "Capture artifact(s) captured and uploaded"
          );
        } else {
          logger.error({ url, error: result.error }, "Capture run failed for URL");
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
          const pageVideo = this.shouldCaptureVideo() ? page.video() : null;
          try {
            await page.goto(url, {
              timeout: this.config.pageTimeoutMs,
              waitUntil: "domcontentloaded"
            });

            await this.waitForStability(page);

            const steps = await this.runPreScreenshotScript(page, url);
            const collected: CaptureArtifact[] = [];

            if (this.shouldCaptureVideo()) {
              await this.applyScriptStepsForVideo(page, url, steps);
              const videoCapture = await this.captureVideoForPage(page, url);
              collected.push(videoCapture);
            }

            if (this.shouldCaptureScreenshot()) {
              const screenshotCaptures = await this.captureStepsForPage(page, url, steps);
              collected.push(...screenshotCaptures);
            }

            captures = collected;
          } finally {
            await page.close();
          }

          if (pageVideo && this.shouldCaptureVideo()) {
            const rawVideoPath = await pageVideo.path();
            captures = await this.finalizeCapturedVideo(captures, url, rawVideoPath);
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
        screenshotPath: captures.find((item) => item.type === "screenshot")?.localPath,
        videoPath: captures.find((item) => item.type === "video")?.localPath,
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
          const AsyncFunction = Object.getPrototypeOf(async function () {
            return undefined;
          }).constructor as new (...args: string[]) => (context: { url: string }) => Promise<unknown>;
          const run = new AsyncFunction("context", payload.source);
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
      const screenshotPng = await page.screenshot({
        fullPage: step.fullPage ?? this.config.screenshotFullPage,
        type: "png"
      });
      const screenshotAvif = await sharp(screenshotPng)
        .avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT })
        .toBuffer();
      await fs.writeFile(screenshotPath, screenshotAvif);

      const upload = await this.uploader.uploadFile({
        localPath: screenshotPath,
        fileName: filename,
        mimeType: "image/avif"
      });

      if (this.config.deleteLocalAfterUpload) {
        await fs.rm(screenshotPath, { force: true });
      }

      captured.push({
        stepName: step.name || `shot-${i + 1}`,
        type: "screenshot",
        localPath: screenshotPath,
        mimeType: "image/avif",
        uploadedFileId: upload.fileId,
        uploadedFileName: upload.fileName
      });
    }

    return captured;
  }

  private async captureVideoForPage(page: Page, _url: string): Promise<CaptureArtifact> {
    await page.waitForTimeout(this.config.videoDurationSec * 1000);
    return {
      stepName: "video",
      type: "video",
      localPath: "",
      mimeType: "video/mp4",
      uploadedFileId: "",
      uploadedFileName: ""
    };
  }

  private async applyScriptStepsForVideo(page: Page, url: string, scriptSteps: ScriptCaptureStep[]): Promise<void> {
    for (let i = 0; i < scriptSteps.length; i += 1) {
      const step = scriptSteps[i];
      if (step.actionScript?.trim()) {
        await this.runStepActionScript(page, url, step, i);
      }
      const waitMs = step.waitMs ?? this.config.extraWaitMs;
      if (waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }
    }
  }

  private async finalizeCapturedVideo(
    captures: CaptureArtifact[],
    url: string,
    rawVideoPath: string
  ): Promise<CaptureArtifact[]> {
    const index = captures.findIndex((item) => item.type === "video");
    if (index < 0) return captures;

    const filename = this.buildVideoFilename(url);
    const videoPath = buildVideoPath(this.config.screenshotDir, filename);
    await transcodeToAv1Mp4(rawVideoPath, videoPath);

    const upload = await this.uploader.uploadFile({
      localPath: videoPath,
      fileName: filename,
      mimeType: "video/mp4"
    });

    if (this.config.deleteLocalAfterUpload) {
      await fs.rm(videoPath, { force: true });
    }
    await fs.rm(rawVideoPath, { force: true });

    captures[index] = {
      ...captures[index],
      localPath: videoPath,
      uploadedFileId: upload.fileId,
      uploadedFileName: upload.fileName
    };

    return captures;
  }

  private async runStepActionScript(page: Page, url: string, step: ScriptCaptureStep, index: number): Promise<void> {
    const script = step.actionScript?.trim();
    if (!script) return;

    try {
      await page.evaluate(
        async (payload: { source: string; context: { url: string; stepIndex: number; stepName: string } }) => {
          const AsyncFunction = Object.getPrototypeOf(async function () {
            return undefined;
          }).constructor as new (
            ...args: string[]
          ) => (context: { url: string; stepIndex: number; stepName: string }) => Promise<unknown>;
          const run = new AsyncFunction("context", payload.source);
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
    const base = buildScreenshotFilename(url, new Date()).replace(/\.avif$/i, "");
    const safeName = sanitizeFileToken(step.name || `shot-${index + 1}`);
    return `${base}__${safeName}.avif`;
  }

  private buildVideoFilename(url: string): string {
    return buildVideoFilename(url, new Date()).replace(/\.mp4$/i, "__video-av1.mp4");
  }

  private shouldCaptureScreenshot(): boolean {
    return this.config.captureMode === "screenshot" || this.config.captureMode === "both";
  }

  private shouldCaptureVideo(): boolean {
    return this.config.captureMode === "video" || this.config.captureMode === "both";
  }
}

async function transcodeToAv1Mp4(inputPath: string, outputPath: string): Promise<void> {
  const args = [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "libsvtav1",
    "-crf",
    String(AV1_CRF),
    "-preset",
    String(AV1_PRESET),
    "-g",
    String(AV1_GOP),
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-movflags",
    "+faststart",
    outputPath
  ];

  await runCommand("ffmpeg", args);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) {
        stderr += chunk.toString("utf-8");
      }
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("ffmpeg is not installed. AV1 video capture requires ffmpeg."));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim().split("\n").slice(-4).join(" | ");
      reject(new Error(`ffmpeg failed with code ${code}${message ? `: ${message}` : ""}`));
    });
  });
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
