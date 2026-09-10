import { Medication, ConsumptionLog } from '../types';
import { getTodayDateString, effectiveCurrentPills } from './dateCalculations';
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
  todayStr: string = getTodayDateString()
): SettleAndAdjustResult {
  const effPills = effectiveCurrentPills(med, todayStr);
  const newSnapshot = Math.max(0, effPills + delta);
  return {
    updatedMed: {
      ...med,
      currentPills: newSnapshot,
      lastSyncDate: todayStr,
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
  todayStr: string = getTodayDateString()
): ConsumeDoseResult {
  const effPills = effectiveCurrentPills(med, todayStr);
  const doseAmount = Math.min(med.dailyDose, effPills);
  if (doseAmount <= 0) {
    return { updatedMed: null, doseAmount: 0, log: null };
  }
  const newSnapshot = Math.max(0, effPills - doseAmount);
  const updatedMed: Medication = {
    ...med,
    currentPills: newSnapshot,
    lastConsumedDate: todayStr,
    lastSyncDate: todayStr,
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
  };
  return { updatedMed, doseAmount, log };
}
