import http from "node:http";
import { loadConfig } from "./config";
import { createInitialHealthState } from "./health/state";
import { startHealthServer } from "./health/server";
import { logger } from "./logger";
import { createScheduledRunner } from "./scheduler";
import { ScreenshotService } from "./services/screenshotService";
import { GoogleDriveUploader } from "./storage/googleDriveUploader";

function parseMode(argv: string[]): "daemon" | "once" | "dry-run" {
  if (argv.includes("--once")) {
    return "once";
  }
  if (argv.includes("--dry-run")) {
    return "dry-run";
  }
  return "daemon";
}

async function waitForDrain(state: { running: boolean }, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (state.running) {
    if (Date.now() - start > timeoutMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const config = loadConfig();

  logger.level = config.logLevel;

  if (mode === "dry-run") {
    logger.info(
      {
        mode,
        targetUrlCount: config.targetUrls.length,
        cronSchedule: config.cronSchedule,
        googleDriveMode: config.googleDriveMode
      },
      "Configuration is valid"
    );
    return;
  }

  const healthState = createInitialHealthState();
  const healthServer = startHealthServer(config.port, healthState);

  const uploader = new GoogleDriveUploader(config);
  const screenshotService = new ScreenshotService(config, uploader);

  const runJob = async () => {
    const summary = await screenshotService.runOnce();
    const failures = summary.results.filter((item) => !item.success).length;
    logger.info(
      {
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        total: summary.results.length,
        failures
      },
      "Capture run finished"
    );
    if (failures > 0) {
      throw new Error(`Capture run had ${failures} failure(s)`);
    }
  };

  if (mode === "once") {
    await runJob();
    await closeServer(healthServer);
    return;
  }

  const runner = createScheduledRunner(config.cronSchedule, runJob, healthState);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    healthState.shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");
    runner.stop();
    await waitForDrain(healthState, 30000);
    await closeServer(healthServer);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  runner.start();
  await runner.triggerNow();
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

main().catch((error) => {
  logger.error({ err: error }, "Fatal startup error");
  process.exit(1);
});
