import { Medication, ConsumptionLog } from '../types';
import {
  getTodayDateString,
  getLocalDateString,
  recordDoseConsumed,
  isDoseConsumedOnDate,
  clearDoseSkippedOnDate,
  recordDoseSkipped,
  hasDoseSchedule,
} from './dateCalculations';
import { isDoseTimeElapsedToday } from './doseSchedule';
import { generateId } from './id';
import { exactAutoLogId } from './autoDeductionReconciliation';
/**
 * Shared medication-action helpers.
 * Manual stock mutations use `applyDurableStockDelta` — a simple helper that
 * applies a signed delta to `med.currentPills` with a zero clamp. There is NO
 * elapsed-day settlement and NO read-time stock projection inside manual
 * mutations. The durable `currentPills` is the single source of truth for
 * manual stock changes.
 */
/**
 * Apply a signed stock delta to a medication's durable `currentPills`.
 * - base = `Math.max(0, med.currentPills)` (never negative).
 * - positive delta increases the balance; negative delta decreases it.
 * - result clamped at zero.
 * - No elapsed-day settlement is performed as part of the manual mutation.
 * @param med The medication to adjust.
 * @param delta The signed pill delta (positive for restore/refill, negative
 *   for consume).
 */
export function applyDurableStockDelta(
  med: Medication,
  delta: number
): Medication {
  const base = Math.max(0, med.currentPills);
  const newPills = Math.max(0, base + delta);
  return { ...med, currentPills: newPills };
}
/**
 * Resolve the doseId for a restore operation. Only identity is resolved —
 * the restore amount comes from durable deduction evidence, NOT the current
 * schedule.
 * - Multi-dose (doseSchedule with >1 slot): explicit doseId required.
 * - Single-slot schedule: omitted doseId resolves to that slot's id.
 * - No doseSchedule: reject.
 */
export function resolveRestoreDoseId(
  med: Medication,
  doseId?: string
):
  | { ok: true; doseId: string }
  | { ok: false; reason: 'missing_dose_id' | 'invalid_dose_id' | 'no_dose' } {
  const schedule = med.doseSchedule;
  if (!Array.isArray(schedule) || schedule.length === 0) {
    // No doseSchedule: cannot restore an occurrence.
    // A stale explicit doseId is invalid_dose_id; otherwise no_dose.
    if (doseId != null && doseId !== '') {
      return { ok: false, reason: 'invalid_dose_id' };
    }
    return { ok: false, reason: 'no_dose' };
  }
  if (!doseId) {
    if (schedule.length === 1) {
      return { ok: true, doseId: schedule[0].id };
    }
    return { ok: false, reason: 'missing_dose_id' };
  }
  const slot = schedule.find((d) => d.id === doseId);
  if (!slot) return { ok: false, reason: 'invalid_dose_id' };
  return { ok: true, doseId: slot.id };
}
export type RestoreDoseResult =
  | {
      ok: true;
      updatedMed: Medication;
      restoredAmount: number;
      doseId?: string;
      /**
       * True when undoing a durable consumption marker (Manual Take or Exact Auto).
       */
      wasActuallyConsumed: boolean;
      /**
       * The id of the ACTIVE deduction log (exact_auto / dose_taken) that this
       * Restore reverses. The caller MUST mark that log's `reversedAt` and
       * create the restore (skipped_day) log with `relatedLogId` pointing to
       * this id.
       */
      reversedLogId?: string;
    }
  | {
      ok: false;
      reason:
        | 'missing_dose_id'
        | 'invalid_dose_id'
        | 'no_dose'
        | 'auto_deduct_off'
        | 'already_restored'
        | 'missing_deduction_evidence';
    };
/**
 * Find the ACTIVE (un-reversed) deduction log for one occurrence
 * (medicationId + doseId + calendarDate). "Active" = the deduction whose
 * stock effect is still in place and can be reversed by a Restore.
 * A deduction log is active when it has NO `reversedAt` marker. Once a
 * Restore reverses a deduction, that deduction log is marked `reversedAt`
 * and is skipped here so a later Restore finds the NEXT active deduction.
 * accepted deduction types for an occurrence:
 *   - dose_taken: manual deduction (existing doseId checks)
 *   - exact_auto: current Exact Auto, ONLY when log.id is the deterministic
 *     Exact occurrence id (`exact-auto:<medicationId>:<doseId>:<calendarDate>`)
 *     the same deterministic Exact occurrence id
 * Determinism contract — does NOT depend on array position:
 *   The most-recent active deduction is selected by comparing the log's
 *   own persisted data (timestamp primary, id tie-breaker).
 */
