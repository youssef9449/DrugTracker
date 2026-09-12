/**
 * Multi-dose schedule helpers (Phase 1).
 *
 * These helpers prepare and validate doseSchedule / dosesPerDay without
 * changing auto-deduction or notification scheduling. The existing
 * engine continues to use `dailyDose` (total units per day) and a single
 * `reminderTime`.
 */
import type { Medication, MedicationDose } from '../types';
import { generateId } from './id';
import { timeToMinutes } from './time';

/** Sensible UI maximum for doses per day (compact mobile form). */
export const MAX_DOSES_PER_DAY = 6;

/** Default times used when expanding the schedule (HH:mm). */
export const DEFAULT_DOSE_TIMES = ['08:00', '14:00', '21:00', '12:00', '18:00', '22:00'] as const;

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** True if the string is a valid 24h HH:mm (or H:mm). */
export function isValidDoseTime(time: string): boolean {
  if (!time || typeof time !== 'string') return false;
  if (!TIME_RE.test(time)) return false;
  return timeToMinutes(time) >= 0;
}

/** Normalize to zero-padded HH:mm when valid; otherwise return original. */
export function normalizeTimeString(time: string): string {
  if (!isValidDoseTime(time)) return time;
  const [h, m] = time.split(':').map((n) => parseInt(n, 10));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Sort schedule chronologically; stable for equal times. */
export function sortDoseSchedule(schedule: MedicationDose[]): MedicationDose[] {
  return [...schedule].sort((a, b) => {
    const ma = timeToMinutes(a.time);
    const mb = timeToMinutes(b.time);
    if (ma !== mb) return ma - mb;
    return a.id.localeCompare(b.id);
  });
}

/** Sum of dose amounts (total daily consumption). */
export function totalDailyAmount(schedule: MedicationDose[]): number {
  return schedule.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
}

/**
 * Map a medication (legacy or new) to a UI-ready schedule.
 * Legacy: one row from dailyDose + reminderTime (default 09:00).
 * New: use stored doseSchedule when present and non-empty.
 */
export function getDoseScheduleForUI(
  med: Pick<Medication, 'dailyDose' | 'reminderTime' | 'dosesPerDay' | 'doseSchedule'>
): MedicationDose[] {
  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    return med.doseSchedule.map((d) => ({
      id: d.id || generateId('dose'),
      amount: Number(d.amount) > 0 ? Number(d.amount) : 1,
      time: normalizeTimeString(d.time || '09:00'),
    }));
  }
  const amount = Number(med.dailyDose) > 0 ? Number(med.dailyDose) : 1;
  const time =
    med.reminderTime && isValidDoseTime(med.reminderTime)
      ? normalizeTimeString(med.reminderTime)
      : '09:00';
  return [
    {
      id: generateId('dose'),
      amount,
      time,
    },
  ];
}

/**
 * Build / resize a working schedule when the user changes dosesPerDay.
 * Preserves existing rows when increasing; keeps the first N when decreasing.
 * New rows get default times and amount 1.
 */
export function resizeDoseSchedule(
  current: MedicationDose[],
  dosesPerDay: number
): MedicationDose[] {
  const n = Math.max(1, Math.min(MAX_DOSES_PER_DAY, Math.floor(dosesPerDay) || 1));
  if (current.length === n) return current;
  if (current.length > n) {
    return current.slice(0, n);
  }
  const next = [...current];
  const usedTimes = new Set(next.map((d) => normalizeTimeString(d.time)));
  for (let i = next.length; i < n; i++) {
    let time = DEFAULT_DOSE_TIMES[i] ?? '09:00';
    if (usedTimes.has(time)) {
      const fallback = DEFAULT_DOSE_TIMES.find((t) => !usedTimes.has(t));
      if (fallback) time = fallback;
    }
    usedTimes.add(time);
    next.push({
      id: generateId('dose'),
      amount: 1,
      time,
    });
  }
  return next;
}

export type DoseScheduleValidationError =
  | 'invalid_count'
  | 'empty_schedule'
  | 'length_mismatch'
  | 'invalid_amount'
  | 'invalid_time'
  | 'duplicate_time';

export interface DoseScheduleValidationResult {
  ok: boolean;
  error?: DoseScheduleValidationError;
  message?: string;
  /** Normalized schedule ready to persist (sorted, padded times) when ok. */
  schedule?: MedicationDose[];
  dailyDose?: number;
  dosesPerDay?: number;
  /** Earliest time — kept as reminderTime for Phase-1 single-reminder compat. */
  reminderTime?: string;
}

/**
 * Validate and normalize a working schedule before save.
 * Rejects zero/negative amounts, invalid times, and duplicate times.
 */
export function validateAndNormalizeDoseSchedule(
  dosesPerDay: number,
  schedule: MedicationDose[]
): DoseScheduleValidationResult {
  const n = Math.floor(Number(dosesPerDay));
  if (!Number.isFinite(n) || n < 1 || n > MAX_DOSES_PER_DAY) {
    return {
      ok: false,
      error: 'invalid_count',
      message: 'عدد مرات تناول الدواء يومياً يجب أن يكون بين 1 و 6',
    };
  }
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return {
      ok: false,
      error: 'empty_schedule',
      message: 'يرجى تحديد جدول الجرعات',
    };
  }
  if (schedule.length !== n) {
    return {
      ok: false,
      error: 'length_mismatch',
      message: 'عدد صفوف الجرعات يجب أن يساوي عدد المرات اليومية',
    };
  }

  const normalized: MedicationDose[] = [];
  const seenTimes = new Set<string>();

  for (let i = 0; i < schedule.length; i++) {
    const row = schedule[i];
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        ok: false,
        error: 'invalid_amount',
        message: `كمية الجرعة ${i + 1} يجب أن تكون أكبر من صفر`,
      };
    }
    if (!isValidDoseTime(row.time)) {
      return {
        ok: false,
        error: 'invalid_time',
        message: `ميعاد الجرعة ${i + 1} غير صالح`,
      };
    }
    const time = normalizeTimeString(row.time);
    if (seenTimes.has(time)) {
      return {
        ok: false,
        error: 'duplicate_time',
        message: 'لا يمكن تكرار نفس الميعاد لجرعتين',
      };
    }
    seenTimes.add(time);
    normalized.push({
      id: row.id || generateId('dose'),
      amount,
      time,
    });
  }

  const sorted = sortDoseSchedule(normalized);
  const dailyDose = totalDailyAmount(sorted);
  return {
    ok: true,
    schedule: sorted,
    dailyDose,
    dosesPerDay: sorted.length,
    reminderTime: sorted[0]?.time ?? '09:00',
  };
}
