/**
 * Pure ownership check mirroring native AutoDeductionScheduler.isMetadataOwnedByVersion.
 * Used by unit tests to lock the stale-rollback concurrency contract without Android.
 *
 * A failed scheduling attempt may remove schedule metadata only when the
 * currently stored scheduleVersion still matches the attempt's own version.
 */

export const FIELD_SCHEDULE_VERSION = 'scheduleVersion';

export interface ScheduleMetadataLike {
  medicationId?: string;
  doseId?: string;
  calendarDate?: string;
  timeHhmm?: string;
  amount?: number;
  scheduledAtEpochMs?: number;
  scheduleVersion?: string;
  [key: string]: unknown;
}

/**
 * @returns true if current metadata is still owned by expectedVersion
 *          (and thus may be rolled back by that attempt).
 */
export function isMetadataOwnedByVersion(
  currentJson: string | null | undefined,
  expectedVersion: string | null | undefined
): boolean {
  if (expectedVersion == null || expectedVersion === '') return false;
  if (currentJson == null || currentJson === '') return false;
  try {
    const o = JSON.parse(currentJson) as ScheduleMetadataLike;
    const current = typeof o.scheduleVersion === 'string' ? o.scheduleVersion : '';
    return expectedVersion === current;
  } catch {
    return false;
  }
}

/**
 * Simulate conditional rollback against an in-memory map of schedule entries.
 * Mirrors: synchronized(SCHEDULE_LOCK) { read; verify version; remove if ours }.
 *
 * @returns true if the entry was removed
 */
export function conditionalRollback(
  store: Map<string, string>,
  prefKey: string,
  expectedVersion: string
): boolean {
  const current = store.get(prefKey) ?? null;
  if (!isMetadataOwnedByVersion(current, expectedVersion)) {
    return false;
  }
  store.delete(prefKey);
  return true;
}

/** Build a schedule metadata JSON string with a version stamp. */
export function buildSchedulePayload(
  fields: Omit<ScheduleMetadataLike, 'scheduleVersion'> & { scheduleVersion: string }
): string {
  return JSON.stringify(fields);
}

/**
 * Minimal model of the serialized scheduler transaction for unit tests.
 * Proves ordering: metadata write + "install" + rollback cannot interleave
 * with another transaction for the same key when guarded by a mutex.
 */
export type AlarmState = { version: string; triggerAt: number } | null;

export interface SchedulerTxnState {
  metadata: Map<string, string>;
  alarms: Map<string, AlarmState>;
}

export function runSerializedScheduleTxn(
  state: SchedulerTxnState,
  prefKey: string,
  payload: { scheduleVersion: string; scheduledAtEpochMs: number },
  installSucceeds: boolean
): { ok: boolean } {
  // Entire txn is atomic from the caller's perspective (models SCHEDULE_LOCK).
  const json = buildSchedulePayload({
    scheduleVersion: payload.scheduleVersion,
    scheduledAtEpochMs: payload.scheduledAtEpochMs,
  });
  state.metadata.set(prefKey, json);
  if (!installSucceeds) {
    conditionalRollback(state.metadata, prefKey, payload.scheduleVersion);
    state.alarms.set(prefKey, null);
    return { ok: false };
  }
  state.alarms.set(prefKey, {
    version: payload.scheduleVersion,
    triggerAt: payload.scheduledAtEpochMs,
  });
  return { ok: true };
}

export function runSerializedCancelTxn(
  state: SchedulerTxnState,
  prefKey: string
): void {
  state.alarms.set(prefKey, null);
  state.metadata.delete(prefKey);
}
