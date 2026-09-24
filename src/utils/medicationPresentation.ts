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
