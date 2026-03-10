import cron, { ScheduledTask } from "node-cron";
import { logger } from "../logger";
import type { HealthState } from "../health/state";

export interface ScheduledRunner {
  start(): void;
  stop(): void;
  triggerNow(): Promise<void>;
}

export function createScheduledRunner(
  schedule: string,
  job: () => Promise<void>,
  healthState: HealthState
): ScheduledRunner {
  let inProgress = false;

  async function runJob(): Promise<void> {
    if (inProgress) {
      logger.warn("Previous run still in progress; skipping overlapping trigger");
      return;
    }

    inProgress = true;
    healthState.running = true;
    healthState.lastRunStartedAt = new Date().toISOString();

    try {
      await job();
      healthState.lastRunSuccess = true;
      healthState.lastError = undefined;
    } catch (error) {
      healthState.lastRunSuccess = false;
      healthState.lastError = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, "Scheduled job failed");
    } finally {
      healthState.running = false;
      healthState.lastRunFinishedAt = new Date().toISOString();
      inProgress = false;
    }
  }

  const task: ScheduledTask = cron.createTask(schedule, runJob);

  return {
    start() {
      task.start();
      logger.info({ schedule }, "Scheduler started");
    },
    stop() {
      task.stop();
      logger.info("Scheduler stopped");
    },
    async triggerNow() {
      await runJob();
    }
  };
}
