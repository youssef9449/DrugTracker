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
  let changed = false;
  if (snooze[key] !== undefined) {
    delete snooze[key];
    changed = true;
  }
  // When clearing a multi-dose slot, also drop any obsolete med-level key
  // left over from pre-Phase-3B installs.
  if (doseId && doseId !== LEGACY_DOSE_ID && snooze[medId] !== undefined) {
    delete snooze[medId];
    changed = true;
  }
  if (changed) saveJson(SNOOZE_KEY, snooze);
}

/**
 * @deprecated Prefer {@link clearSnoozedDose}. Clears the med-only key only.
 */
export function clearSnoozedDoseForMed(medId: string): void {
  clearSnoozedDose(medId);
}

/**
 * Read whether a med/dose is currently under an active snooze window.
 *
 * Multi-dose (explicit non-legacy doseId): only the dose-scoped key is
 * checked. An obsolete pre-Phase-3B med-only key must NOT suppress sibling
 * slots — it is cleared on first multi-dose check so it cannot linger.
 *
 * Legacy (no doseId / LEGACY_DOSE_ID): med-only key as before.
 */
export function isSnoozeActive(
  medId: string,
  doseId?: string | null,
  nowMs: number = Date.now()
): boolean {
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  const key = snoozeStorageKey(medId, doseId);
  const until = snooze[key];
  if (typeof until === 'number' && nowMs < until) return true;

  // Multi-dose path: never inherit med-only snooze for a specific slot.
  // Clear obsolete med-level key so it cannot suppress unrelated doses.
  if (doseId && doseId !== LEGACY_DOSE_ID && key !== medId) {
    if (snooze[medId] !== undefined) {
      delete snooze[medId];
      saveJson(SNOOZE_KEY, snooze);
    }
  }
  return false;
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
