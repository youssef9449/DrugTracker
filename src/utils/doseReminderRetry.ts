/**
 * Bounded retry/backoff mechanics for Dose Reminder scheduling operations.
 *
 * The generic retry lifecycle (bounded attempts, backoff timers, timer
 * lifecycle) is the SHARED feature-neutral primitive
 * {@link runWithBoundedRetry} (#521). This module binds it to the Dose
 * Reminder generation/queue coordinators; feature policy — what to schedule,
 * when, and with which identity — stays in the reconciliation coordinators.
 */
import { runWithBoundedRetry, type BoundedRetryHandle } from './async/BoundedRetry';

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
  private readonly retryTimers = new Map<string, BoundedRetryHandle>();
  private disposed = false;

  markDisposed(): void {
    this.disposed = true;
  }

  clearRetry(key: string): void {
    const handle = this.retryTimers.get(key);
    if (handle !== undefined) {
      handle.cancel();
      this.retryTimers.delete(key);
    }
  }

  clearAllRetries(): void {
    for (const key of Array.from(this.retryTimers.keys())) {
      this.clearRetry(key);
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** Enqueue an operation wrapped with the shared bounded retry lifecycle. */
  enqueueRetryable(args: RetryEnqueueArgs): void {
    const { retryKey, operationKey, generation, enqueue, isCurrent, operation } = args;
    this.clearRetry(retryKey);

    const handle = runWithBoundedRetry({
      runAttempt: () =>
        enqueue(operationKey, generation, async () => {
          if (this.disposed || !isCurrent(operationKey, generation)) return;
          // Failures propagate to the shared retry primitive, which owns the
          // bounded attempt progression.
          await operation();
          this.clearRetry(retryKey);
        }),
      isCurrent: () => !this.disposed,
      onRetryScheduled: (attempt, error) => {
        console.warn(
          '[dose-reminder] operation attempt failed, retry scheduled:',
          operationKey,
          'attempt',
          attempt,
          error
        );
      },
      onExhausted: (error) => {
        console.warn('[dose-reminder] bounded retry exhausted:', operationKey, error);
      },
      onAbandoned: (error) => {
        console.warn('[dose-reminder] retry abandoned (stale/disposed):', operationKey, error);
      },
    });
    this.retryTimers.set(retryKey, handle);
  }

  /**
   * Shared bounded retry for the stale-alarm cleanup pass. Generation
   * staleness stays feature-owned via the isStaleGeneration check.
   */
  runStaleCleanupWithRetry(
    staleGeneration: number,
    isStaleGeneration: (token: number) => boolean,
    runCleanup: () => Promise<{ ok: boolean; error?: string; errorCode?: string }>
  ): void {
    const retryKey = '__stale_dose_alarm_cleanup__';
    this.clearRetry(retryKey);
    const handle = runWithBoundedRetry({
      runAttempt: async () => {
        const result = await runCleanup();
        if (result.ok) {
          this.clearRetry(retryKey);
          return;
        }
        throw new Error(
          `stale_cleanup_failed:${result.error ?? 'unknown'}${result.errorCode ? ':' + result.errorCode : ''}`
        );
      },
      isCurrent: () => !this.disposed && isStaleGeneration(staleGeneration),
      onExhausted: (error) => {
        console.warn(
          '[dose-reminder] bounded stale-alarm cleanup retry exhausted:',
          error
        );
      },
    });
    this.retryTimers.set(retryKey, handle);
  }
}
