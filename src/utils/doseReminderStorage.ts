/**
 * Persistent storage for the dose-reminder snooze marker map.
 *
 * Storage shape (Issue #268):
 *   { [`${medicationId}::${doseId}`]: snoozeUntilEpochMs }
 *
 * doseId is required — no medication-level snooze identity.
 */

import { loadJson, saveJson } from './storage';

export const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

/**
 * Stable storage key for a dose-scoped snooze marker.
 * Requires non-empty doseId; returns null when missing.
 */
export function snoozeStorageKey(medId: string, doseId: string): string | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return `${medId}::${id}`;
}

/**
 * Clear the persisted snooze marker for an explicit dose row.
 */
export function clearSnoozedDose(medId: string, doseId: string): void {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return;
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  if (snooze[key] !== undefined) {
    delete snooze[key];
    saveJson(SNOOZE_KEY, snooze);
  }
}

/**
 * True when the explicit dose row is under an active snooze window.
 */
export function isSnoozeActive(
  medId: string,
  doseId: string,
  nowMs: number = Date.now()
): boolean {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return false;
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  const until = snooze[key];
  return typeof until === 'number' && nowMs < until;
}

/** Persist a snooze-until marker for an explicit dose row. */
export function setSnoozeUntil(
  medId: string,
  untilMs: number,
  doseId: string
): void {
  const key = snoozeStorageKey(medId, doseId);
  if (!key) return;
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  snooze[key] = untilMs;
  saveJson(SNOOZE_KEY, snooze);
}
