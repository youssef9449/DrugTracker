/**
 * Calendar + dose/stock/critical date-domain calculations.
 *
 * Focused domain modules (#508) — this module is the stable public surface
 * (UI components and hooks import these names):
 * - `./date/calendarPrimitives` — date parsing/formatting, local calendar
 *   identity, calendar validation. No feature policy.
 * - `./date/doseHistory` — per-dose consumption / skip history.
 * - `./date/stockDepletion` — durable stock arithmetic.
 * - `./date/criticalProjection` — future critical-threshold crossing.
 *
 * Feature modules import the focused files directly.
 */
export {
  getLocalDateString,
  getTodayDateString,
  addCalendarDays,
  calendarDayDifference,
  tomorrowDateString,
  nextLocalMidnightEpochMs,
  localEpochMs,
  parseCalendarDate,
  formatUtcDateString,
  isValidCalendarDateString,
} from './date/calendarPrimitives';
export {
  hasDoseSchedule,
  isDoseConsumedOnDate,
  recordDoseConsumed,
  isDoseSkippedOnDate,
  recordDoseSkipped,
  clearDoseSkippedOnDate,
} from './date/doseHistory';
export {
  dailyScheduleAmount,
  floorRatioSafely,
  daysLeftFromCurrentStock,
  getDepletionDate,
} from './date/stockDepletion';
export { getCriticalAlarmDate } from './date/criticalProjection';
