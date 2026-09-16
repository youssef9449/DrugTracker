/**
 * Phase 4 — Manual Take / Restore through the same durable stock gate as
 * exact auto-deduction reconciliation.
 *
 * Crash consistency — dedicated Manual JS envelope (NOT Exact Auto envelope):
 *   1. Allocate mutationSeq + write manual_js_ready envelope (meds+logs only)
 *   2. commitDurableAutoStockState with appliedMutationSeq
 *   3. Clear Manual envelope on full success
 *
 * Shared causal order with Exact Auto via mutationSeq / lastAppliedMutationSeq.
 * Manual envelope never carries toAcknowledge; never calls markReconciled.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  consumeDose,
  restoreDose,
  settleAndAdjust,
  type ConsumeDoseResult,
} from './medActions';
import { normalizeExactDoseId } from './autoDeductionReconciliation';
import { markAutoDeductionEventReconciled } from './autoDeductionNative';
import { isDoseConsumedOnDate, getTodayDateString } from './dateCalculations';
import { LEGACY_DOSE_ID } from './notifications';
import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
  loadStockGeneration,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import { allocateMutationSeq } from './stockMutationOrdering';
import {
  recoverManualEnvelopeInto,
  saveManualStockEnvelope,
  type ManualStockEnvelope,
} from './stockEnvelopeRecovery';

export type {
  ManualStockEnvelope,
} from './stockEnvelopeRecovery';
export {
  recoverManualEnvelopeInto,
  loadManualStockEnvelope,
  saveManualStockEnvelope,
  STORAGE_MANUAL_ENVELOPE_KEY,
  __setManualEnvelopeTestHooks,
} from './stockEnvelopeRecovery';

export type GatedManualOutcome =
  | 'applied'
  | 'already_consumed'
  | 'already_restored'
  | 'missing_med'
  | 'persist_failed'
  | 'rejected';

export interface GatedManualConsumeResult {
  outcome: GatedManualOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  doseAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
}

export interface GatedManualRestoreResult {
  outcome: GatedManualOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  restoredAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
}

/**
 * Alarm UI dismiss contract after Manual Take from notification/alarm:
 * only after durable success (applied) or occurrence already settled
 * (already_consumed). Never after persist_failed.
 */
export function shouldDismissAlarmAfterManualTake(
  outcome: GatedManualOutcome
): boolean {
  return outcome === 'applied' || outcome === 'already_consumed';
}

function resolveConsumeDoseId(med: Medication, doseId?: string): string | undefined {
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  if (doseId != null && doseId !== '') return doseId;
  if (schedule.length === 1) return schedule[0].id;
  if (schedule.length === 0) return LEGACY_DOSE_ID;
  return undefined;
}


/**
 * Hand Exact Auto toAcknowledge to the existing native ACK path.
 * Manual does not own ACK semantics — only forwards finalized recovery ACKs.
 * Deduplicates by medicationId+doseId+calendarDate. Never called when recovery blocked.
 */
