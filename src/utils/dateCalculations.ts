import { Medication, ConsumptionLog } from '../types';

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

/** One calendar day in milliseconds (used for UTC day arithmetic). */
const MS_PER_DAY = 1000 * 60 * 60 * 24;

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
    // toLocaleDateString reads the UTC fields when timeZone is UTC.
    return d.toLocaleDateString('ar-EG', { ...options, timeZone: 'UTC' });
  } catch {
    return dateStr;
  }
}

export function getDaysDifference(fromDateStr: string, toDateStr: string): number {
  try {
    const date1 = parseUtcDate(fromDateStr);
    const date2 = parseUtcDate(toDateStr);
    if (!date1 || !date2) return 0;
    // Round before dividing so a 23:59:59.999 → 00:00:00.001 boundary
    // still collapses to a whole number of days.
    const diffDays = Math.round((date2.getTime() - date1.getTime()) / MS_PER_DAY);
    return Math.max(0, diffDays);
  } catch {
    return 0;
  }
}

export function getDepletionDate(med: Medication): {
  dateStr: string;
  formattedArabic: string;
  daysLeft: number;
} {
  const rawDays = med.dailyDose > 0 ? Math.floor(med.currentPills / med.dailyDose) : 999;
  const daysLeft = Math.max(0, rawDays);

  // Compute today's UTC date, then add `daysLeft` days in UTC so the
  // result is a calendar date that doesn't shift by an hour across DST.
  const todayUtc = parseUtcDate(getTodayDateString()) ?? new Date(Date.UTC(1970, 0, 1));
  const targetUtc = new Date(todayUtc.getTime() + daysLeft * MS_PER_DAY);
  const dateStr = formatUtcDateString(targetUtc);

  let formattedArabic: string;
  if (med.currentPills <= 0) {
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

export interface AutoSyncResult {
  updatedMeds: Medication[];
  newLogs: ConsumptionLog[];
  deductedSummary: {
    medName: string;
    daysPassed: number;
    pillsDeducted: number;
    remainingPills: number;
  }[];
}

export function syncAutoDailyDeductions(
  medications: Medication[],
  todayStr: string = getTodayDateString()
): AutoSyncResult {
  const updatedMeds: Medication[] = [];
  const newLogs: ConsumptionLog[] = [];
  const deductedSummary: AutoSyncResult['deductedSummary'] = [];

  medications.forEach((med) => {
    // If no lastSyncDate, default to today
    const lastDate = med.lastSyncDate || todayStr;
    const daysPassed = getDaysDifference(lastDate, todayStr);

    if (med.autoDeductEnabled !== false && daysPassed > 0 && med.dailyDose > 0) {
      const pillsToDeduct = Math.min(med.currentPills, daysPassed * med.dailyDose);
      const newPills = Math.max(0, med.currentPills - pillsToDeduct);

      updatedMeds.push({
        ...med,
        currentPills: newPills,
        lastSyncDate: todayStr,
      });

      if (pillsToDeduct > 0) {
        newLogs.push({
          id: 'log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
          medicationId: med.id,
          medicationName: med.name,
          type: 'auto_daily',
          amount: -pillsToDeduct,
          date: todayStr,
          timestamp: new Date().toISOString(),
          description: `خصم تلقائي لمرور ${daysPassed} ${daysPassed === 1 ? 'يوم' : 'أيام'} (-${pillsToDeduct} ${med.unit})`,
        });

        deductedSummary.push({
          medName: med.name,
          daysPassed,
          pillsDeducted: pillsToDeduct,
          remainingPills: newPills,
        });
      }
    } else {
      // Just keep as is, ensuring lastSyncDate is set
      updatedMeds.push({
        ...med,
        lastSyncDate: med.lastSyncDate || todayStr,
      });
    }
  });

  return {
    updatedMeds,
    newLogs,
    deductedSummary,
  };
}
