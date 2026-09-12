/**
 * Persistent storage for the dose-reminder snooze marker map.
 *
 * Single source of truth for the `SNOOZE_KEY` localStorage entry used by
 * the dose-reminder alarm flow ({@link useDoseReminders}) and by the
 * consumption-suppression logic in
 * {@link useDoseReminderScheduler}.
 *
 * Storage shape (Phase 3B):
 *   { [storageKey]: snoozeUntilEpochMs }
 * where storageKey is:
 *   - medicationId                         (legacy / single-dose)
 *   - `${medicationId}::${doseId}`         (multi-dose per-slot)
 *
 * All access is synchronous localStorage (via loadJson / saveJson), so a
 * read-decide-write pass is atomic with respect to other JS code
 * (single-threaded) as long as callers do not await in between.
 */

import { loadJson, saveJson } from './storage';
import { LEGACY_DOSE_ID } from './notifications';

export const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

/**
 * Stable storage key for a snooze marker.
 * Legacy / omitted / LEGACY_DOSE_ID → med-only key (backward compatible).
 * Multi-dose → medId::doseId so slots are independent.
 */
export function snoozeStorageKey(medId: string, doseId?: string | null): string {
  if (!doseId || doseId === LEGACY_DOSE_ID) return medId;
  return `${medId}::${doseId}`;
}

/**
 * Clear the persisted snooze marker for a medication (and optional dose).
 *
 * - clearSnoozedDose(medId) — clears the legacy med-only key.
 * - clearSnoozedDose(medId, doseId) — clears that dose's key only.
 *
 * Called by useDoseReminderScheduler's consumption suppression: when a
 * dose slot is consumed while a snoozed one-shot is still pending, the
 * native pending notification is cancelled and the marker is removed so
 * no stale snooze state survives for an already-taken dose.
 */
export function clearSnoozedDose(medId: string, doseId?: string | null): void {
  const key = snoozeStorageKey(medId, doseId);
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  if (snooze[key] === undefined) return;
  delete snooze[key];
  saveJson(SNOOZE_KEY, snooze);
}

/**
 * @deprecated Prefer {@link clearSnoozedDose}. Clears the med-only key only.
 */
export function clearSnoozedDoseForMed(medId: string): void {
  clearSnoozedDose(medId);
}

/** Read whether a med/dose is currently under an active snooze window. */
export function isSnoozeActive(
  medId: string,
  doseId?: string | null,
  nowMs: number = Date.now()
): boolean {
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  const until = snooze[snoozeStorageKey(medId, doseId)];
  return typeof until === 'number' && nowMs < until;
}

/** Persist a snooze-until marker for med (+ optional dose). */
export function setSnoozeUntil(
  medId: string,
  untilMs: number,
  doseId?: string | null
): void {
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  snooze[snoozeStorageKey(medId, doseId)] = untilMs;
  saveJson(SNOOZE_KEY, snooze);
}
