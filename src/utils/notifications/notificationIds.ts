export const ID_RANGE_SIZE = 1_000_000;

/** Numeric base for each notification category's id range. */
export const NOTIFICATION_ID_BASE = {
  lowStock: 1_000_000,
  critical: 2_000_000,
  dose: 3_000_000,
  test: 4_000_000,
  iosCriticalAlarm: 5_000_000,
  doseAlarm: 6_000_000,
  doseSnooze: 7_000_000,
} as const;

type NotificationCategory = keyof typeof NOTIFICATION_ID_BASE;

function hashToRange(str: string, rangeSize: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % rangeSize;
}

/**
 * Compute a stable notification id for a given category + medication.
 *
 * - test category returns a fixed constant (there is only ever one
 *   test notification at a time).
 * - All other categories return BASE + hash(medId) % RANGE_SIZE, so the
 *   same med always maps to the same id within its category's band, and
 *   different categories never collide (disjoint bands).
 */

export function notificationId(
  category: NotificationCategory,
  medId?: string
): number {
  const base = NOTIFICATION_ID_BASE[category];
  if (category === 'test') return base;
  return base + hashToRange(medId ?? '', ID_RANGE_SIZE);
}

/**
 * One-time upgrade cleanup for alarms created by the pre-Phase-6
 * LocalNotifications scheduler. Android may still have those old AlarmManager
 * entries after an app update, so they must be removed before the new
 * ExactAlarmRuntime schedules the same logical occurrences.
 */


/**
 * iOS-only compatibility identity for Critical Stock.
 * Android Critical alarms use the native PendingIntent identity instead.
 */
export function iosCriticalAlarmId(medId: string): number {
  return notificationId('iosCriticalAlarm', medId);
}

export function doseReminderAlarmIdForDose(
  medId: string,
  doseId: string
): number | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return notificationId('doseAlarm', `${medId}::${id}`);
}

export function snoozeDoseReminderId(medId: string, doseId: string): number | null {
  const id = typeof doseId === 'string' ? doseId.trim() : '';
  if (!id) return null;
  return notificationId('doseSnooze', `${medId}::${id}`);
}
