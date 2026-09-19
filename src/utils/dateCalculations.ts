import { Medication, getCriticalThresholdDays } from '../types';
import { MS_PER_DAY, NEVER_DEPLETES_DAYS, CRITICAL_ALARM_FIRE_HOUR } from './time';

/**
 * Whether a specific dose slot was consumed on `dateStr`.
 * Uses only `doseConsumptionHistory` (no medication-level lastConsumedDate fallback).
 */
export function isDoseConsumedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): boolean {
  return getDoseConsumedDates(med, doseId).includes(dateStr);
}

/**
 * Record a manual consumption of `doseId` on `dateStr`.
 * Appends to `doseConsumptionHistory` (no duplicate dates).
 */
export function recordDoseConsumed(
  med: Medication,
  doseId: string,
  dateStr: string
): {
  doseConsumptionHistory: Record<string, string[]>;
} {
  const doseConsumptionHistory: Record<string, string[]> = {
    ...(med.doseConsumptionHistory ?? {}),
  };
  const prev = doseConsumptionHistory[doseId] ?? [];
  if (!prev.includes(dateStr)) {
    doseConsumptionHistory[doseId] = [...prev, dateStr];
  } else {
    doseConsumptionHistory[doseId] = prev;
  }
  return { doseConsumptionHistory };
}

/**
 * Whether a specific dose slot was restored/skipped on `dateStr`
 * (Auto-Deduct → Restore bookkeeping). Skipped slots are not auto-due
 * again for that date and are available for a later manual Take.
 */
export function isDoseSkippedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): boolean {
  const hist = med.doseSkippedHistory?.[doseId];
  return Array.isArray(hist) && hist.includes(dateStr);
}

/**
 * Record that `doseId` was restored/skipped on `dateStr` so auto-sync
 * and projection will not re-deduct that slot for that date.
 * Idempotent per doseId+date.
 */
export function recordDoseSkipped(
  med: Medication,
  doseId: string,
  dateStr: string
): { doseSkippedHistory: Record<string, string[]> } {
  const doseSkippedHistory: Record<string, string[]> = {
    ...(med.doseSkippedHistory ?? {}),
  };
  const prev = doseSkippedHistory[doseId] ?? [];
  if (!prev.includes(dateStr)) {
    doseSkippedHistory[doseId] = [...prev, dateStr];
  } else {
    doseSkippedHistory[doseId] = prev;
  }
  return { doseSkippedHistory };
}

/**
 * Clear a skip mark for `doseId` on `dateStr` (e.g. after manual Take
 * following Restore). Does not touch other dates or doseIds.
 */
export function clearDoseSkippedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): { doseSkippedHistory: Record<string, string[]> } {
  const doseSkippedHistory: Record<string, string[]> = {
    ...(med.doseSkippedHistory ?? {}),
  };
  const prev = doseSkippedHistory[doseId] ?? [];
  const next = prev.filter((d) => d !== dateStr);
  if (next.length === 0) {
    delete doseSkippedHistory[doseId];
  } else {
    doseSkippedHistory[doseId] = next;
  }
  return { doseSkippedHistory };
}


/** Sum of per-dose amounts, or dailyDose when no schedule. */
export function dailyScheduleAmount(med: Medication): number {
  if (hasDoseSchedule(med)) {
    return med.doseSchedule!.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  }
  return Number(med.dailyDose) || 0;
}

/**
 * Days of stock remaining from durable `currentPills` and the current
 * schedule rate. Does NOT subtract lastSyncDate horizons or elapsed
 * uncommitted doses (Issue #266).
 */
export function daysLeftFromCurrentStock(med: Medication): number {
  const dayAmt = dailyScheduleAmount(med);
  if (dayAmt <= 0) return NEVER_DEPLETES_DAYS;
  const pills = Number(med.currentPills) || 0;
  if (pills <= 0) return 0;
  return Math.floor(pills / dayAmt);
}

