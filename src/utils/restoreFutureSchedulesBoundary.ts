/**
 * Single owner for native schedule restoration within a recovery boundary.
 * Concurrent callers (Exact Auto reconciliation + desired-state scheduler)
 * share one in-flight restore instead of duplicating native work.
 */
import {
  restoreFutureAutoDeductionSchedules,
  type RestoreFutureSchedulesResult,
} from './autoDeductionNative';

let inFlight: Promise<RestoreFutureSchedulesResult> | null = null;

/**
 * Coalesce concurrent restore requests. When the native call completes,
 * the next boundary may run a fresh restore.
 */
export function restoreFutureSchedulesOnce(): Promise<RestoreFutureSchedulesResult> {
  if (!inFlight) {
    inFlight = restoreFutureAutoDeductionSchedules().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** @internal test-only */
export function __resetRestoreFutureSchedulesBoundaryForTests(): void {
  inFlight = null;
}
