import { Medication, ConsumptionLog } from '../types';
import {
  getTodayDateString,
  effectiveCurrentPills,
  computeDueDoseBreakdown,
  mutationSettlementLastSyncDate,
  recordDoseConsumed,
  isDoseConsumedOnDate,
  clearDoseSkippedOnDate,
  recordDoseSkipped,
  hasDoseSchedule,
} from './dateCalculations';
import { isDoseTimeElapsedToday } from './doseSchedule';
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

/**
 * Production restore for one dose slot (or legacy daily dose).
 *
 * Accounting model (must match settlement / projection):
 * - Manual consume already deducted from the settled snapshot → restore
 *   adds exact amount back via settleAndAdjust and clears consumption.
 * - Auto-only (elapsed projection, never manually consumed today) never
 *   mutated currentPills for today's slot → restore records skip only.
 *   Adding to currentPills would double-count because projection already
 *   reduced effectiveCurrentPills; skip alone reverses the projection.
 *
 * Durable skip (doseSkippedHistory) is recorded when the restored
 * dose/date is already past-due relative to `now`:
 *   - the restore date is a prior calendar day, OR
 *   - the restore date is today and the slot's scheduled time has elapsed.
 * That protects the same doseId+date from a second Auto-Deduct — both
 * the projection path (todayDueUnits) and Exact Auto reconciliation
 * (isExactAutoOccurrenceApplied) treat a skipped occurrence as applied.
 * This holds for both the Auto-only path AND the wasActuallyConsumed
 * path (Auto → Restore or Manual Take → Restore after the scheduled
 * time has elapsed): without the durable skip, clearing the consume
 * marker would leave the occurrence with no marker, so it would appear
 * due again and a second Auto-Deduction could fire for the same
 * occurrence.
 *
 * When the restore date is today and the slot's scheduled time is still
 * ahead, Restore must NOT record a durable skip: the dose remains
 * eligible for normal time-gated Auto-Deduct when its time arrives
 * (todayDueUnits already requires now >= dose.time). In that future-time
 * case any prior skip for the same occurrence is cleared so Take stays
 * eligible and Auto-Deduct can still fire at the scheduled time.
 *
 * Auto → Restore → Take invariant: Take (consumeDose) clears the skip
 * marker before recording consumption, so the final durable state
 * carries exactly one deduction for the occurrence regardless of the
 * Auto → Restore intermediate.
 *
 * Identity is always medicationId + doseId + date for scheduled meds.
 */
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
       * The id of the ACTIVE deduction log (auto_daily / dose_taken) that this
       * Restore reverses. The caller MUST mark that log's `reversedAt` and
       * create the restore (skipped_day) log with `relatedLogId` pointing to
       * this id, so a later Restore finds the NEXT active deduction instead
       * of re-reversing this one. Undefined when there is no active deduction
       * log (projection-only restore or legacy fallback).
       */
      reversedLogId?: string;
    }
  | {
      ok: false;
      reason:
        | 'missing_dose_id'
        | 'invalid_dose_id'
        | 'no_dose'
        | 'auto_deduct_off';
    };

/**
 * Find the ACTIVE (un-reversed) deduction log for one occurrence
 * (medicationId + doseId + calendarDate). "Active" = the deduction whose
 * stock effect is still in place and can be reversed by a Restore.
 *
 * A deduction log (auto_daily / dose_taken) is active when it has NO
 * `reversedAt` marker. Once a Restore reverses a deduction, that deduction
 * log is marked `reversedAt` and is skipped here so a later Restore finds
 * the NEXT active deduction (e.g. after Auto → Restore → Take, the next
 * Restore finds the Take, not the already-reversed Auto).
 *
 * Logs are prepended (newest first), so the FIRST matching un-reversed
 * deduction is the most recent active one. No timestamp preference and no
 * auto_daily-over-dose_taken preference — the active deduction is whatever
 * the most recent un-reversed deduction for that EXACT occurrence is.
 *
 * This replaces the previous "prefer auto_daily" heuristic, which could
 * return a stale historical deduction (already reversed by a Restore) and
 * inflate stock on a later Restore.
 *
 * Multi-dose identity is strict: doseId must match (or both legacy) so a
 * Restore for dose A can never reverse dose B's deduction.
 */
