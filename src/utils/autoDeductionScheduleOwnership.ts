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
