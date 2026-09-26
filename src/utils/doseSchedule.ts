/**
 * Multi-dose schedule helpers.
 *
 * These helpers prepare and validate the explicit doseSchedule / dosesPerDay
 * model without introducing a second persisted source for dose timing.
 *
 * Source of truth:
 *   When a non-empty `doseSchedule` is present, `doseSchedule.length` is
 *   authoritative for the number of dose events. `dosesPerDay` is the
 *   persisted/derived count and is kept in sync on save
 *   (`dosesPerDay === doseSchedule.length`).
 */
import type { Medication, MedicationDose } from '../types';
import { generateId } from './id';
import { timeToMinutes, isValidTimeHhmm } from './time';
import {
  normalizeDoseId,
  normalizeDoseDescription,
  normalizeDoseTimeValue,
  validateMedicationDose,
} from './doseIdentity';
import { isDoseConsumedOnDate, isDoseSkippedOnDate, getTodayDateString } from './dateCalculations';
/**
 * Auto-Deduction active for a medication based solely on its own preference.
 * Runtime Auto follows medication.autoDeductEnabled. The documented model
 * default is ON: an omitted/undefined `autoDeductEnabled` resolves to
 * enabled, an explicit `false` is OFF, an explicit `true` is ON. This
 * helper is the SINGLE policy source — schedule definition and elapsed-dose
 * completion must consume it instead of re-deriving the default (#499).
 */
export function isMedicationAutoDeductActive(
  medication: Medication
): boolean {
  return medication.autoDeductEnabled !== false;
}
/** Sensible UI maximum for doses per day (compact mobile form). */
export const MAX_DOSES_PER_DAY = 12;
/**
 * Default times used when expanding the schedule (HH:mm).
 * Must already be chronological so empty/resized schedules display in order
 * without relying solely on save-time sorting.
 */
export const DEFAULT_DOSE_TIMES = [
  '08:00',
  '10:00',
  '12:00',
  '14:00',
  '16:00',
  '18:00',
  '20:00',
  '21:00',
  '22:00',
  '22:30',
  '23:00',
  '23:30',
] as const;
/** True if the string is a valid strict 24h HH:mm (canonical persisted contract). */
export function isValidDoseTime(time: string): boolean {
  return isValidTimeHhmm(time);
}
/**
 * Normalize to zero-padded HH:mm. Accepts valid H:mm/HH:mm input (UI
 * boundary) so form input is padded before strict validation; invalid
 * input is returned unchanged for the caller to reject.
 */
export function normalizeTimeString(time: string): string {
  const padded = normalizeDoseTimeValue(time);
  return padded ?? time;
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
 * Map a medication to a UI-ready schedule from explicit `doseSchedule` only.
 *
 * No synthetic rows from dailyDose or any medication-level time field. Empty/missing schedule → [].
 * Existing valid ids/amounts/times are preserved. Rows without a valid
 * persisted id are excluded rather than assigned a new identity during a read.
 */
export function getDoseScheduleForUI(
  med: Pick<Medication, 'doseSchedule'>
): MedicationDose[] {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return [];
  }
  return sortDoseSchedule(
    med.doseSchedule
      .map((d) => {
        const result = validateMedicationDose(d);
        return result.ok ? result.dose : null;
      })
      .filter((d): d is MedicationDose => d !== null)
  );
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
  const next = current.map((d) => ({ ...d })); // shallow copy; keep same row data
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
      message: `عدد مرات تناول الدواء يومياً يجب أن يكون بين 1 و ${MAX_DOSES_PER_DAY}`,
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
    if (!row) {
      return {
        ok: false,
        error: 'invalid_amount',
        message: 'كمية الجرعة ' + (i + 1) + ' غير صالحة',
      };
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        ok: false,
        error: 'invalid_amount',
        message: `كمية الجرعة ${i + 1} يجب أن تكون أكبر من صفر`,
      };
    }
    if (!isValidDoseTime(normalizeTimeString(row.time))) {
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
      id: normalizeDoseId(row.id) || generateId('dose'),
      amount,
      time,
      ...(normalizeDoseDescription(row.description) !== undefined
        ? { description: normalizeDoseDescription(row.description) }
        : {}),
    });
  }
  const sorted = sortDoseSchedule(normalized);
  const dailyDose = totalDailyAmount(sorted);
  return {
    ok: true,
    schedule: sorted,
    dailyDose,
    dosesPerDay: sorted.length,
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
 *
 * Auto-elapsed completion uses the effective Auto-Deduct state when provided
 * (`autoDeductActive`); when the option is omitted,
 * `autoDeductEnabled !== false` uses the current default.
 * The default remains the medication-level preference; callers that know the
 * global master state should pass the effective value explicitly.
 */
export function isDoseCompletedToday(
  med: Medication,
  dose: MedicationDose,
  todayStr: string = getTodayDateString(),
  now: Date = new Date(),
  /** Effective auto-deduct (global ∧ medication). When omitted, medication-level only. */
  autoDeductActive?: boolean
): boolean {
  if (isDoseConsumedOnDate(med, dose.id, todayStr)) {
    return true;
  }
  // Restored/skipped after auto-deduct: available for Take; not "completed".
  if (isDoseSkippedOnDate(med, dose.id, todayStr)) {
    return false;
  }
  const autoActive =
    autoDeductActive !== undefined
      ? autoDeductActive
      : isMedicationAutoDeductActive(med);
  if (autoActive && isDoseTimeElapsedToday(dose.time, now)) {
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
 * Without an explicit doseSchedule, returns 0.
 * For multi-dose medications, returns the amount of the next scheduled dose.
 */
export function getNextDoseAmount(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString()
): number {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return 0;
  }
  const nextDose = getNextScheduledDose(med, now, todayStr);
  if (nextDose && Number(nextDose.amount) > 0) {
    return Number(nextDose.amount);
  }
  return Number(med.doseSchedule[0]?.amount) || 0;
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
 * Effective Auto-Deduct state controls whether elapsed time alone marks a slot
 * completed. Callers may supply the global kill-switch-aware effective value;
 * the default remains the medication-level preference.
 *
 * Without doseSchedule: no toggle target.
 */
export function getCardDoseToggleTarget(
  med: Medication,
  now: Date = new Date(),
  todayStr: string = getTodayDateString(),
  autoDeductActive: boolean = isMedicationAutoDeductActive(med)
): {
  doseId?: string;
  amount: number;
  canTake: boolean;
  canRestore: boolean;
} {
  const autoActive = autoDeductActive;
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  if (schedule.length === 0) {
    return { amount: 0, canTake: false, canRestore: false };
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
  //    Uses medication-level auto state for elapsed completion.
  for (const d of sorted) {
    if (!isDoseCompletedToday(med, d, todayStr, now, autoActive)) {
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
  return nominal
    ? {
        doseId: nominal.id,
        amount: Number(nominal.amount) || 0,
        canTake: false,
        canRestore: false,
      }
    : {
        amount: 0,
        canTake: false,
        canRestore: false,
      };
}