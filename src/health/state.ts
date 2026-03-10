export interface HealthState {
  startedAt: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  lastRunDurationMs?: number;
  lastRunSuccess?: boolean;
  lastError?: string;
  running: boolean;
  shuttingDown: boolean;
  setupRequired: boolean;
  totalRuns: number;
  totalUrlSuccess: number;
  totalUrlFailure: number;
  schedulerActive: boolean;
}

export function createInitialHealthState(): HealthState {
  return {
    startedAt: new Date().toISOString(),
    running: false,
    shuttingDown: false,
    setupRequired: false,
    totalRuns: 0,
    totalUrlSuccess: 0,
    totalUrlFailure: 0,
    schedulerActive: false
  };
}
