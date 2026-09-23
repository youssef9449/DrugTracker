import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
  loadStockGeneration,
  loadDurableGlobalAutoDeductEnabled,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  recoverManualEnvelopeInto,
  saveManualStockEnvelope,
  type ManualStockEnvelope,
} from './stockEnvelopeRecovery';
import { reconcileExactBeforeManualMutation } from './reconcileExactBeforeManualMutation';
import { markAutoDeductionEventReconciled } from './autoDeductionNativeEvents';
import { applyForegroundAutoStockDeltas } from './autoDeductionNativeStock';
import { allocateMutationSeq } from './stockMutationOrdering';
import {
  getTodayDateString,
} from './dateCalculations';

export interface ManualStockTransactionContext {
  fresh: AutoStockDurableState;
  todayStr: string;
  now: Date;
}

export interface ManualStockTransactionFailure {
  kind: 'recovery' | 'reconciliation';
  state: AutoStockDurableState;
  reason: string;
}

export interface ManualStockTransactionOptions<T> {
  todayStr?: string;
  now?: Date;
  globalAutoDeductEnabled?: boolean;
  onFailure: (failure: ManualStockTransactionFailure) => T;
  operation: (context: ManualStockTransactionContext) => T | Promise<T>;
}

async function acknowledgeExactAutoEvents(
  acks: Array<{ medicationId: string; doseId: string; calendarDate: string }>
): Promise<void> {
  const seen = new Set<string>();
  for (const ack of acks) {
    const key = ack.medicationId + '\u001f' + ack.doseId + '\u001f' + ack.calendarDate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await markAutoDeductionEventReconciled(
        ack.medicationId,
        ack.doseId,
        ack.calendarDate
      );
    } catch {
      // Native ACK failures remain retryable through Exact Auto reconciliation.
    }
  }
}

/**
 * Single transaction boundary for every user-driven Manual Stock mutation.
 *
 * The pipeline owns the cross-cutting ordering:
 * durable gate → pending envelope recovery → Exact FIRED reconciliation →
 * business mutation → caller-owned durable finalization.
 *
 * Business operations receive only fresh durable state and transaction time.
 * They must use commitWithManualEnvelope for finalization.
 */
export function runManualStockTransaction<T>(
  options: ManualStockTransactionOptions<T>
): Promise<T> {
  return withAutoStockMutationGate(async (freshIn) => {
    const todayStr = options.todayStr ?? getTodayDateString();
    const now = options.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return options.onFailure({
        kind: 'recovery',
        state: recovered.state,
        reason: 'persist_failed',
      });
    }

    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);

    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled:
        options.globalAutoDeductEnabled ??
        (recovered.state.globalAutoDeductEnabled !== false),
      now,
    });

    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      return options.onFailure({
        kind: 'reconciliation',
        state: pre.state,
        reason:
          pre.durabilityBlocked === true
            ? 'exact_reconciliation_blocked'
            : 'native_list_failed',
      });
    }

    return options.operation({
      fresh: pre.state,
      todayStr,
      now,
    });
  });
}

function buildNativeStockDeltas(
  baseMedications: Medication[],
  nextMedications: Medication[]
): Array<{ medicationId: string; delta: number }> {
  const baseById = new Map(baseMedications.map((m) => [m.id, m.currentPills]));
  const deltas: Array<{ medicationId: string; delta: number }> = [];
  for (const medication of nextMedications) {
    const before = baseById.get(medication.id);
    const after = Number(medication.currentPills);
    if (!Number.isFinite(after) || after < 0) continue;
    if (before == null) {
      // A newly-added medication with zero stock still needs a Native row so
      // an exact Auto occurrence can be recorded as a zero-unit deduction
      // instead of failing with stock_not_initialized.
      deltas.push({ medicationId: medication.id, delta: after });
      continue;
    }
    const delta = after - Number(before);
    if (Number.isFinite(delta) && delta !== 0) {
      deltas.push({ medicationId: medication.id, delta });
    }
  }
  return deltas;
}
export async function commitWithManualEnvelope(
  state: AutoStockDurableState,
  baseMedications: Medication[],
  globalOverride?: boolean,
  occurrenceResolutions: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
    type: 'CONSUMED' | 'SKIPPED';
  }> = []
): Promise<string | null> {
  const durableState: AutoStockDurableState = {
    ...state,
    globalAutoDeductEnabled:
      globalOverride ?? state.globalAutoDeductEnabled ?? loadDurableGlobalAutoDeductEnabled(),
  };
  const alloc = allocateMutationSeq();
  if (!alloc.ok) return alloc.error;
  const mutationSeq = alloc.seq;
  const baseGeneration = loadStockGeneration();
  const stockDeltas = buildNativeStockDeltas(baseMedications, durableState.medications);
  const envelope: ManualStockEnvelope = {
    version: 1,
    status: 'manual_js_ready',
    medications: durableState.medications,
    logs: durableState.logs,
    globalAutoDeductEnabled: durableState.globalAutoDeductEnabled,
    createdAt: new Date().toISOString(),
    baseGeneration,
    mutationSeq,
    stockDeltas,
    occurrenceResolutions,
  };
  const envErr = saveManualStockEnvelope(envelope);
  if (envErr) return envErr;
  const nativeResult = await applyForegroundAutoStockDeltas(
    mutationSeq,
    stockDeltas,
    occurrenceResolutions
  );
  if (!nativeResult.ok) {
    return nativeResult.error ?? 'foreground_stock_failed';
  }
  // The Native result is authoritative for currentPills. Merge that snapshot
  // back into the JS state before writing the durable envelope so a foreground
  // mutation cannot persist the pre-Auto absolute balance it started from.
  if (nativeResult.stocks.length > 0) {
    const nativeById = new Map(
      nativeResult.stocks.map((stock) => [
        stock.medicationId,
        Number(stock.currentPills),
      ])
    );
    durableState.medications = durableState.medications.map((medication) => {
      const nativePills = nativeById.get(medication.id);
      return nativePills != null && Number.isFinite(nativePills) && nativePills >= 0
        ? { ...medication, currentPills: nativePills }
        : medication;
    });
  }
  // Refresh the recovery envelope after Native execution. A crash before the
  // JS commit must recover from this newer Native-aligned snapshot, not the
  // pre-mutation absolute currentPills value captured before the delta ran.
  envelope.medications = durableState.medications;
  envelope.occurrenceResolutions = occurrenceResolutions;
  const refreshedEnvelopeErr = saveManualStockEnvelope(envelope);
  if (refreshedEnvelopeErr) {
    return refreshedEnvelopeErr;
  }
  const commitErr = commitDurableAutoStockState(durableState, {
    appliedMutationSeq: mutationSeq,
  });
  if (commitErr) {
    return commitErr;
  }
  saveManualStockEnvelope(null);
  return null;
}
