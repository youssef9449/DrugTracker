/**
 * Critical Stock threshold crossing projection.
 *
 * Consumes the stock-depletion and dose-history domain modules plus calendar
 * primitives; owns ONLY the future critical-alarm crossing projection.
 */
import type { Medication } from '../../types';
import { getCriticalThresholdDays } from '../medicationDomain';
import { MS_PER_DAY } from '../time';
import {
  getTodayDateString,
  parseCalendarDate,
  formatUtcDateString,
} from './calendarPrimitives';
import {
  isDoseConsumedOnDate,
  isDoseSkippedOnDate,
  hasDoseSchedule,
} from './doseHistory';
import { dailyScheduleAmount, floorRatioSafely } from './stockDepletion';

/**
 * Future critical-threshold crossing from durable `currentPills` and the
 * medication's explicit `doseSchedule` times.
 *
 * Returns the exact local timestamp of the first projected dose occurrence
 * whose deduction causes `daysLeft <= criticalThresholdDays` (or stock ≤ 0).
 *
 * Performance: after handling today slot-by-slot, bulk-jumps consecutive
 * "normal" future days (no consume/skip markers) with arithmetic, and only
 * inspects individual dose rows on the crossing day or history-exception days.
 * Runtime is proportional to exception dates + dose rows, not to stock size.
 *
 * Returns null when already critical, no rate, Auto OFF, or no future crossing.
 */
