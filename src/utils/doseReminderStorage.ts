/**
 * Persistent storage for the dose-reminder snooze marker map.
 *
 * Single source of truth for the `SNOOZE_KEY` localStorage entry used by
 * the dose-reminder alarm flow ({@link useDoseReminders}) and by the
 * consumption-suppression logic in
 * {@link useDoseReminderScheduler}.
 *
 * Storage shape: { [medicationId]: snoozeUntilEpochMs } under one
 * versioned key. All access is synchronous localStorage (via loadJson /
 * saveJson), so a read-decide-write pass is atomic with respect to other
 * JS code (single-threaded) as long as callers do not await in between.
 */

import { loadJson, saveJson } from './storage';

export const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

/**
 * Clear the persisted snooze marker for a medication.
 *
 * Called by useDoseReminderScheduler's consumption suppression: when the
 * day's dose is consumed (manual card action or the notification's
 * take-dose action) while a snoozed one-shot reminder is still pending,
 * the native pending notification is cancelled
 * (cancelSnoozedDoseReminder) and the marker is removed here so no
 * stale snooze state survives for an already-taken dose.
 */
export function clearSnoozedDoseForMed(medId: string): void {
  const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
  if (snooze[medId] === undefined) return;
  delete snooze[medId];
  saveJson(SNOOZE_KEY, snooze);
}
