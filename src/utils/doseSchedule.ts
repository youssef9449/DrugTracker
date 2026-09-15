/**
 * Multi-dose schedule helpers (Phase 1).
 *
 * These helpers prepare and validate doseSchedule / dosesPerDay without
 * changing auto-deduction or notification scheduling. The existing
 * engine continues to use `dailyDose` (total units per day) and a single
 * `reminderTime`.
 *
 * Source of truth:
 *   When a non-empty `doseSchedule` is present, `doseSchedule.length` is
 *   authoritative for the number of dose events. `dosesPerDay` is the
 *   persisted/derived count and is kept in sync on save
 *   (`dosesPerDay === doseSchedule.length`).
 */
import type { Medication, MedicationDose } from '../types';
import { generateId } from './id';
import { timeToMinutes } from './time';
import { isDoseConsumedOnDate, isDoseSkippedOnDate, getTodayDateString } from './dateCalculations';

/** Sensible UI maximum for doses per day (compact mobile form). */
export const MAX_DOSES_PER_DAY = 6;

/**
 * Default times used when expanding the schedule (HH:mm).
 * Must already be chronological so empty/resized schedules display in order
 * without relying solely on save-time sorting.
 */
export const DEFAULT_DOSE_TIMES = [
  '08:00',
  '12:00',
  '14:00',
  '18:00',
  '21:00',
  '22:00',
] as const;

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
 *
 * Source-of-truth rule:
 *   If a non-empty stored `doseSchedule` exists, it is authoritative
 *   (including its length). `dosesPerDay` is ignored when the two disagree.
 *   Legacy meds without a schedule map to one row from dailyDose + reminderTime
 *   (default time 09:00 when reminderTime is missing/invalid).
 *
 * Existing dose IDs are preserved; missing IDs get a new stable id once.
 */
export function getDoseScheduleForUI(
  med: Pick<Medication, 'dailyDose' | 'reminderTime' | 'dosesPerDay' | 'doseSchedule'>
): MedicationDose[] {
  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    // Defensive chronological order for legacy/corrupted/unsorted stored data.
    // Length remains authoritative; ids/amounts/times are preserved.
    return sortDoseSchedule(
      med.doseSchedule.map((d) => ({
        id: d.id || generateId('dose'),
        amount: Number(d.amount) > 0 ? Number(d.amount) : 1,
        time: normalizeTimeString(d.time || '09:00'),
      }))
    );
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
 *
 * - Increasing: existing rows are preserved (same id/amount/time objects);
 *   new rows get amount 1 and unused chronological default times.
 *   Result is sorted chronologically so the in-memory UI is already ordered.
 * - Decreasing: keeps the first N rows of the current array unmodified;
 *   extra rows are dropped.
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

  const next = current.map((d) => d); // shallow copy; keep same row objects
  const usedTimes = new Set(
    next.map((d) => normalizeTimeString(d.time)).filter((t) => isValidDoseTime(t))
  );

  for (let i = next.length; i < n; i++) {
    let time: string | undefined = DEFAULT_DOSE_TIMES.find((t) => !usedTimes.has(t));
    if (!time) {
      // All defaults taken — step +1h from last used, wrapping within the day.
      let minutes = 8 * 60;
      if (usedTimes.size > 0) {
        const maxUsed = Math.max(
          ...[...usedTimes].map((t) => timeToMinutes(t)).filter((m) => m >= 0)
        );
        minutes = (maxUsed + 60) % (24 * 60);
      }
      // Find a free slot
      for (let attempt = 0; attempt < 24 * 60; attempt++) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        const candidate = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        if (!usedTimes.has(candidate)) {
          time = candidate;
          break;
        }
        minutes = (minutes + 60) % (24 * 60);
      }
      time = time ?? '09:00';
    }
    usedTimes.add(time);
    next.push({
      id: generateId('dose'),
      amount: 1,
      time,
    });
  }

  // Keep in-memory schedule chronological after growth (IDs/amounts/times of
  // existing rows are unchanged; only order may change).
  return sortDoseSchedule(next);
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
 * On success, `dosesPerDay` is always `schedule.length` (source of truth).
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

/**
 * Returns true if the dose time has already passed today based on local wall clock.
 */
export function isDoseTimeElapsedToday(
  timeStr: string,
  now: Date = new Date()
): boolean {
  const tMin = timeToMinutes(timeStr);
  if (tMin < 0) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= tMin;
}

/**
 * Returns true if a dose slot is completed today (either manually consumed or auto-deducted because its time elapsed).
 */