export function findActiveDeductionForOccurrence(
  logs: ConsumptionLog[],
  medicationId: string,
  doseId: string,
  calendarDate: string
): ConsumptionLog | null {
  // doseId is required.
  // Trim before matching so '   ' rejects and ' d1 ' normalizes to 'd1'.
  const normalizedDoseId =
    doseId == null ? '' : String(doseId).trim();
  if (!normalizedDoseId) return null;
  const expectedExactId = exactAutoLogId(
    medicationId,
    normalizedDoseId,
    calendarDate
  );
  let best: ConsumptionLog | null = null;
  let bestEpoch = -Infinity;
  let bestId = '';
  for (const l of logs) {
    if (l.medicationId !== medicationId) continue;
    if (l.date !== calendarDate) continue;
    // dose_taken is manual evidence. exact_auto and
    const isManualDeduction = l.type === 'dose_taken';
    const isExactOccurrenceEvidence =
      (l.type === 'exact_auto') &&
      l.id === expectedExactId;
    if (!isManualDeduction && !isExactOccurrenceEvidence) continue;
    if (l.reversedAt) continue; // already reversed by a prior Restore
    const logDoseRaw =
      l.doseId != null && String(l.doseId).trim() !== ''
        ? String(l.doseId).trim()
        : null;
    // require explicit non-empty doseId on the log — no
    // No fallback matching is permitted.
    if (logDoseRaw !== normalizedDoseId) continue;
    const parsed = Date.parse(l.timestamp ?? '');
    const epoch = Number.isFinite(parsed) ? parsed : -Infinity;
    const id = l.id ?? '';
    const isMoreRecent =
      best === null ||
      epoch > bestEpoch ||
      (epoch === bestEpoch && id > bestId);
    if (isMoreRecent) {
      best = l;
      bestEpoch = epoch;
      bestId = id;
    }
  }
  return best;
}
/**
 * UI-only: historical Restore amount for display from exact active deduction
 * evidence (medicationId + doseId + calendarDate). Returns null when no active
 * dose_taken / exact_auto log exists.
 */
export function getHistoricalRestoreDisplayAmount(
  logs: ConsumptionLog[],
  medicationId: string,
  doseId: string | undefined,
  calendarDate: string
): number | null {
  const normalized =
    doseId == null ? '' : String(doseId).trim();
  if (!normalized) return null;
  const active = findActiveDeductionForOccurrence(
    logs,
    medicationId,
    normalized,
    calendarDate
  );
  if (!active) return null;
  const n = Math.abs(Number(active.amount) || 0);
  return n > 0 ? n : null;
}
/**
 * Whether a log represents Exact Auto deduction evidence for the requested
 * occurrence.
 * Decision table:
 *   exact_auto  → valid only when log.id === exactAutoLogId(...)
 *   other types → invalid
 * Malformed exact_auto records with arbitrary ids are NOT evidence.
 */
export function isExactAutoDeductionEvidence(
  log: ConsumptionLog,
  medicationId: string,
  doseId: string,
  calendarDate: string
): boolean {
  if (log.type !== 'exact_auto') return false;
  const normalizedDoseId =
    doseId == null ? '' : String(doseId).trim();
  if (!normalizedDoseId) return false;
  return (
    log.id ===
    exactAutoLogId(medicationId, normalizedDoseId, calendarDate)
  );
}
/**
 * UI-only: Auto historical Restore (consumed + Exact Auto evidence + valid amount).
 * Accepts current `exact_auto` logs with deterministic occurrence id.
 */
export function isUiAutoHistoricalRestoreEligible(
  consumed: boolean,
  skipped: boolean,
  activeDeduction: ConsumptionLog | null | undefined,
  historicalAmount: number | null,
  medicationId: string,
  doseId: string,
  calendarDate: string
): boolean {
  return (
    consumed &&
    !skipped &&
    historicalAmount != null &&
    activeDeduction != null &&
    isExactAutoDeductionEvidence(
      activeDeduction,
      medicationId,
      doseId,
      calendarDate
    )
  );
}
/**
 * UI-only: Manual (or any) consumed Restore with exact active deduction evidence.
 */
export function isUiConsumedRestoreEligible(
  consumed: boolean,
  skipped: boolean,
  historicalAmount: number | null
): boolean {
  return consumed && !skipped && historicalAmount != null;
}
export function findActualDeductedAmountForOccurrence(
  logs: ConsumptionLog[],
  medicationId: string,
  doseId: string | undefined,
  calendarDate: string
): number | null {
  if (!doseId) return null;
  const active = findActiveDeductionForOccurrence(logs, medicationId, doseId, calendarDate);
  return active ? Math.abs(Number(active.amount) || 0) : null;
}
/**
 * Production restore for one dose slot — exact occurrence restore only.
 * Restore reverses a durable deduction log for the occurrence
 * (medicationId + doseId + calendarDate). The restore amount is
 * `abs(log.amount)` from the active deduction log (dose_taken or exact_auto).
 * If no active deduction log exists → reject `missing_deduction_evidence`.
 * There is NO pure-projection Restore (elapsed time without a durable
 * deduction does NOT add stock). There is NO `dailyDose` fallback, NO
 * `computeDueDoseBreakdown`, NO elapsed-day settlement settlement.
 * elapsed-day settlement is NOT changed by restore.
 * Skip marker logic is preserved: when the restore date is past-due, a
 * durable skip is recorded so the same occurrence is not re-deducted by
 * Exact Auto.
 */
