/**
 * Stock depletion calculations.
 *
 * Durable-stock arithmetic built on calendar primitives. No notification or
 * deduction policy lives here.
 */
import type { Medication } from '../../types';
import { MS_PER_DAY, NEVER_DEPLETES_DAYS } from '../time';
import {
  getTodayDateString,
  parseCalendarDate,
  formatUtcDateString,
} from './calendarPrimitives';
import { hasDoseSchedule } from './doseHistory';

/** Sum of per-dose amounts, or dailyDose when no schedule. */
export function dailyScheduleAmount(med: Medication): number {
  if (hasDoseSchedule(med)) {
    return med.doseSchedule!.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  }
  return Number(med.dailyDose) || 0;
}
/**
 * Floor of numerator/denominator that corrects only tiny IEEE-754 errors
 * immediately below an integer boundary (e.g. 1.8 / 0.30000000000000004).
 * Does not change Critical business thresholds.
 */
export function floorRatioSafely(numerator: number, denominator: number): number {
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio)) return Math.floor(ratio);
  const absRatio = Math.abs(ratio);
  const exponent = absRatio > 0 ? Math.floor(Math.log2(absRatio)) : 0;
  const ulp = absRatio > 0 ? 2 ** (exponent - 52) : Number.EPSILON;
  const nearestInteger = Math.round(ratio);
  if (
    ratio < nearestInteger &&
    nearestInteger - ratio <= ulp
  ) {
    return nearestInteger;
  }
  return Math.floor(ratio);
}
/**
 * Days of stock remaining from durable `currentPills` and the current
 * schedule rate only. Does not invent deductions from elapsed
 * calendar days.
 */
export function daysLeftFromCurrentStock(med: Medication): number {
  const dayAmt = dailyScheduleAmount(med);
  if (dayAmt <= 0) return NEVER_DEPLETES_DAYS;
  const pills = Number(med.currentPills) || 0;
  if (pills <= 0) return 0;
  return floorRatioSafely(pills, dayAmt);
}
/**
 * Depletion date from durable `Medication.currentPills` and the current
 * schedule rate only.
 */
export function getDepletionDate(med: Medication): {
  dateStr: string;
  daysLeft: number;
} {
  const daysLeft = daysLeftFromCurrentStock(med);
  const todayUtc = parseCalendarDate(getTodayDateString()) ?? new Date(Date.UTC(1970, 0, 1));
  const targetUtc = new Date(todayUtc.getTime() + daysLeft * MS_PER_DAY);
  return {
    dateStr: formatUtcDateString(targetUtc),
    daysLeft,
  };
}
