/**
 * Boundary-aware coordinator for native schedule restoration.
 * One successful restore per recovery boundary key; concurrent calls share
 * one in-flight promise; failed boundaries remain retryable.
 */
import {
  restoreFutureAutoDeductionSchedules,
} from './autoDeductionNativeRecovery';
import type { RestoreFutureSchedulesResult } from './autoDeductionNativeTypes';

let inFlightKey: string | null = null;
let inFlight: Promise<RestoreFutureSchedulesResult> | null = null;
let lastSuccessfulBoundary: string | null = null;
let lastSuccessfulResult: RestoreFutureSchedulesResult | null = null;

/**
 * Canonical recovery-boundary key shared by all consumers (scheduler + exact recon).
 * Same (resumeTick, midnightTick) must produce the same key in every hook.
 */
export function recoveryBoundaryKey(
  resumeTick: number,
  midnightTick: number
): string {
  return `${Number(resumeTick) || 0}:${Number(midnightTick) || 0}`;
}

/**
 * @param boundaryKey from {@link recoveryBoundaryKey}
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

