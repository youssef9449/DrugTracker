import type { MedicationDose } from '../types';
import { getTodayDateString } from './dateCalculations';
import { timeToMinutes } from './time';

/** One selectable dose row with the calendar day it belongs to. */
export interface DoseSelectItem {
  dose: MedicationDose;
  /** YYYY-MM-DD of the dose event (not derived from time-of-day alone). */
  eventDate: string;
}

/**
 * Concise Arabic day label relative to `todayStr`.
 * today → اليوم, tomorrow → غدًا, else weekday name (ar-EG).
 * Pure presentation helper — does not affect consumption/stock.
 */
export function relativeDoseDayLabel(
  eventDateStr: string,
  todayStr: string = getTodayDateString()
): string {
  if (eventDateStr === todayStr) return 'اليوم';
  try {
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const [ey, em, ed] = eventDateStr.split('-').map(Number);
    if (
      [ty, tm, td, ey, em, ed].every((n) => typeof n === 'number' && !Number.isNaN(n))
    ) {
      const todayUtc = Date.UTC(ty, tm - 1, td);
      const eventUtc = Date.UTC(ey, em - 1, ed);
      const dayDiff = Math.round((eventUtc - todayUtc) / 86_400_000);
      if (dayDiff === 1) return 'غدًا';
      const weekday = new Date(eventUtc).toLocaleDateString('ar-EG', {
        weekday: 'long',
        timeZone: 'UTC',
      });
      if (weekday) return weekday;
    }
  } catch {
    // fall through
  }
  return eventDateStr;
}

/**
 * Sort dose events by actual calendar date, then by clock time.
 * Does not use display strings as the sort key.
 */
export function sortDoseSelectItems(items: DoseSelectItem[]): DoseSelectItem[] {
  return [...items].sort((a, b) => {
    if (a.eventDate !== b.eventDate) {
      return a.eventDate.localeCompare(b.eventDate);
    }
    const ma = timeToMinutes(a.dose.time);
    const mb = timeToMinutes(b.dose.time);
    if (ma !== mb) return ma - mb;
    return (a.dose.id || '').localeCompare(b.dose.id || '');
  });
}
