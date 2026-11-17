/** Retries an async call with exponential backoff and jitter. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseDelayMs: number; isRetryable?: (e: unknown) => boolean; onRetry?: (e: unknown, attempt: number) => void },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      const retryable = opts.isRetryable ? opts.isRetryable(e) : true;
      if (!retryable || attempt >= opts.retries) throw e;
      opts.onRetry?.(e, attempt);
      const delay = opts.baseDelayMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}
