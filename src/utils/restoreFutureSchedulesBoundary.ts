/**
 * Boundary-aware coordinator for native schedule restoration.
 * One successful restore per recovery boundary key; concurrent calls share
 * one in-flight promise; failed boundaries remain retryable.
 */
import {
  restoreFutureAutoDeductionSchedules,
  type RestoreFutureSchedulesResult,
} from './autoDeductionNative';

let inFlightKey: string | null = null;
let inFlight: Promise<RestoreFutureSchedulesResult> | null = null;
let lastSuccessfulBoundary: string | null = null;
let lastSuccessfulResult: RestoreFutureSchedulesResult | null = null;

/**
 * @param boundaryKey stable key for the recovery boundary (e.g. `${resumeTick}:${midnightTick}`)
 */
export function restoreFutureSchedulesOnce(
  boundaryKey: string
): Promise<RestoreFutureSchedulesResult> {
  if (
    lastSuccessfulBoundary === boundaryKey &&
    lastSuccessfulResult &&
    lastSuccessfulResult.ok
  ) {
    return Promise.resolve(lastSuccessfulResult);
  }

  if (inFlight && inFlightKey === boundaryKey) {
    return inFlight;
  }

  inFlightKey = boundaryKey;
  inFlight = restoreFutureAutoDeductionSchedules()
    .then((result) => {
      if (result.ok) {
        lastSuccessfulBoundary = boundaryKey;
        lastSuccessfulResult = result;
      }
      // Failed boundary: do not mark complete — later call may retry.
      return result;
    })
    .finally(() => {
      inFlight = null;
      inFlightKey = null;
    });
  return inFlight;
}

/** @internal test-only */
export function __resetRestoreFutureSchedulesBoundaryForTests(): void {
  inFlight = null;
  inFlightKey = null;
  lastSuccessfulBoundary = null;
  lastSuccessfulResult = null;
}