export function formatArabicDate(dateStr: string, includeWeekday: boolean = true): string {
  try {
    const d = parseUtcDate(dateStr);
    if (!d) return dateStr;
    const options: Intl.DateTimeFormatOptions = {
      weekday: includeWeekday ? 'long' : undefined,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    };
    return d.toLocaleDateString('ar-EG', { ...options, timeZone: 'UTC' });
  } catch {
    return dateStr;
  }
}

/**
 * Format an ISO timestamp string or epoch into Arabic 12-hour time format.
 */
export function formatLogTime(timestamp?: string | number): string {
  if (!timestamp) return '';
  const str = String(timestamp).trim();
  if (!str.includes('T') && !str.includes(':') && !/^\d{10,}$/.test(str)) {
    return '';
  }
  try {
    const d = /^\d{10,}$/.test(str) ? new Date(Number(str)) : new Date(str);
    if (Number.isNaN(d.getTime())) return '';
    const h = d.getHours();
    const m = d.getMinutes();
    const isPM = h >= 12;
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    const minutePadded = m < 10 ? `0${m}` : `${m}`;
    return `${hour12}:${minutePadded} ${isPM ? 'م' : 'ص'}`;
  } catch {
    return '';
  }
}

export function getDaysDifference(fromDateStr: string, toDateStr: string): number {
  try {
    const date1 = parseUtcDate(fromDateStr);
    const date2 = parseUtcDate(toDateStr);
    if (!date1 || !date2) return 0;
    const diffDays = Math.round((date2.getTime() - date1.getTime()) / MS_PER_DAY);
    return Math.max(0, diffDays);
  } catch {
    return 0;
  }
}

/**
 * Depletion date from durable `Medication.currentPills` only (Issue #266).
 * No lastSyncDate / elapsed-dose projection.
 */
export function getDepletionDate(med: Medication): {
  dateStr: string;
  formattedArabic: string;
  daysLeft: number;
} {
  const currentPills = Number(med.currentPills) || 0;
  const daysLeft = daysLeftFromCurrentStock(med);

  const todayUtc = parseUtcDate(getTodayDateString()) ?? new Date(Date.UTC(1970, 0, 1));
  const targetUtc = new Date(todayUtc.getTime() + daysLeft * MS_PER_DAY);
  const dateStr = formatUtcDateString(targetUtc);

  let formattedArabic: string;
  if (currentPills <= 0) {
    formattedArabic = 'نفد المخزون بالكامل';
  } else if (daysLeft === 0) {
    formattedArabic = 'ينفد اليوم';
  } else if (daysLeft === 1) {
    formattedArabic = 'غداً';
  } else if (daysLeft === 2) {
    formattedArabic = 'بعد غد';
  } else {
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    };
    formattedArabic = targetUtc.toLocaleDateString('ar-EG', options);
  }

  return {
    dateStr,
    formattedArabic,
    daysLeft,
  };
}

/**
 * Future critical-threshold crossing from durable `currentPills` and the
 * current schedule rate. Independent of `lastSyncDate` (Issue #266).
 * Returns null when already critical, no rate, or Auto OFF (frozen stock).
 */
export function getCriticalAlarmDate(
  med: Medication,
  todayStr: string = getTodayDateString()
): number | null {
  if (dailyScheduleAmount(med) <= 0) return null;

  const criticalThresholdDays = getCriticalThresholdDays(med);
  const daysLeft = daysLeftFromCurrentStock(med);

  if (daysLeft <= criticalThresholdDays) return null;

  // Auto OFF: stock does not auto-decline → no future crossing.
  if (med.autoDeductEnabled === false) return null;

  const daysUntilCritical = daysLeft - criticalThresholdDays;
  if (daysUntilCritical <= 0) return null;

  const todayUtc = parseUtcDate(todayStr) ?? new Date(Date.UTC(1970, 0, 1));
  const targetUtcMs = todayUtc.getTime() + daysUntilCritical * MS_PER_DAY;
  const targetUtcDate = new Date(targetUtcMs);
  const target = new Date(
    targetUtcDate.getUTCFullYear(),
    targetUtcDate.getUTCMonth(),
    targetUtcDate.getUTCDate(),
    CRITICAL_ALARM_FIRE_HOUR,
    0, 0, 0
  );
  return target.getTime();
}