async function acknowledgeExactAutoEvents(
  acks: Array<{ medicationId: string; doseId: string; calendarDate: string }>
): Promise<void> {
  if (!acks.length) return;
  const seen = new Set<string>();
  for (const a of acks) {
    const key = `${a.medicationId}${a.doseId}${a.calendarDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await markAutoDeductionEventReconciled(
        a.medicationId,
        a.doseId,
        a.calendarDate
      );
    } catch {
      // Native ACK failures remain retryable via Exact Auto reconciliation.
    }
  }
}

/**
 * Manual durability: envelope (JS state only) → meds+logs → clear.
 */
function commitWithManualEnvelope(state: AutoStockDurableState): string | null {
  const alloc = allocateMutationSeq();
  if (!alloc.ok) return alloc.error;
  const mutationSeq = alloc.seq;
  const baseGeneration = loadStockGeneration();
  const envelope: ManualStockEnvelope = {
    version: 1,
    status: 'manual_js_ready',
    medications: state.medications,
    logs: state.logs,
    createdAt: new Date().toISOString(),
    baseGeneration,
    mutationSeq,
  };
  const envErr = saveManualStockEnvelope(envelope);
  if (envErr) return envErr;

  // meds+logs+lastApplied must all succeed before clearing recovery evidence.
  const commitErr = commitDurableAutoStockState(state, {
    appliedMutationSeq: mutationSeq,
  });
  if (commitErr) {
    // Keep envelope (pair and/or lastApplied incomplete).
    return commitErr;
  }

  // Clear after lastApplied is durable. Clear failure is observable: mutation
  // is not reapplied (lastApplied covers seq) but envelope remains for retry.
  const clearErr = saveManualStockEnvelope(null);
  if (clearErr) return clearErr;
  return null;
}

export function runGatedManualConsume(opts: {
  medicationId: string;
  doseId?: string;
  source: 'alarm' | 'manual';
  todayStr?: string;
  now?: Date;
}): Promise<GatedManualConsumeResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const recovered = recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      // Blocked recovery: do not ACK, do not start Manual mutation.
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        doseAmount: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
    // Exact Auto ACKs via existing native path (not Manual ownership).
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    const fresh = recovered.state;

    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: 'missing_med',
      };
    }

    const resolvedId = resolveConsumeDoseId(med, opts.doseId);
    const doseKey = normalizeExactDoseId(resolvedId);

    // Block a second Take only when a durable consumption marker is present
    // (Manual Take or Exact Auto both set doseConsumption). Do NOT block on
    // the durable skip marker: that marker is left by Restore (after Auto or
    // Manual Take) precisely so projection/Exact-Auto do not re-deduct the
    // same occurrence, while Take remains eligible to clear the skip and
    // record a single manual consumption. isExactAutoOccurrenceApplied is
    // therefore intentionally NOT used here — it includes skip, which would
    // break Auto → Restore → Take (the skip would surface as already_consumed
    // and Take could never replace the restored occurrence). Exact Auto
    // reconciliation still treats skip as already_applied via its own
    // isExactAutoOccurrenceApplied call in reconcileFiredEvents.
    if (isDoseConsumedOnDate(med, doseKey, todayStr)) {
      return {
        outcome: 'already_consumed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: 'already_consumed',
      };
    }

    const result: ConsumeDoseResult = consumeDose(
      med,
      opts.source,
      todayStr,
      now,
      opts.doseId
    );

    if (!result.updatedMed || !result.log || result.doseAmount <= 0) {
      const reason = result.reason ?? 'rejected';
      return {
        outcome:
          reason === 'already_consumed'
            ? ('already_consumed' as const)
            : ('rejected' as const),
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason,
      };
    }

    const medications = fresh.medications.map((m) =>
      m.id === med.id ? result.updatedMed! : m
    );
    const logs = [result.log, ...fresh.logs];
    const err = commitWithManualEnvelope({ medications, logs });
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: 'persist_failed',
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      doseAmount: result.doseAmount,
      log: result.log,
    };
  });
}

export function runGatedManualRestore(opts: {
  medicationId: string;
  doseId?: string;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedManualRestoreResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const recovered = recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        restoredAmount: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    const fresh = recovered.state;

    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: 'missing_med',
      };
    }

    const result = restoreDose(med, opts.doseId, todayStr, now, fresh.logs);
    if (!result.ok) {
      return {
        outcome: 'rejected' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: result.reason,
      };
    }

    // Idempotency: only undo a real durable consumption marker.
    // Second Restore after markers cleared is already_restored.
    if (!result.wasActuallyConsumed) {
      return {
        outcome: 'already_restored' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: 'already_restored',
      };
    }

    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? result.updatedMed : m
    );

    // Mark the ACTIVE deduction log (auto_daily / dose_taken) that this
    // Restore reverses as `reversedAt`, and link the restore (skipped_day)
    // log to it via `relatedLogId`. This mirrors the refill/refill_undo
    // reversal pattern already used by handleUndoRefill. Without this, a
    // later Restore for the same occurrence would find the already-reversed
    // historical deduction (e.g. the original Auto after Auto → Restore →
    // Take) and re-reverse it — inflating stock. With it, findActiveDeduction-
    // ForOccurrence skips reversed logs and finds the NEXT active deduction
    // (the Take), so Auto → Restore → Take → Restore reverses exactly the
    // Take's amount.
    const reverseTimestamp = new Date(now).toISOString();
    const reversedLogId = result.reversedLogId;
    const log: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : `restore-${Date.now()}`,
      medicationId: med.id,
      medicationName: med.name,
      type: 'skipped_day',
      amount: result.restoredAmount,
      date: todayStr,
      timestamp: reverseTimestamp,
      description: `استرجاع جرعة (+${result.restoredAmount} ${med.unit || 'وحدة'})`,
      ...(result.doseId ? { doseId: result.doseId } : {}),
      ...(reversedLogId ? { relatedLogId: reversedLogId } : {}),
    };
    const logs = [
      log,
      ...fresh.logs.map((l) =>
        reversedLogId && l.id === reversedLogId
          ? { ...l, reversedAt: reverseTimestamp }
          : l
      ),
    ];

    const err = commitWithManualEnvelope({ medications, logs });
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: 'persist_failed',
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      restoredAmount: result.restoredAmount,
      log,
    };
  });
}

export type GatedRefillOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'rejected';

export interface GatedRefillResult {
  outcome: GatedRefillOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  addedPills: number;
  log: ConsumptionLog | null;
  reason?: string;
}

/**
 * Route a stock refill (handleConfirmRefill) through the same durable stock
 * mutation gate as Manual Take/Restore and Exact Auto reconciliation. This
 * serializes refills with concurrent deductions so a refill can never write
 * a stale snapshot over a just-committed deduction (and vice versa).
 *
 * Behavior preserved: settleAndAdjust at the effective balance + add the
 * refill amount, set lastSyncDate=today, prepend a refill log. The only
 * change is that the settle + commit happen inside the gate against FRESH
 * durable state (not a potentially-stale React snapshot), and the commit
 * uses the Manual envelope crash-recovery path (allocate seq → envelope →
 * commit meds+logs+lastApplied → clear).
 */
export function runGatedRefill(opts: {
  medicationId: string;
  addedPills: number;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedRefillResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const recovered = recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        addedPills: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    const fresh = recovered.state;

    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'missing_med',
      };
    }

    if (!(opts.addedPills > 0)) {
      return {
        outcome: 'rejected' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'rejected',
      };
    }

    const { updatedMed } = settleAndAdjust(med, opts.addedPills, todayStr, now);
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const log: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : `refill-${Date.now()}`,
      medicationId: med.id,
      medicationName: med.name,
      type: 'refill',
      amount: opts.addedPills,
      date: todayStr,
      timestamp: new Date(now).toISOString(),
      description:
        opts.addedPills >= 0
          ? `شراء وتعبئة مخزون (+${opts.addedPills} ${med.unit})`
          : `تراجع عن تعبئة مخزون (${Math.abs(opts.addedPills)} ${med.unit})`,
    };
    const logs = [log, ...fresh.logs];

    const err = commitWithManualEnvelope({ medications, logs });
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'persist_failed',
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      addedPills: opts.addedPills,
      log,
    };
  });
}

/**
 * Route a refill undo (handleUndoRefill) through the same durable stock
 * mutation gate. Reverses the most recent un-reversed refill log for the
 * medication, marks it `reversedAt`, and prepends a refill_undo log linked
 * via `relatedLogId` (same pattern as dose-deduction reversal above).
 */
export function runGatedUndoRefill(opts: {
  medicationId: string;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedRefillResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const recovered = recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        addedPills: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    const fresh = recovered.state;

    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'missing_med',
      };
    }

    // Find the most recent un-reversed refill log for this medication.
    const refill = fresh.logs.find(
      (l) =>
        l.medicationId === opts.medicationId &&
        l.type === 'refill' &&
        l.amount > 0 &&
        !l.reversedAt
    );
    if (!refill) {
      return {
        outcome: 'rejected' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'rejected',
      };
    }

    const reverseTimestamp = new Date(now).toISOString();
    const reversedAmount = refill.amount;
    // Reverse: settle at effective balance, then subtract the refill amount.
    const { updatedMed } = settleAndAdjust(
      med,
      -reversedAmount,
      todayStr,
      now
    );
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const undoLog: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : `refill-undo-${Date.now()}`,
      medicationId: med.id,
      medicationName: med.name,
      type: 'refill_undo',
      amount: -reversedAmount,
      date: todayStr,
      timestamp: reverseTimestamp,
      relatedLogId: refill.id,
      description: `تراجع عن تعبئة مخزون (${reversedAmount} ${med.unit})`,
    };
    const logs = [
      undoLog,
      ...fresh.logs.map((l) =>
        l.id === refill.id ? { ...l, reversedAt: reverseTimestamp } : l
      ),
    ];

    const err = commitWithManualEnvelope({ medications, logs });
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'persist_failed',
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      addedPills: -reversedAmount,
      log: undoLog,
    };
  });
}
