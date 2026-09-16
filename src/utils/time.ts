/**
 * Shared time + numeric constants (audit #99).
 *
 * Previously these magic numbers were scattered across the codebase as
 * bare literals. Centralizing them makes intent clear and provides a
 * single edit point.
 */

/** One minute in milliseconds. */
export const MS_PER_MINUTE = 60 * 1000;

/** One day in milliseconds (used for UTC day arithmetic). */
export const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Sentinel returned by `effectiveDaysLeft` when `dailyDose <= 0`,
 * meaning "never depletes". Referenced in tests as the expected value
 * for meds with no consumption rate.
 */
export const NEVER_DEPLETES_DAYS = 999;

/** Polling interval for the dose-reminder check (useDoseReminders). */
export const REMINDER_POLL_INTERVAL_MS = 5000;

/** Default snooze duration in minutes (useDoseReminders). */
export const DEFAULT_SNOOZE_MINUTES = 10;

/** Offset for scheduling a notification "immediately" (1 second in the
 *  future so Capacitor treats it as a real notification, not head-up). */
export const NOTIFICATION_IMMEDIATE_OFFSET_MS = 1000;

/** Local hour (24h) at which critical-date alarms fire (9 AM). */
export const CRITICAL_ALARM_FIRE_HOUR = 9;

/** Toast auto-dismiss duration in milliseconds. */
export const TOAST_DURATION_MS = 4000;

/** Debounce window for the pharmacy-settings persistence write. */
export const PHARMACY_PERSIST_DEBOUNCE_MS = 400;

/** Service-worker ready timeout — dev mode has no SW registered, so
 *  navigator.serviceWorker.ready would hang without this guard. */
export const SW_READY_TIMEOUT_MS = 2000;

/** Visual-range multiplier for the stock progress bar
 *  (Math.max(packageDays, warningThresholdDays * 3, MIN_VISUAL_RANGE_DAYS)). */
export const VISUAL_RANGE_MULTIPLIER = 3;

/** Minimum visual-range days for the stock progress bar (≈ one month). */
export const MIN_VISUAL_RANGE_DAYS = 30;

/** Maximum number of consumption-log rows rendered in the list. */
export const MAX_LOG_ROWS = 15;

/** Default package size for solid (pill/capsule) medications. */
export const DEFAULT_SOLID_PACK_SIZE = 30;

/** Default package size for liquid (ml) medications. */
export const DEFAULT_LIQUID_PACK_SIZE = 100;

/**
 * Convert a "HH:MM" 24-hour string to minutes-since-midnight.
 *
 * Returns -1 for malformed input (NaN, wrong shape, or out-of-range
 * hour/minute — #25). Used by the dose-reminder scheduler + tests.
 */
export function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':').map((n) => parseInt(n, 10));
  const [h, m] = parts;
  if (parts.length < 2 || Number.isNaN(h) || Number.isNaN(m)) return -1;
  if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

/**
 * Format a 24-hour "HH:mm" (or "H:mm") string for user-facing display
 * as 12-hour Arabic AM/PM style:
 *   "00:00" → "12:00 ص"
 *   "09:30" → "09:30 ص"
 *   "12:00" → "12:00 م"
 *   "22:00" → "10:00 م"
 *
 * Display-only. Does not alter stored schedule times or AlarmManager input.
 * Invalid input is returned unchanged.
 */
export function formatReminderTime12h(timeStr: string): string {
  if (!timeStr || typeof timeStr !== 'string') return timeStr;
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return timeStr;
  }
  const period = h < 12 ? 'ص' : 'م';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  const hh = String(hour12).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm} ${period}`;
}

/** Days per month — used for monthly-consumption calculations. */
export const DAYS_PER_MONTH = 30;
