export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  onRetry?: (attempt: number, error: unknown, nextDelayMs: number) => void
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > options.retries || !options.shouldRetry(error)) {
        throw error;
      }

      const nextDelayMs = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      onRetry?.(attempt, error, nextDelayMs);
      await sleep(nextDelayMs);
    }
  }
}