export function restoreDose(
  med: Medication,
  doseId?: string,
  todayStr: string = getTodayDateString(),
  now: Date = new Date(),
  logs: ConsumptionLog[] = []
): RestoreDoseResult {
  // Resolve which doseId to restore (identity only — amount comes from the log).
  const resolved = resolveRestoreDoseId(med, doseId);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }
  const resolvedDoseId = resolved.doseId;
  const wasActuallyConsumed = isDoseConsumedOnDate(med, resolvedDoseId, todayStr);
  if (med.autoDeductEnabled === false && !wasActuallyConsumed) {
    return { ok: false, reason: 'auto_deduct_off' };
  }
  // Find the ACTIVE (un-reversed) deduction for this exact occurrence.
  const activeDeduction = findActiveDeductionForOccurrence(
    logs,
    med.id,
    resolvedDoseId,
    todayStr
  );
  // Restore requires durable deduction evidence. No
  // pure-projection restore — elapsed time without a durable deduction
  // does NOT add stock.
  if (activeDeduction == null) {
    // If the occurrence was consumed but the active deduction is gone
    // (already reversed by a prior Restore), it's already_restored.
    if (wasActuallyConsumed) {
      return { ok: false, reason: 'already_restored' };
    }
    // Not consumed and no deduction: nothing to restore.
    return { ok: false, reason: 'missing_deduction_evidence' };
  }
  const restoredAmount = Math.abs(Number(activeDeduction.amount) || 0);
  if (!(restoredAmount > 0)) {
    return { ok: false, reason: 'missing_deduction_evidence' };
  }
  const reversedLogId = activeDeduction.id;
  // --- Multi-dose / scheduled slot ---
  if (hasDoseSchedule(med) && resolvedDoseId) {
    // Clear consumption for this doseId + date (if any).
    const nextHistory = { ...(med.doseConsumptionHistory ?? {}) };
    if (Array.isArray(nextHistory[resolvedDoseId])) {
      nextHistory[resolvedDoseId] = nextHistory[resolvedDoseId].filter(
        (d) => d !== todayStr
      );
      if (nextHistory[resolvedDoseId].length === 0) {
        delete nextHistory[resolvedDoseId];
      }
    }
    const slot = med.doseSchedule!.find((d) => d.id === resolvedDoseId);
    // Past-due relative to `now`: prior calendar day, or today after slot time.
    const nowLocalDate = getLocalDateString(now);
    const restoreDateIsPastDay = todayStr < nowLocalDate;
    const timeElapsedToday =
      slot != null && isDoseTimeElapsedToday(slot.time, now);
    const isPastDueForSkip = restoreDateIsPastDay || timeElapsedToday;
    // Restore after Auto/Manual Take: when the scheduled time has already
    // passed, leave a durable skip marker so Exact Auto cannot re-trigger a
    // second deduction for this occurrence after Restore. When the scheduled
    // time has NOT passed, clear any prior skip so the dose stays eligible.
    let doseSkippedHistory = med.doseSkippedHistory;
    if (wasActuallyConsumed && !isPastDueForSkip) {
      const nextSkip = { ...(med.doseSkippedHistory ?? {}) };
      if (Array.isArray(nextSkip[resolvedDoseId])) {
        nextSkip[resolvedDoseId] = nextSkip[resolvedDoseId].filter(
          (d) => d !== todayStr
        );
        if (nextSkip[resolvedDoseId].length === 0) {
          delete nextSkip[resolvedDoseId];
        }
      }
      doseSkippedHistory = nextSkip;
    } else if (isPastDueForSkip) {
      const baseForSkip: Medication = {
        ...med,
        doseConsumptionHistory: nextHistory,
      };
      doseSkippedHistory = recordDoseSkipped(
        baseForSkip,
        resolvedDoseId,
        todayStr
      ).doseSkippedHistory;
    }
    const allStillConsumed =
      Array.isArray(med.doseSchedule) &&
      med.doseSchedule.every((d) =>
        d.id === resolvedDoseId
          ? false
          : isDoseConsumedOnDate(
              {
                ...med,
                doseConsumptionHistory: nextHistory,
              },
              d.id,
              todayStr
            )
      );
    // apply the restored amount to durable currentPills only.
    // No settlement, no elapsed-day settlement change.
    const updatedMed: Medication = applyDurableStockDelta(med, restoredAmount);
    const result: Medication = {
      ...updatedMed,
      doseConsumptionHistory: nextHistory,
      doseSkippedHistory,
      lastConsumedDate: allStillConsumed ? todayStr : undefined,
    };
    return {
      ok: true,
      updatedMed: result,
      restoredAmount,
      doseId: resolvedDoseId,
      wasActuallyConsumed,
      reversedLogId,
    };
  }
  // No explicit doseSchedule: cannot restore.
  return { ok: false, reason: 'no_dose' };
}
/**
 * Consume one daily dose from a medication.
 * the stock deduction is `currentPills → currentPills - doseAmount`
 * (clamped at zero). No read-time projection and no elapsed-day settlement.
 * The durable `currentPills` is the sole base.
 * Amount authority:
 * - `amountOverride` (Exact Auto FIRED event amount) when provided.
 * - Otherwise the current durable schedule slot amount.
 * - No `dailyDose` fallback when there is no doseSchedule (reject).
 * Identity:
 * - Multi-dose → explicit doseId required (or single-slot auto-resolve).
 * - No doseSchedule → reject `missing_dose_id`.
 * Metadata preserved: doseConsumptionHistory,
 * doseSkippedHistory, lastConsumedDate, dose_taken log.
 * elapsed-day settlement is NOT changed.
 */
