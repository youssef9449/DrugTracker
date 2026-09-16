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
  type ConsumeDoseResult,
} from './medActions';
import {
  findExactAutoLog,
  isExactAutoOccurrenceApplied,
  normalizeExactDoseId,
} from './autoDeductionReconciliation';
import { LEGACY_DOSE_ID } from './notifications';
import { getTodayDateString } from './dateCalculations';
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

  // Clear is best-effort after lastApplied is durable; clear failure is safe
  // because lastApplied already proves the mutation is applied.
  saveManualStockEnvelope(null);
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

  return withAutoStockMutationGate((freshIn: AutoStockDurableState) => {
    const recovered = recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        doseAmount: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
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

    if (
      findExactAutoLog(fresh.logs, med.id, doseKey, todayStr) ||
      isExactAutoOccurrenceApplied(med, doseKey, todayStr, todayStr)
    ) {
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

  return withAutoStockMutationGate((freshIn: AutoStockDurableState) => {
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

    const result = restoreDose(med, opts.doseId, todayStr, now);
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

    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? result.updatedMed : m
    );

    const log: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : `restore-${Date.now()}`,
      medicationId: med.id,
      medicationName: med.name,
      type: 'skipped_day',
      amount: result.restoredAmount,
      date: todayStr,
      timestamp: new Date(now).toISOString(),
      description: `استرجاع جرعة (+${result.restoredAmount} ${med.unit || 'وحدة'})`,
      ...(result.doseId ? { doseId: result.doseId } : {}),
    };
    const logs = [log, ...fresh.logs];

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
