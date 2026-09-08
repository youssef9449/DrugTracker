import { Medication, ConsumptionLog } from '../types';

/**
 * Returns today's date as a deterministic YYYY-MM-DD string.
 *
 * Uses the local timezone on the client but falls back to a
 * fixed reference date when running in environments where the
 * system clock may differ from the user's locale. This keeps
 * the rendered output stable between server and client, which
 * is required to avoid React hydration mismatches in AI Studio's
 * SSR preview environment.
 */
export function getTodayDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatArabicDate(dateStr: string, includeWeekday: boolean = true): string {
  try {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const options: Intl.DateTimeFormatOptions = {
      weekday: includeWeekday ? 'long' : undefined,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    };
    return d.toLocaleDateString('ar-EG', options);
  } catch {
    return dateStr;
  }
}

export function getDaysDifference(fromDateStr: string, toDateStr: string): number {
  try {
    const [y1, m1, d1] = fromDateStr.split('-').map(Number);
    const [y2, m2, d2] = toDateStr.split('-').map(Number);
    const date1 = new Date(y1, m1 - 1, d1);
    const date2 = new Date(y2, m2 - 1, d2);
    const diffTime = date2.getTime() - date1.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
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
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysLeft);

  const yyyy = targetDate.getFullYear();
  const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  };

  let formattedArabic = targetDate.toLocaleDateString('ar-EG', options);
  if (med.currentPills <= 0) {
    formattedArabic = 'نفد المخزون بالكامل';
  } else if (daysLeft === 0) {
    formattedArabic = 'ينفد اليوم';
  } else if (daysLeft === 1) {
    formattedArabic = 'غداً';
  } else if (daysLeft === 2) {
    formattedArabic = 'بعد غد';
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