export function findActiveDeductionForOccurrence(
  logs: ConsumptionLog[],
  medicationId: string,
  doseId: string | undefined,
  calendarDate: string
): ConsumptionLog | null {
  for (const l of logs) {
    if (l.medicationId !== medicationId) continue;
    if (l.date !== calendarDate) continue;
    if (l.type !== 'dose_taken' && l.type !== 'auto_daily') continue;
    if (l.reversedAt) continue; // already reversed by a prior Restore
    const logDose =
      l.doseId != null && String(l.doseId) !== '' ? String(l.doseId) : null;
    if (doseId != null && doseId !== '' && doseId !== 'legacy') {
      // Multi-dose: require matching doseId on the log.
      if (logDose !== doseId) continue;
    } else {
      // Legacy / single: accept logs without doseId or with legacy id.
      if (logDose != null && logDose !== 'legacy' && logDose !== doseId) continue;
    }
    return l; // most recent un-reversed deduction for this occurrence
  }
  return null;
}

/**
 * Resolve the actual units previously deducted for this occurrence from logs
 * (Manual dose_taken / Exact Auto auto_daily). Log amount is stored as negative.
 * Falls back to null when no durable stock mutation log exists.
 *
 * @deprecated prefer {@link findActiveDeductionForOccurrence} — this helper
 * uses the old "prefer auto_daily" heuristic which can return a stale
 * deduction. Kept only for callers that need the bare amount without the
 * log reference.
 */
export function findActualDeductedAmountForOccurrence(
  logs: ConsumptionLog[],
  medicationId: string,
  doseId: string | undefined,
  calendarDate: string
): number | null {
  const active = findActiveDeductionForOccurrence(logs, medicationId, doseId, calendarDate);
  return active ? Math.abs(Number(active.amount) || 0) : null;
}

