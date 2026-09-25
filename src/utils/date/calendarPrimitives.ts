/**
 * Calendar/date primitives and validation.
 *
 * Dependency-light: no feature policy (dose, stock, or critical-stock logic)
 * lives here. Higher-level domain modules consume these primitives.
 * Local calendar identity is the application contract: dates are YYYY-MM-DD
 * strings in device-local time; parsing rejects impossible calendar dates
 * instead of normalizing them.
 */
import { MS_PER_DAY } from '../time';

/**
 * Returns today's date as a deterministic YYYY-MM-DD string, using
 * the client's local timezone.
 *
 * Pure calendar-date formatting helper.
 */
export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
export function getTodayDateString(): string {
  return getLocalDateString();
}
export function addCalendarDays(dateStr: string, days: number): string {
  const parsed = parseCalendarDate(dateStr);
  if (!parsed || !Number.isFinite(days)) return dateStr;
  const target = new Date(parsed.getTime() + days * MS_PER_DAY);
  return formatUtcDateString(target);
}
export function calendarDayDifference(fromDate: string, toDate: string): number | null {
  const from = parseCalendarDate(fromDate);
  const to = parseCalendarDate(toDate);
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}
export function tomorrowDateString(dateStr: string = getTodayDateString()): string {
  return addCalendarDays(dateStr, 1);
}
export function nextLocalMidnightEpochMs(now: Date = new Date()): number | null {
  if (!Number.isFinite(now.getTime())) return null;
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0
  );
  const epochMs = nextMidnight.getTime();
  return Number.isFinite(epochMs) ? epochMs : null;
}
export function localEpochMs(calendarDate: string, timeHhmm: string): number | null {
  const calendarDateValue = parseCalendarDate(calendarDate);
  if (!calendarDateValue) return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeHhmm);
  if (!match) return null;

  const dt = new Date(
    calendarDateValue.getUTCFullYear(),
    calendarDateValue.getUTCMonth(),
    calendarDateValue.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
    0,
    0
  );
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}
/**
 * Parse a valid `YYYY-MM-DD` local calendar date as UTC midnight.
 * Invalid calendar dates are rejected instead of being normalized
 * (shape + real month/day ranges incl. leap years).
 */
export function parseCalendarDate(dateStr: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return null;
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}
/** Format a Date (interpreted as UTC) back to "YYYY-MM-DD". */
export function formatUtcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Canonical persisted calendar-date validation (YYYY-MM-DD shape + real
 * calendar semantics: month range, day-of-month per month, leap years).
 * Mirrors parseCalendarDate so persisted state and runtime boundaries
 * accept exactly the same dates.
 */
const CALENDAR_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidCalendarDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !CALENDAR_DATE_SHAPE.test(value)) return false;
  const parsed = parseCalendarDate(value);
  return parsed !== null;
}
