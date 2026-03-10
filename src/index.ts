import http from "node:http";
import type { AppConfig, RunConfig } from "./config";
import { loadConfig } from "./config";
import { OAuthSetupHandler } from "./auth/oauthSetup";
import { startHealthServer } from "./health/server";
import { createInitialHealthState } from "./health/state";
import { logger } from "./logger";
import { createScheduledRunner, type ScheduledRunner } from "./scheduler";
import {
  buildRuntimeSettingsFromEnv,
  loadRuntimeSettings,
  parseRuntimeSettingsInput,
  runtimeSettingsToInput,
  saveRuntimeSettings,
  type RuntimeSettings
} from "./runtime/settings";
import { ScreenshotService } from "./services/screenshotService";
import { GoogleDriveUploader } from "./storage/googleDriveUploader";
import { createControlPlaneHandler } from "./web/controlPlane";

function parseMode(argv: string[]): "daemon" | "once" | "dry-run" | "setup" {
  if (argv.includes("--once")) return "once";
  if (argv.includes("--dry-run")) return "dry-run";
  if (argv.includes("--setup")) return "setup";
  return "daemon";
}

async function waitForDrain(state: { running: boolean }, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (state.running) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function buildRunConfig(config: AppConfig, settings: RuntimeSettings, refreshToken: string): RunConfig {
  return {
    ...settings,
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
    googleRedirectUri: config.googleRedirectUri,
    googleRefreshToken: refreshToken,
    googleTokenFile: config.googleTokenFile
  };
}

function loadInitialRuntimeSettings(config: AppConfig): RuntimeSettings | undefined {
  const fromFile = loadRuntimeSettings(config.appRuntimeConfigFile);
  if (fromFile) return fromFile;

  const fromEnv = buildRuntimeSettingsFromEnv(process.env);
  const validated = parseRuntimeSettingsInput(runtimeSettingsToInput(fromEnv));
  return validated.value;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const config = loadConfig();
  logger.level = config.logLevel;

  let runtimeSettings = loadInitialRuntimeSettings(config);
  let refreshToken = config.googleRefreshToken;

  const healthState = createInitialHealthState();
  healthState.setupRequired = !runtimeSettings || !refreshToken;

  if (mode === "dry-run") {
    logger.info(
      {
        mode,
        hasRuntimeSettings: Boolean(runtimeSettings),
        hasRefreshToken: Boolean(refreshToken),
        oauthSetupEnabled: config.oauthSetupEnabled
      },
      "Configuration is valid"
    );
    return;
  }

  if (mode === "once" && (!runtimeSettings || !refreshToken)) {
    throw new Error("--once requires runtime settings and a refresh token");
  }

  if (mode === "setup" && !config.oauthSetupEnabled) {
    throw new Error("--setup requires OAUTH_SETUP_ENABLED=true");
  }

  let runner: ScheduledRunner | undefined;
  let healthServer: http.Server | undefined;

  const runNow = async (runConfig: RunConfig): Promise<void> => {
    const startMs = Date.now();
    const uploader = new GoogleDriveUploader(runConfig);
    const screenshotService = new ScreenshotService(runConfig, uploader);

    const summary = await screenshotService.runOnce();
    const failures = summary.results.filter((item) => !item.success).length;
    const successes = summary.results.length - failures;

    healthState.totalRuns += 1;
    healthState.totalUrlSuccess += successes;
    healthState.totalUrlFailure += failures;
    healthState.lastRunDurationMs = Date.now() - startMs;

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

  const stopScheduler = async (): Promise<void> => {
    if (!runner) return;
    runner.stop();
    await waitForDrain(healthState, 30000);
    runner = undefined;
  };

  const startScheduler = async (): Promise<void> => {
    if (!runtimeSettings || !refreshToken) {
      healthState.setupRequired = true;
      return;
    }

    await stopScheduler();

    const currentRunConfig = buildRunConfig(config, runtimeSettings, refreshToken);

    if (mode === "setup") {
      return;
    }

    if (mode === "once") {
      await runNow(currentRunConfig);
      if (healthServer) await closeServer(healthServer);
      return;
    }

    runner = createScheduledRunner(runtimeSettings.cronSchedule, () => runNow(currentRunConfig), healthState);
    runner.start();
    await runner.triggerNow();
    healthState.setupRequired = false;
  };

  const saveSettings = async (settings: RuntimeSettings): Promise<void> => {
    runtimeSettings = settings;
    saveRuntimeSettings(config.appRuntimeConfigFile, config.appRuntimeEnvFile, settings);
    healthState.setupRequired = !refreshToken;
  };

  const oauthSetupHandler = config.oauthSetupEnabled
    ? new OAuthSetupHandler(config, () => runtimeSettings?.googleDriveMode || "appdata", async (token) => {
        refreshToken = token;
        healthState.setupRequired = !runtimeSettings;
        await startScheduler();
      })
    : undefined;

  const controlPlane = createControlPlaneHandler({
    config,
    healthState,
    getRuntimeSettings: () => runtimeSettings,
    getHasRefreshToken: () => Boolean(refreshToken),
    getMetrics: () => ({
      totalRuns: healthState.totalRuns,
      totalUrlSuccess: healthState.totalUrlSuccess,
      totalUrlFailure: healthState.totalUrlFailure,
      schedulerActive: healthState.schedulerActive
    }),
    saveSettings,
    restartScheduler: startScheduler,
    getOauthAuthorizationUrl: () => {
      if (!oauthSetupHandler) {
        throw new Error("OAuth setup is disabled");
      }
      return oauthSetupHandler.createAuthorizationUrl();
    }
  });

  healthServer = startHealthServer(config.port, healthState, {
    additionalRouteHandler: async (req, res) => {
      const handledByControlPlane = await controlPlane(req, res);
      if (handledByControlPlane) return true;
      if (oauthSetupHandler) return oauthSetupHandler.handle(req, res);
      return false;
    }
  });

  if (runtimeSettings && refreshToken && mode !== "setup") {
    await startScheduler();
  } else if (!config.oauthSetupEnabled && mode !== "setup") {
    throw new Error("Runtime settings and/or refresh token missing. Enable OAUTH setup or configure env/runtime files.");
  } else {
    logger.warn("Setup is pending. Open the root URL to configure and initialize OAuth.");
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthState.shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received");
    await stopScheduler();
    if (healthServer) await closeServer(healthServer);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
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
