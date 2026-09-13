import { Medication, ConsumptionLog } from '../types';
import {
  getTodayDateString,
  effectiveCurrentPills,
  computeDueDoseBreakdown,
  mutationSettlementLastSyncDate,
  recordDoseConsumed,
  isDoseConsumedOnDate,
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
 * - handleRestoreDose (delta = +resolved dose amount, not always dailyDose)
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

/**
 * Resolve how many units to restore for a skipped dose.
 *
 * - Multi-dose (doseSchedule present): uses the slot amount for `doseId`.
 *   Requires an explicit doseId when there is more than one slot (no
 *   silent dailyDose fallback).
 * - Single-slot schedule with omitted doseId: uses that slot's amount.
 * - Legacy (no schedule): uses dailyDose (unchanged).
 */
export function resolveRestoreDoseAmount(
  med: Medication,
  doseId?: string
): { ok: true; amount: number; doseId?: string } | { ok: false; amount: 0; reason: 'missing_dose_id' | 'invalid_dose_id' | 'no_dose' } {
  const schedule = med.doseSchedule;
  if (Array.isArray(schedule) && schedule.length > 0) {
    if (!doseId) {
      if (schedule.length === 1) {
        const only = schedule[0];
        const amount = Number(only.amount) || 0;
        if (amount <= 0) return { ok: false, amount: 0, reason: 'no_dose' };
        return { ok: true, amount, doseId: only.id };
      }
      return { ok: false, amount: 0, reason: 'missing_dose_id' };
    }
    const slot = schedule.find((d) => d.id === doseId);
    if (!slot) return { ok: false, amount: 0, reason: 'invalid_dose_id' };
    const amount = Number(slot.amount) || 0;
    if (amount <= 0) return { ok: false, amount: 0, reason: 'no_dose' };
    return { ok: true, amount, doseId: slot.id };
  }
  const amount = Number(med.dailyDose) || 0;
  if (amount <= 0) return { ok: false, amount: 0, reason: 'no_dose' };
  return { ok: true, amount };
}

interface ConsumeDoseResult {
  /** The new medication object, or null if no dose was consumed (balance already 0). */
  updatedMed: Medication | null;
  /** The dose amount actually consumed (clamped to effective balance). */
  doseAmount: number;
  /** The consumption log to prepend (or null if no dose was consumed). */
  log: ConsumptionLog | null;
  /**
   * Present when no dose was consumed due to identity failure on a multi-dose
   * schedule (mirrors {@link resolveRestoreDoseAmount} reasons).
   * Omitted for legacy zero-balance / already-consumed cases.
   */
  reason?: 'missing_dose_id' | 'invalid_dose_id' | 'no_dose' | 'already_consumed';
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
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  const multi = schedule.length > 0;

  // Resolve which dose slot is being consumed.
  // Multi-dose identity is strict: medicationId + doseId + date.
  // - length > 1: doseId is required (no "first unconsumed" / index / time guess).
  // - length === 1: omitted doseId resolves to that slot's real id (compat).
  // - empty schedule (legacy): dailyDose + lastConsumedDate, no doseId.
  let targetDoseId = doseId;
  let targetAmount = med.dailyDose;
  if (multi) {
    let target =
      targetDoseId != null && targetDoseId !== ''
        ? schedule.find((d) => d.id === targetDoseId)
        : undefined;

    if (!target) {
      if (targetDoseId != null && targetDoseId !== '') {
        // Explicit but unknown id
        return {
          updatedMed: null,
          doseAmount: 0,
          log: null,
          reason: 'invalid_dose_id',
        };
      }
      if (schedule.length === 1) {
        target = schedule[0];
      } else {
        return {
          updatedMed: null,
          doseAmount: 0,
          log: null,
          reason: 'missing_dose_id',
        };
      }
    }

    if (isDoseConsumedOnDate(med, target.id, todayStr)) {
      return {
        updatedMed: null,
        doseAmount: 0,
        log: null,
        reason: 'already_consumed',
      };
    }
    targetDoseId = target.id;
    targetAmount = Number(target.amount) || 0;
    if (targetAmount <= 0) {
      return {
        updatedMed: null,
        doseAmount: 0,
        log: null,
        reason: 'no_dose',
      };
    }
  } else if (med.lastConsumedDate === todayStr) {
    return {
      updatedMed: null,
      doseAmount: 0,
      log: null,
      reason: 'already_consumed',
    };
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

  let doseConsumption = med.doseConsumption;
  let doseConsumptionHistory = med.doseConsumptionHistory;
  if (multi && targetDoseId) {
    const recorded = recordDoseConsumed(med, targetDoseId, todayStr);
    doseConsumption = recorded.doseConsumption;
    doseConsumptionHistory = recorded.doseConsumptionHistory;
  }

  const allSlotsConsumedToday =
    multi &&
    !!med.doseSchedule &&
    med.doseSchedule.every((d) =>
      isDoseConsumedOnDate(
        {
          ...med,
          doseConsumption,
          doseConsumptionHistory,
        },
        d.id,
        todayStr
      )
    );

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
    ...(multi
      ? { doseConsumption, doseConsumptionHistory }
      : {}),
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
