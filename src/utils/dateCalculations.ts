import { Medication, getCriticalThresholdDays } from '../types';
import { MS_PER_DAY, NEVER_DEPLETES_DAYS } from './time';

/**
 * Returns today's date as a deterministic YYYY-MM-DD string, using
 * the client's local timezone.
 *
 * This is a client-side Vite SPA (no SSR), so there is no server/client
 * hydration concern. The function is kept pure (no window/localStorage
 * access) simply so it can be safely called during module init and
 * from the seed-data file without side effects.
 */
export function getTodayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse a "YYYY-MM-DD" string into a UTC midnight Date.
 *
 * Why UTC: `new Date(2024, m, d)` interprets the components in the
 * LOCAL timezone, and `setDate`/`getTime` math then crosses DST
 * boundaries with 23- or 25-hour days — producing off-by-one errors
 * around DST transitions. Treating YYYY-MM-DD as a UTC calendar date
 * makes day arithmetic exact (1 day = 86400000 ms, always).
 */
function parseUtcDate(dateStr: string): Date | null {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  // Date.UTC month is 0-indexed.
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a Date (interpreted as UTC) back to "YYYY-MM-DD". */
function formatUtcDateString(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** True when the med has a non-empty dose schedule. */
export function hasDoseSchedule(med: Medication): boolean {
  return Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;
}

/**
 * Dates on which `doseId` was consumed, from `doseConsumptionHistory` only.
 * Missing or empty history → no consumed dates.
 */
function getDoseConsumedDates(med: Medication, doseId: string): string[] {
  const hist = med.doseConsumptionHistory?.[doseId];
  if (!Array.isArray(hist) || hist.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of hist) {
    if (typeof d === 'string' && d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

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
 * Record that `doseId` was restored/skipped on `dateStr` so the same
 * occurrence is not treated as still due for Exact Auto deduction.
 * Idempotent per doseId+date; does not itself change durable `currentPills`.
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
 * schedule rate only (Issue #266). Does not invent deductions from elapsed
 * calendar days.
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


/**
 * Depletion date from durable `Medication.currentPills` and the current
 * schedule rate only (Issue #266).
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
 * medication's explicit `doseSchedule` times.
 *
 * Walks scheduled dose occurrences in chronological order and returns the
 * exact local timestamp of the first projected deduction that causes
 * `daysLeft <= criticalThresholdDays` (or stock ≤ 0). Does not invent
 * calendar-day deductions and does not use a fixed fire hour.
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

  const startingDaysLeft = Math.floor(startingPills / dayAmt);
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
      const amount = Number(d.amount) || 0;
      if (amount <= 0 || !d.id) return null;
      return {
        id: d.id,
        amount,
        hour: parseInt(match[1], 10),
        minute: parseInt(match[2], 10),
      };
    })
    .filter((s): s is NonNullable<typeof s> => s != null)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  if (slots.length === 0) return null;

  const isCritical = (pills: number): boolean => {
    if (pills <= 0) return true;
    return Math.floor(pills / dayAmt) <= criticalThresholdDays;
  };

  let pills = startingPills;
  // Bound only by durable stock and positive daily rate: enough future
  // occurrences to reach critical/out-of-stock, plus a small margin for
  // threshold arithmetic. No arbitrary fixed calendar ceiling.
  const maxDays = Math.ceil(startingPills / dayAmt) + criticalThresholdDays + 2;

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
    const dayUtc = parseUtcDate(todayStr);
    if (!dayUtc) return null;
    const dateUtc = new Date(dayUtc.getTime() + dayOffset * MS_PER_DAY);
    const dateStr = formatUtcDateString(dateUtc);
    // Local calendar components matching YYYY-MM-DD string (same as app date model).
    const y = dateUtc.getUTCFullYear();
    const m = dateUtc.getUTCMonth();
    const d = dateUtc.getUTCDate();

    for (const slot of slots) {
      // Already consumed or skipped today/on this date → do not project again.
      if (isDoseConsumedOnDate(med, slot.id, dateStr)) continue;
      if (isDoseSkippedOnDate(med, slot.id, dateStr)) continue;

      const occurrenceMs = new Date(y, m, d, slot.hour, slot.minute, 0, 0).getTime();
      // Past occurrences are not future alarms.
      if (occurrenceMs <= nowMs) continue;

      const after = pills - slot.amount;
      if (isCritical(after)) {
        return occurrenceMs;
      }
      pills = after;
      if (pills <= 0) {
        // Exhausted without having returned — treat last occurrence as crossing.
        return occurrenceMs;
      }
    }
  }

  return null;
}
