import { Medication, ConsumptionLog } from '../types';
import {
  getTodayDateString,
  effectiveCurrentPills,
  computeDueDoseBreakdown,
  mutationSettlementLastSyncDate,
} from './dateCalculations';
import { generateId } from './id';

/**
 * Shared medication-action helpers (audit #77, #78).
 *
 * Previously the "settle snapshot at effective balance, then adjust by a
 * delta, then push a log" sequence was copy-pasted across 4 handlers in
 * App.tsx (handleRestoreDose, handleConfirmRefill, handleTakeDoseFromAlarm,
 * handleConsumeDose). These pure helpers consolidate the common logic;
 * the handlers keep their pre-guards (dedup, already-consumed-today, etc.)
 * and call into these helpers for the actual state mutation.
 */

interface SettleAndAdjustResult {
  /** The new medication object (with currentPills + lastSyncDate updated). */
  updatedMed: Medication;
  /** The delta actually applied (clamped for consume; raw for restore/refill). */
  appliedDelta: number;
}

/**
 * Settle the medication's snapshot at the current effective balance, then
 * adjust by `delta`. Returns the updated med (currentPills + lastSyncDate=today)
 * without mutating the input.
 *
 * Used by:
 * - handleRestoreDose (delta = +dailyDose)
 * - handleConfirmRefill (delta = +addedPills)
 *
 * @param med The medication to adjust.
 * @param delta The signed pill delta to apply (positive for restore/refill,
 *   negative for consume). The result is clamped at 0.
 * @param todayStr Optional "today" override (YYYY-MM-DD) — for tests.
 */
export function settleAndAdjust(
  med: Medication,
  delta: number,
  todayStr: string = getTodayDateString(),
  now: Date = new Date()
): SettleAndAdjustResult {
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);
  // For the reminderTime-gated path, settle at the PAST-only balance
  // (exclude today's projected auto-dose) so a later manual consume can
  // replace today's dose without double-deduction; today's dose stays
  // dynamic (projected by effectiveCurrentPills via todayDue) and is
  // settled at the next existing execution point (app-open sync or a
  // later mutation), NOT automatically at the calendar-day boundary.
  // For legacy, settle at the full effective balance (today included —
  // pre-change behavior).
  const settleBase = breakdown.gated
    ? Math.max(0, med.currentPills - breakdown.pastDueUnits)
    : Math.max(0, effectiveCurrentPills(med, todayStr, now));
  const newSnapshot = Math.max(0, settleBase + delta);
  const newLastSync = mutationSettlementLastSyncDate(
    todayStr,
    breakdown.consumedToday,
    breakdown.gated
  );
  return {
    updatedMed: {
      ...med,
      currentPills: newSnapshot,
      lastSyncDate: newLastSync,
    },
    appliedDelta: delta,
  };
}

interface ConsumeDoseResult {
  /** The new medication object, or null if no dose was consumed (balance already 0). */
  updatedMed: Medication | null;
  /** The dose amount actually consumed (clamped to effective balance). */
  doseAmount: number;
  /** The consumption log to prepend (or null if no dose was consumed). */
  log: ConsumptionLog | null;
}

/**
 * Consume one daily dose from a medication: settle the snapshot at the
 * effective balance, deduct the dose (clamped at 0), mark lastConsumedDate
 * = today (blocks auto-deduction for today), and produce the dose_taken log.
 *
 * Used by:
 * - handleTakeDoseFromAlarm (source: 'alarm')
 * - handleConsumeDose (source: 'manual')
 *
 * The caller is responsible for:
 *   - The already-consumed-today guard (manual path only — the alarm path
 *     has no such guard because it's the alarm firing).
 *   - setMedications / setLogs with the returned values.
 *   - The toast + chime.
 *
 * @param med The medication.
 * @param source 'alarm' or 'manual' — controls the log description text.
 * @param todayStr Optional "today" override — for tests.
 */
export function consumeDose(
  med: Medication,
  source: 'alarm' | 'manual',
  todayStr: string = getTodayDateString(),
  now: Date = new Date(),
  doseId?: string
): ConsumeDoseResult {
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);
  const multi =
    Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;

  // Resolve which dose slot is being consumed.
  // Phase 3B: UI paths (card + SelectDoseModal, alarm) should always
  // pass an explicit doseId for multi-dose meds. The fallback below
  // (earliest unconsumed schedule row) exists only for internal /
  // legacy callers that omit doseId; it is intentional, not a guess
  // from wall-clock time.
  let targetDoseId = doseId;
  let targetAmount = med.dailyDose;
  if (multi) {
    const schedule = med.doseSchedule!;
    let target = targetDoseId
      ? schedule.find((d) => d.id === targetDoseId)
      : undefined;
    if (!target) {
      // Fallback: earliest unconsumed slot for today (stable order).
      target = schedule.find((d) => med.doseConsumption?.[d.id] !== todayStr);
    }
    if (!target) {
      return { updatedMed: null, doseAmount: 0, log: null };
    }
    if (med.doseConsumption?.[target.id] === todayStr) {
      return { updatedMed: null, doseAmount: 0, log: null };
    }
    targetDoseId = target.id;
    targetAmount = Number(target.amount) || 0;
  } else if (med.lastConsumedDate === todayStr) {
    return { updatedMed: null, doseAmount: 0, log: null };
  }

  // Settle past-only for gated/multi; full effective for legacy non-gated.
  const settleBase = breakdown.gated
    ? Math.max(0, med.currentPills - breakdown.pastDueUnits)
    : Math.max(0, effectiveCurrentPills(med, todayStr, now));
  const doseAmount = Math.min(targetAmount, settleBase);
  if (doseAmount <= 0) {
    return { updatedMed: null, doseAmount: 0, log: null };
  }
  const newSnapshot = Math.max(0, settleBase - doseAmount);

  const doseConsumption: Record<string, string> = {
    ...(med.doseConsumption ?? {}),
  };
  if (multi && targetDoseId) {
    doseConsumption[targetDoseId] = todayStr;
  }

  const allSlotsConsumedToday =
    multi &&
    !!med.doseSchedule &&
    med.doseSchedule.every((d) => doseConsumption[d.id] === todayStr);

  const lastConsumedDate = !multi || allSlotsConsumedToday ? todayStr : med.lastConsumedDate;

  // Multi/gated with remaining slots today: lastSync = yesterday so past
  // days stay settled and remaining today's slots stay projectable.
  // Fully consumed (or legacy): lastSync = today.
  const lastSyncDate =
    breakdown.gated && multi && !allSlotsConsumedToday
      ? mutationSettlementLastSyncDate(todayStr, false, true)
      : todayStr;

  const updatedMed: Medication = {
    ...med,
    currentPills: newSnapshot,
    lastConsumedDate,
    lastSyncDate,
    ...(multi ? { doseConsumption } : {}),
  };
  const description =
    source === 'alarm'
      ? `تناول جرعة من التنبيه (-${doseAmount} ${med.unit})`
      : `تناول جرعة يدوياً (-${doseAmount} ${med.unit})`;
  const log: ConsumptionLog = {
    id: generateId('consume'),
    medicationId: med.id,
    medicationName: med.name,
    type: 'dose_taken',
    amount: -doseAmount,
    date: todayStr,
    timestamp: new Date().toISOString(),
    description,
    ...(targetDoseId ? { doseId: targetDoseId } : {}),
  };
  return { updatedMed, doseAmount, log };
}