export function getCriticalAlarmDate(
  med: Medication,
  todayStr: string = getTodayDateString(),
  nowMs: number = Date.now()
): number | null {
  const dayAmt = dailyScheduleAmount(med);
  if (dayAmt <= 0) return null;
  const criticalThresholdDays = getCriticalThresholdDays(med);
  const startingPills = Number(med.currentPills) || 0;
  if (startingPills <= 0) return null;
  const startingDaysLeft = floorRatioSafely(startingPills, dayAmt);
  if (startingDaysLeft <= criticalThresholdDays) return null;
  // Auto OFF: stock does not auto-decline → no future crossing.
  if (med.autoDeductEnabled === false) return null;
  if (!hasDoseSchedule(med) || !med.doseSchedule || med.doseSchedule.length === 0) {
    return null;
  }
  // Sorted by local clock time within a day (HH:mm).
  const slots = [...med.doseSchedule]
    .map((d) => {
      const time = typeof d.time === 'string' ? d.time : '';
      const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
      if (!match) return null;
      const hourPart = match[1];
      const minutePart = match[2];
      if (hourPart === undefined || minutePart === undefined) return null;
      const amount = Number(d.amount) || 0;
      if (amount <= 0 || !d.id) return null;
      return {
        id: d.id,
        amount,
        hour: parseInt(hourPart, 10),
        minute: parseInt(minutePart, 10),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s != null)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  if (slots.length === 0) return null;
  const doseIdSet = new Set(slots.map((s) => s.id));
  const isCritical = (pills: number): boolean => {
    if (pills <= 0) return true;
    return floorRatioSafely(pills, dayAmt) <= criticalThresholdDays;
  };
  const todayUtc = parseCalendarDate(todayStr);
  if (!todayUtc) return null;
  const localPartsFromUtcDate = (dateUtc: Date) => ({
    y: dateUtc.getUTCFullYear(),
    m: dateUtc.getUTCMonth(),
    d: dateUtc.getUTCDate(),
  });
  const occurrenceMsAt = (dateUtc: Date, hour: number, minute: number): number => {
    const { y, m, d } = localPartsFromUtcDate(dateUtc);
    return new Date(y, m, d, hour, minute, 0, 0).getTime();
  };
  /**
   * Process one calendar day slot-by-slot.
   * When `filterPast` is true (today only), skip occurrences <= nowMs.
   * Always skip consumed/skipped markers for that date.
   */
  const processDay = (
    pillsIn: number,
    dateUtc: Date,
    dateStr: string,
    filterPast: boolean
  ): { crossedAt: number | null; pillsOut: number } => {
    let pills = pillsIn;
    for (const slot of slots) {
      if (isDoseConsumedOnDate(med, slot.id, dateStr)) continue;
      if (isDoseSkippedOnDate(med, slot.id, dateStr)) continue;
      const at = occurrenceMsAt(dateUtc, slot.hour, slot.minute);
      if (filterPast && at <= nowMs) continue;
      const after = pills - slot.amount;
      if (isCritical(after)) {
        return { crossedAt: at, pillsOut: after };
      }
      pills = after;
    }
    return { crossedAt: null, pillsOut: pills };
  };
  // ── Today: only remaining future slots ──
  let pills = startingPills;
  const todayResult = processDay(pills, todayUtc, todayStr, true);
  if (todayResult.crossedAt != null) return todayResult.crossedAt;
  pills = todayResult.pillsOut;
  if (isCritical(pills)) {
    // Should have been caught by early return; stock already critical.
    return null;
  }
  // ── Future exception dates: any consume/skip marker after today for schedule dose ids ──
  const exceptionDates = new Set<string>();
  const collectExceptions = (hist: Record<string, string[]> | undefined) => {
    if (!hist) return;
    for (const doseId of doseIdSet) {
      const dates = hist[doseId];
      if (!Array.isArray(dates)) continue;
      for (const ds of dates) {
        if (typeof ds !== 'string' || !ds) continue;
        if (ds <= todayStr) continue;
        exceptionDates.add(ds);
      }
    }
  };
  collectExceptions(med.doseConsumptionHistory);
  collectExceptions(med.doseSkippedHistory);
  const sortedExceptions = [...exceptionDates].sort();
  // Cursor starts at tomorrow (UTC calendar day after today).
  let cursorUtc = new Date(todayUtc.getTime() + MS_PER_DAY);
  let exceptionIdx = 0;
  // Safety: enough stock-driven progress without per-day loops.
  // We only iterate exception dates + at most one normal crossing day.
  while (!isCritical(pills)) {
    const nextExceptionStr =
      exceptionIdx < sortedExceptions.length ? sortedExceptions[exceptionIdx] : null;
    const nextExceptionUtc = nextExceptionStr ? parseCalendarDate(nextExceptionStr) : null;
    // Days from cursor (inclusive) until the day before next exception (or unbounded).
    // If next exception is before cursor, skip it.
    if (nextExceptionUtc && nextExceptionStr && nextExceptionStr < formatUtcDateString(cursorUtc)) {
      exceptionIdx += 1;
      continue;
    }
    // Complete normal days until end-of-day stock would be Critical, then
    // process that day slot-by-slot for the exact crossing timestamp.
    const fullDaysNeeded =
      floorRatioSafely(pills, dayAmt) - criticalThresholdDays;
    if (fullDaysNeeded <= 0) {
      // Already Critical without further deduction — should not happen.
      return null;
    }
    if (nextExceptionUtc && nextExceptionStr) {
      // Number of full normal days strictly before the exception date.
      const daysUntilException = Math.round(
        (nextExceptionUtc.getTime() - cursorUtc.getTime()) / MS_PER_DAY
      );
      // daysUntilException === 0 → cursor is the exception day itself.
      // daysUntilException > 0 → that many normal days starting at cursor.
      if (daysUntilException > 0) {
        if (fullDaysNeeded <= daysUntilException) {
          // Crossing lands on a normal day inside [cursor, exception).
          // After (fullDaysNeeded - 1) complete normal days, process the next day slot-by-slot.
          const daysBeforeCrossingDay = fullDaysNeeded - 1;
          if (daysBeforeCrossingDay > 0) {
            pills -= daysBeforeCrossingDay * dayAmt;
          }
          const crossingUtc = new Date(
            cursorUtc.getTime() + daysBeforeCrossingDay * MS_PER_DAY
          );
          const crossingStr = formatUtcDateString(crossingUtc);
          const dayResult = processDay(pills, crossingUtc, crossingStr, false);
          if (dayResult.crossedAt != null) return dayResult.crossedAt;
          // Did not cross within the day (e.g. dayAmt mismatch) — advance past it.
          pills = dayResult.pillsOut;
          cursorUtc = new Date(crossingUtc.getTime() + MS_PER_DAY);
          continue;
        }
        // Consume all normal days before the exception in one step.
        pills -= daysUntilException * dayAmt;
        cursorUtc = nextExceptionUtc;
      }
      // Process exception day individually.
      if (isCritical(pills)) return null;
      const exResult = processDay(pills, nextExceptionUtc, nextExceptionStr, false);
      if (exResult.crossedAt != null) return exResult.crossedAt;
      pills = exResult.pillsOut;
      exceptionIdx += 1;
      cursorUtc = new Date(nextExceptionUtc.getTime() + MS_PER_DAY);
      continue;
    }
    // No further exceptions: jump straight to the mathematical crossing day.
    const daysBeforeCrossingDay = fullDaysNeeded - 1;
    if (daysBeforeCrossingDay > 0) {
      pills -= daysBeforeCrossingDay * dayAmt;
    }
    const crossingUtc = new Date(cursorUtc.getTime() + daysBeforeCrossingDay * MS_PER_DAY);
    const crossingStr = formatUtcDateString(crossingUtc);
    const dayResult = processDay(pills, crossingUtc, crossingStr, false);
    if (dayResult.crossedAt != null) return dayResult.crossedAt;
    // No crossing found (should be rare); stop to avoid infinite loop.
    return null;
  }
  return null;
}