export function consumeDose(
  med: Medication,
  source: 'alarm' | 'manual',
  todayStr: string = getTodayDateString(),
  now: Date = new Date(),
  doseId?: string,
  options?: { amountOverride?: number }
): {
  updatedMed: Medication | null;
  doseAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
} {
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  const multi = schedule.length > 0;
  const amountOverride = options?.amountOverride;
  // No doseSchedule: reject ().
  if (!multi) {
    if (doseId != null && doseId !== '') {
      return {
        updatedMed: null,
        doseAmount: 0,
        log: null,
        reason: 'invalid_dose_id',
      };
    }
    return {
      updatedMed: null,
      doseAmount: 0,
      log: null,
      reason: 'missing_dose_id',
    };
  }
  // Resolve which dose slot is being consumed.
  let targetDoseId = doseId;
  let targetAmount = 0;
  let target =
    targetDoseId != null && targetDoseId !== ''
      ? schedule.find((d) => d.id === targetDoseId)
      : undefined;
  if (!target) {
    if (targetDoseId != null && targetDoseId !== '') {
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
  // Authoritative amount: Exact Auto FIRED event amount when provided;
  // otherwise current schedule slot amount.
  if (amountOverride !== undefined) {
    const n = Number(amountOverride);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        updatedMed: null,
        doseAmount: 0,
        log: null,
        reason: 'invalid_exact_event',
      };
    }
    targetAmount = n;
  } else {
    targetAmount = Number(target.amount) || 0;
  }
  if (targetAmount <= 0) {
    return {
      updatedMed: null,
      doseAmount: 0,
      log: null,
      reason: 'no_dose',
    };
  }
  // stock deduction from durable currentPills only.
  // No settlement, no elapsed-day settlement change.
  const settleBase = Math.max(0, med.currentPills);
  const doseAmount = Math.min(targetAmount, settleBase);
  if (doseAmount <= 0) {
    return { updatedMed: null, doseAmount: 0, log: null };
  }
  const newSnapshot = Math.max(0, settleBase - doseAmount);
  let doseConsumptionHistory = med.doseConsumptionHistory;
  let doseSkippedHistory = med.doseSkippedHistory;
  if (targetDoseId) {
    const recorded = recordDoseConsumed(med, targetDoseId, todayStr);
    doseConsumptionHistory = recorded.doseConsumptionHistory;
    // Clear any prior restore/skip for this dose+date so Take after
    // Restore is a single clean manual consumption.
    const cleared = clearDoseSkippedOnDate(
      { ...med, doseSkippedHistory },
      targetDoseId,
      todayStr
    );
    doseSkippedHistory = cleared.doseSkippedHistory;
  }
  const allSlotsConsumedToday =
    !!med.doseSchedule &&
    med.doseSchedule.every((d) =>
      isDoseConsumedOnDate(
        {
          ...med,
          doseConsumptionHistory,
        },
        d.id,
        todayStr
      )
    );
  const lastConsumedDate = allSlotsConsumedToday ? todayStr : med.lastConsumedDate;
  // elapsed-day settlement is NOT changed by consume.
  const updatedMed: Medication = {
    ...med,
    currentPills: newSnapshot,
    lastConsumedDate,
    doseConsumptionHistory,
    doseSkippedHistory,
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
    timestamp: now.toISOString(),
    description,
    ...(targetDoseId ? { doseId: targetDoseId } : {}),
  };
  return { updatedMed, doseAmount, log };
}