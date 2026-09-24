/**
 * Bounded retry/backoff mechanics for Dose Reminder scheduling operations.
 *
 * Owns ONLY the generic retry lifecycle (bounded attempts, backoff timers,
 * generation guardrails, disposal). Feature policy — what to schedule, when,
 * and with which identity — stays in the reconciliation coordinators.
 */

const RETRY_BACKOFF_MS = [1000, 4000, 16000] as const;
export const MAX_RETRY_ATTEMPTS = 3;

export interface RetryEnqueueArgs {
  /** Dedup/cleanup key for the retry timer itself (e.g. 'schedule:<key>'). */
  retryKey: string;
  /** Feature operation key used with the shared generation coordinator. */
  operationKey: string;
  generation: number;
  enqueue: (
    key: string,
    generation: number,
    operation: () => Promise<void>
  ) => Promise<void>;
  isCurrent: (key: string, generation: number) => boolean;
  operation: () => Promise<void>;
}

export class DoseReminderRetryScheduler {
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private disposed = false;

  markDisposed(): void {
    this.disposed = true;
  }

  clearRetry(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
    this.retryAttempts.delete(key);
  }

  clearAllRetries(): void {
    for (const key of this.retryTimers.keys()) {
      this.clearRetry(key);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Enqueue an operation wrapped with the bounded retry/backoff lifecycle. */
  enqueueRetryable(args: RetryEnqueueArgs): void {
    const { retryKey, operationKey, generation, enqueue, isCurrent, operation } = args;
    this.clearRetry(retryKey);

    const run = (attempt: number): Promise<void> =>
      enqueue(operationKey, generation, async () => {
        if (this.disposed || !isCurrent(operationKey, generation)) return;
        try {
          await operation();
          this.clearRetry(retryKey);
        } catch (error) {
          if (this.disposed || !isCurrent(operationKey, generation)) return;
          const nextAttempt = attempt + 1;
          if (nextAttempt > MAX_RETRY_ATTEMPTS) {
            console.warn(
              '[dose-reminder] bounded retry exhausted:',
              operationKey,
              error
            );
            return;
          }
          const timer = setTimeout(() => {
            this.retryTimers.delete(retryKey);
            if (this.disposed || !isCurrent(operationKey, generation)) return;
            void run(nextAttempt).catch((retryError) => {
              console.warn(
                '[dose-reminder] retry enqueue failed:',
                operationKey,
                retryError
              );
            });
          }, RETRY_BACKOFF_MS[attempt]);
          this.retryTimers.set(retryKey, timer);
          this.retryAttempts.set(retryKey, nextAttempt);
        }
      });

    void run(0).catch((error) => {
      console.warn(
        '[dose-reminder] operation enqueue failed:',
        operationKey,
        error
      );
    });
  }

  /**
   * Shared bounded retry for the stale-alarm cleanup pass (formerly
   * duplicated in both the disabled and desired branches).
   */
  runStaleCleanupWithRetry(
    staleGeneration: number,
    isStaleGeneration: (token: number) => boolean,
    runCleanup: () => Promise<{ ok: boolean; error?: string; errorCode?: string }>
  ): void {
    const retryKey = '__stale_dose_alarm_cleanup__';
    this.clearRetry(retryKey);
    const attemptCleanup = async (attempt: number): Promise<void> => {
      if (this.disposed || !isStaleGeneration(staleGeneration)) return;
      const result = await runCleanup();
      if (result.ok) {
        this.clearRetry(retryKey);
        return;
      }
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        console.warn(
          '[dose-reminder] bounded stale-alarm cleanup retry exhausted:',
          result.error,
          result.errorCode
        );
        return;
      }
      const timer = setTimeout(() => {
        this.retryTimers.delete(retryKey);
        void attemptCleanup(attempt + 1).catch((error) => {
          console.warn('[dose-reminder] stale cleanup retry failed:', error);
        });
      }, RETRY_BACKOFF_MS[attempt]);
      this.retryTimers.set(retryKey, timer);
    };
    void attemptCleanup(0).catch((error) => {
      console.warn('[dose-reminder] stale cleanup failed:', error);
    });
  }
}
