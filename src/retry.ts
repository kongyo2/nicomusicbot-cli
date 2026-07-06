export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  shouldRetry?: (error: unknown, failedAttempt: number) => boolean;
  getDelayMs?: (error: unknown, failedAttempt: number) => number | undefined;
};

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function defaultShouldRetry(): boolean {
  return true;
}

function exponentialDelay(
  failedAttempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  return Math.min(baseDelayMs * 2 ** (failedAttempt - 1), maxDelayMs);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 5_000);
  const sleepImpl = options.sleep ?? sleep;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error, attempt)) {
        throw error;
      }

      await sleepImpl(
        options.getDelayMs?.(error, attempt) ??
          exponentialDelay(attempt, baseDelayMs, maxDelayMs),
      );
    }
  }

  return operation();
}
