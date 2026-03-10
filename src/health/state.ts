export interface HealthState {
  startedAt: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  lastRunSuccess?: boolean;
  lastError?: string;
  running: boolean;
  shuttingDown: boolean;
}

export function createInitialHealthState(): HealthState {
  return {
    startedAt: new Date().toISOString(),
    running: false,
    shuttingDown: false
  };
}
