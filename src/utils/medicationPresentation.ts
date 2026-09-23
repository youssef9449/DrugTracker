import type { MedicationStatusInfo } from '../types';

export function formatTimeArabic(timeStr?: string): string {
  if (!timeStr) return '';
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeStr);
  if (!match) return timeStr;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'م' : 'ص'}`;
}

export function formatArabicDate(
  dateStr: string,
  includeWeekday: boolean = true
): string {
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    if ([year, month, day].some(Number.isNaN)) return dateStr;

    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('ar-EG', {
      weekday: includeWeekday ? 'long' : undefined,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

export function formatLogTime(timestamp?: string | number): string {
  if (!timestamp) return '';
  const str = String(timestamp).trim();
  if (!str.includes('T') && !str.includes(':') && !/^\d{10,}$/.test(str)) {
    return '';
  }

  try {
    const date = /^\d{10,}$/.test(str) ? new Date(Number(str)) : new Date(str);
    if (Number.isNaN(date.getTime())) return '';

    const hour = date.getHours();
    const minute = date.getMinutes();
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'م' : 'ص'}`;
  } catch {
    return '';
  }
}

export function formatDepletionDate(
  dateStr: string,
  daysLeft: number,
  currentPills: number
): string {
  if (currentPills <= 0) return 'نفد المخزون بالكامل';
  if (daysLeft === 0) return 'ينفد اليوم';
  if (daysLeft === 1) return 'غداً';
  if (daysLeft === 2) return 'بعد غد';

  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    if ([year, month, day].some(Number.isNaN)) return dateStr;

    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('ar-EG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

export interface MedicationStatusPresentation {
  statusLabel: string;
  statusColorClass: string;
  badgeBg: string;
  badgeText: string;
}

export function presentMedicationStatus(
  info: MedicationStatusInfo
): MedicationStatusPresentation {
  if (info.status === 'out_of_stock') {
    return {
      statusLabel: 'نفد تماماً',
      statusColorClass: 'text-red-600',
      badgeBg: 'bg-red-50 text-red-700 border-red-200',
      badgeText: '⚠️ نفد المخزون',
    };
  }

  if (info.status === 'critical') {
    const remaining =
      info.daysLeft === 1
        ? 'يوم واحد'
        : info.daysLeft === 2
          ? 'يومين'
          : info.daysLeft <= 10
            ? `${info.daysLeft} أيام`
            : `${info.daysLeft} يوماً`;

    return {
      statusLabel: `حرج (${remaining})`,
      statusColorClass: 'text-rose-600',
      badgeBg: 'bg-rose-50 text-rose-700 border-rose-200',
      badgeText: `🚨 باقي ${info.daysLeft === 1 ? 'يوم فقط' : remaining}`,
    };
  }

  if (info.daysLeft === Number.POSITIVE_INFINITY) {
    return {
      statusLabel: 'غير محدد',
      statusColorClass: 'text-slate-600',
      badgeBg: 'bg-slate-100 text-slate-700 border-slate-200',
      badgeText: 'استهلاك غير محدد',
    };
  }

  return {
    statusLabel: `كافٍ (${info.daysLeft} يوماً)`,
    statusColorClass: 'text-emerald-600',
    badgeBg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    badgeText: `✅ يكفي لـ ${info.daysLeft} يوماً`,
  };
}