export function isDoseCompletedToday(
  med: Medication,
  dose: MedicationDose,
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): boolean {
  if (isDoseConsumedOnDate(med, dose.id, todayStr)) {
    return true;
  }
  // Restored/skipped after auto-deduct: available for Take; not "completed".
  if (isDoseSkippedOnDate(med, dose.id, todayStr)) {
    return false;
  }
  if (med.autoDeductEnabled !== false && isDoseTimeElapsedToday(dose.time, now)) {
    return true;
  }
  return false;
}

/**
 * Finds the next scheduled dose that the user is supposed to take right now.
 * 1. Prioritizes the earliest upcoming dose today that is neither consumed nor elapsed (auto-deducted).
 * 2. If all remaining unconsumed doses have elapsed (e.g. autoDeduct is false or fallback), picks the earliest unconsumed dose.
 */
export function getNextScheduledDose(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): MedicationDose | null {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return null;
  }
  const schedule = sortDoseSchedule(med.doseSchedule);

  // 1. Next upcoming available dose (not consumed and not auto-deducted)
  const nextAvailable = schedule.find(
    (d) => !isDoseCompletedToday(med, d, todayStr, now)
  );
  if (nextAvailable) {
    return nextAvailable;
  }

  // 2. Fallback: earliest unconsumed dose (if any)
  const unconsumed = schedule.find(
    (d) => !isDoseConsumedOnDate(med, d.id, todayStr)
  );
  if (unconsumed) {
    return unconsumed;
  }

  // 3. If all doses consumed/done, return the first schedule row as nominal fallback
  return schedule[0] || null;
}

/**
 * Returns the dose amount for the next upcoming dose.
 * For single-dose medications without a schedule, returns `med.dailyDose`.
 * For multi-dose medications, returns the amount of the next scheduled dose.
 */
export function getNextDoseAmount(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): number {
  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    const nextDose = getNextScheduledDose(med, now, todayStr);
    if (nextDose && Number(nextDose.amount) > 0) {
      return Number(nextDose.amount);
    }
    return (
      Number(med.doseSchedule[0]?.amount) || Number(med.dailyDose) || 1
    );
  }
  return Number(med.dailyDose) || 1;
}


/**
 * Resolve the MedicationCard Take/Restore toggle target for one dose slot.
 *
 * Distinct from {@link getNextScheduledDose} / {@link getNextDoseAmount}:
 * those answer "what is the next dose to take in the schedule".
 * This helper answers "which single doseId should the Card toggle right now".
 *
 * Priority:
 * 1. **Manual consume wins:** first chronological dose with
 *    {@link isDoseConsumedOnDate} today → Restore that same doseId
 *    (`canRestore`, not Take). Later incomplete slots do NOT steal the
 *    target — Take d1 is immediately reversible even while d2/d3 are open.
 *    Auto-deduct-only completion is never a restore target (no consume mark).
 * 2. Else first incomplete slot ({@link isDoseCompletedToday} false) → Take.
 *    Skipped/restored slots are incomplete again so Take d1 works after Restore.
 * 3. All completed via auto-deduct only → non-interactive (no fake restore).
 *
 * Legacy (no schedule): lastConsumedDate / dailyDose.
 */
export function getCardDoseToggleTarget(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): {
  doseId?: string;
  amount: number;
  canTake: boolean;
  canRestore: boolean;
} {
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  if (schedule.length === 0) {
    const taken = med.lastConsumedDate === todayStr;
    const amount = Number(med.dailyDose) || 1;
    return {
      amount,
      canTake: !taken && amount > 0,
      canRestore: taken,
    };
  }

  const sorted = sortDoseSchedule(schedule);

  // 1) Manual consume today → Restore that doseId (chronological first).
  //    Independent of whether later slots are still incomplete.
  for (const d of sorted) {
    if (isDoseConsumedOnDate(med, d.id, todayStr)) {
      const amount = Number(d.amount) || 0;
      return {
        doseId: d.id,
        amount,
        canTake: false,
        canRestore: amount > 0,
      };
    }
  }

  // 2) No restorable manual mark → first incomplete slot for Take.
  for (const d of sorted) {
    if (!isDoseCompletedToday(med, d, todayStr, now)) {
      const amount = Number(d.amount) || 0;
      return {
        doseId: d.id,
        amount,
        canTake: amount > 0,
        canRestore: false,
      };
    }
  }

  // 3) All completed via auto-deduct only — no fake restore
  const nominal = sorted[0];
  return {
    doseId: nominal?.id,
    amount: Number(nominal?.amount) || Number(med.dailyDose) || 0,
    canTake: false,
    canRestore: false,
  };
}