export function restoreDose(
  med: Medication,
  doseId?: string,
  todayStr: string = getTodayDateString(),
  now: Date = new Date(),
  logs: ConsumptionLog[] = []
): RestoreDoseResult {
  const resolved = resolveRestoreDoseAmount(med, doseId);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const resolvedDoseId = resolved.doseId;
  const slotAmount = resolved.amount;

  const wasActuallyConsumed = resolvedDoseId
    ? isDoseConsumedOnDate(med, resolvedDoseId, todayStr)
    : med.lastConsumedDate === todayStr;

  if (med.autoDeductEnabled === false && !wasActuallyConsumed) {
    return { ok: false, reason: 'auto_deduct_off' };
  }

  // Find the ACTIVE (un-reversed) deduction for this exact occurrence so the
  // Restore reverses the most recent still-in-effect deduction (clamped
  // amount included), NOT a stale historical log that a prior Restore already
  // reversed. After Auto → Restore → Take, the active deduction is the Take;
  // after Auto → Restore, the active deduction is gone (already_restored).
  const activeDeduction = findActiveDeductionForOccurrence(
    logs,
    med.id,
    resolvedDoseId,
    todayStr
  );
  // Stock credit uses the active deduction's actual (clamped) amount when
  // consumed; projection path keeps slotAmount only as metadata (pills
  // unchanged) and has no deduction log to reverse.
  const restoredAmount = wasActuallyConsumed
    ? activeDeduction != null
      ? Math.abs(Number(activeDeduction.amount) || 0)
      : slotAmount
    : slotAmount;
  const reversedLogId = wasActuallyConsumed ? activeDeduction?.id : undefined;

  // --- Multi-dose / scheduled slot ---
  if (hasDoseSchedule(med) && resolvedDoseId) {
    // Clear consumption for this doseId + date (if any).
    const nextConsumption = { ...(med.doseConsumption ?? {}) };
    if (nextConsumption[resolvedDoseId] === todayStr) {
      delete nextConsumption[resolvedDoseId];
    }
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
    // Still ahead on today: do NOT skip — dose stays eligible at its time.
    const nowLocalDate = (() => {
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    })();
    const restoreDateIsPastDay = todayStr < nowLocalDate;
    const timeElapsedToday =
      slot != null && isDoseTimeElapsedToday(slot.time, now);
    const isPastDueForSkip = restoreDateIsPastDay || timeElapsedToday;

    // Restore after Auto/Manual Take: when the scheduled time has already
    // passed, leave a durable skip marker for the SAME occurrence
    // (medicationId + doseId + calendarDate) so projection (todayDueUnits)
    // and Exact Auto reconciliation (isExactAutoOccurrenceApplied) cannot
    // re-trigger a second deduction for this occurrence after Restore.
    // Take clears this skip before recording consumption (consumeDose calls
    // clearDoseSkippedOnDate), so Auto → Restore → Take still yields exactly
    // one final deduction. When the scheduled time has NOT passed, clear any
    // prior skip so the dose stays eligible for time-gated Auto-Deduct at
    // its scheduled time (todayDueUnits already requires now >= dose.time).
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
      // wasActuallyConsumed with elapsed time OR projection-only with elapsed
      // time: record/leave a durable skip for this occurrence so neither
      // projection nor Exact Auto reconciliation can re-deduct after Restore.
      const baseForSkip: Medication = {
        ...med,
        doseConsumption: nextConsumption,
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
                doseConsumption: nextConsumption,
                doseConsumptionHistory: nextHistory,
              },
              d.id,
              todayStr
            )
      );

    let updatedMed: Medication;
    if (wasActuallyConsumed) {
      // Undo ONLY this occurrence's durable deduction (actual log amount).
      // Do not re-run settleAndAdjust (would fold sibling pastDueUnits).
      updatedMed = {
        ...med,
        currentPills: med.currentPills + restoredAmount,
        doseConsumption: nextConsumption,
        doseConsumptionHistory: nextHistory,
        doseSkippedHistory,
        lastConsumedDate: allStillConsumed ? todayStr : undefined,
      };
    } else {
      // Merely elapsed/projected — no durable stock deduction to undo.
      updatedMed = {
        ...med,
        doseConsumption: nextConsumption,
        doseConsumptionHistory: nextHistory,
        doseSkippedHistory,
        lastConsumedDate: allStillConsumed ? todayStr : undefined,
      };
    }

    return {
      ok: true,
      updatedMed,
      restoredAmount,
      doseId: resolvedDoseId,
      wasActuallyConsumed,
      reversedLogId,
    };
  }

  // --- Legacy (no schedule) ---
  const wasLegacyConsumed = med.lastConsumedDate === todayStr;
  if (!wasLegacyConsumed) {
    // No durable consumption marker — projection-only; do not inflate stock.
    return {
      ok: true,
      updatedMed: med,
      restoredAmount: 0,
      doseId: resolvedDoseId,
      wasActuallyConsumed: false,
    };
  }
  const legacyActive = findActiveDeductionForOccurrence(logs, med.id, resolvedDoseId, todayStr);
  const legacyActual = legacyActive ? Math.abs(Number(legacyActive.amount) || 0) : restoredAmount;
  // Undo this day's durable deduction only; do not re-settle other projected units.
  const updatedMed: Medication = {
    ...med,
    currentPills: med.currentPills + legacyActual,
    lastConsumedDate: undefined,
  };

  return {
    ok: true,
    updatedMed,
    restoredAmount: legacyActual,
    doseId: resolvedDoseId,
    wasActuallyConsumed: true,
    reversedLogId: legacyActive?.id,
  };
}

export interface ConsumeDoseResult {
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
  let doseSkippedHistory = med.doseSkippedHistory;
  if (multi && targetDoseId) {
    const recorded = recordDoseConsumed(med, targetDoseId, todayStr);
    doseConsumption = recorded.doseConsumption;
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
      ? { doseConsumption, doseConsumptionHistory, doseSkippedHistory }
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
