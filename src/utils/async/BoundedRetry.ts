/**
 * Feature-neutral bounded retry/backoff primitive (#521).
 *
 * One canonical implementation of the "bounded attempts with exponential
 * backoff" operational mechanic shared by feature schedulers. The primitive
 * knows NOTHING about medications, doses, stock, Auto-Deduction, Critical
 * Stock, or Dose Reminder business rules:
 * - the caller supplies the operation, a staleness check (generation-style
 *   invalidation stays feature-owned), and a per-attempt error handler;
 * - the primitive owns only the attempt counting, backoff delays, and timer
 *   lifecycle for the given delay schedule.
 */

/** Default bounded backoff schedule (ms): 1s → 4s → 16s. */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 4000, 16000];

/** Maximum attempts AFTER the initial try (matches the documented bound of 3). */
export const DEFAULT_MAX_RETRIES = 3;

export interface BoundedRetryHandle {
  cancel(): void;
}

export interface BoundedRetryOptions {
  /** Execute one attempt. Throw to trigger the next bounded retry. */
  runAttempt: (attempt: number) => void | Promise<void>;
  /**
   * Return false to abandon scheduled retry work (generation invalidated,
   * disposed, superseded). Evaluated before each attempt and after each
   * backoff wait.
   */
  isCurrent: () => boolean;
  /** Called when an attempt fails and another attempt is scheduled. */
  onRetryScheduled?: (attempt: number, error: unknown) => void;
  /** Called when the bounded budget is exhausted (final failure). */
  onExhausted?: (error: unknown) => void;
  /** Called when an attempt fails but the work is no longer current. */
  onAbandoned?: (error: unknown) => void;
  backoffMs?: readonly number[];
  maxRetries?: number;
  /**
   * Timer accessor so runtimes without setTimeout (SSR/tests) can inject a
   * no-op scheduler. Defaults to global setTimeout/clearTimeout.
   */
  scheduleTimer?: (
    fn: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Run an attempt immediately, then retry on failure with bounded backoff.
 * Each backoff wake-up re-checks {@link BoundedRetryOptions.isCurrent} so a
 * superseded operation never runs stale work.
 */
export function runWithBoundedRetry(options: BoundedRetryOptions): BoundedRetryHandle {
  const backoffMs = options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const scheduleTimer =
    options.scheduleTimer ??
    ((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
  const clearTimer =
    options.clearTimer ??
    ((handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));

  let cancelled = false;
  let timerHandle: ReturnType<typeof setTimeout> | null = null;

  const attempt = (n: number): void => {
    if (cancelled || !options.isCurrent()) return;
    void Promise.resolve()
      .then(() => options.runAttempt(n))
      .catch((error: unknown) => {
        if (cancelled || !options.isCurrent()) {
          options.onAbandoned?.(error);
          return;
        }
        const nextAttempt = n + 1;
        if (nextAttempt > maxRetries) {
          options.onExhausted?.(error);
          return;
        }
        options.onRetryScheduled?.(n, error);
        timerHandle = scheduleTimer(() => {
          timerHandle = null;
          attempt(nextAttempt);
        }, backoffMs[Math.min(n, backoffMs.length - 1)]);
      });
  };

  attempt(0);

  return {
    cancel(): void {
      cancelled = true;
      if (timerHandle !== null) {
        clearTimer(timerHandle);
        timerHandle = null;
      }
    },
  };
}
