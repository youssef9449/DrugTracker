/**
 * Shared pre-settlement step: before ANY legacy stock settlement runs inside
 * the withAutoStockMutationGate critical section, recover pending Manual /
 * Exact-Auto envelopes and reconcile all durable native FIRED exact events.
 *
 * Guarantees: exact event.amount is applied before historicalDayDueUnits /
 * settleAndAdjust / syncAutoDailyDeductions / toggle settlement can charge
 * the current schedule amount for the same occurrence.
 */

import {
  loadDurableGlobalAutoDeductEnabled,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  runAutoDeductionReconciliation,
  type RunReconciliationOutput,
} from './runAutoDeductionReconciliation';

export interface PreSettlementResult {
  state: AutoStockDurableState;
  reconciliation: RunReconciliationOutput | null;
  /** True when native FIRED list failed — caller should fail-closed or retry. */
  nativeListFailed: boolean;
  /** True when Exact stock is not durably finalized; callers must not mutate stock afterward. */
  durabilityBlocked: boolean;
}

/**
 * Must be called inside withAutoStockMutationGate (alreadyInGate).
 * Returns the post-reconciliation durable state for subsequent legacy math.
 */
export async function reconcileExactBeforeLegacySettlement(opts: {
  fresh: AutoStockDurableState;
  globalAutoDeductEnabled: boolean;
  now?: Date;
}): Promise<PreSettlementResult> {
  // Recover pending envelopes + reconcile durable FIRED events via the
  // existing Exact Auto orchestrator (alreadyInGate).
  const recon = await runAutoDeductionReconciliation({
    globalAutoDeductEnabled: opts.globalAutoDeductEnabled,
    medications: opts.fresh.medications,
    logs: opts.fresh.logs,
    alreadyInGate: true,
    durableState: opts.fresh,
    now: opts.now,
  });

  // Envelope recovery/reconciliation may have durably changed the global
  // master switch. Do not return the pre-gate snapshot as the post-recovery
  // authority; re-read the durable value while the caller still holds the gate.
  const durableGlobalAutoDeductEnabled = loadDurableGlobalAutoDeductEnabled();

  return {
    state: {
      medications: recon.medications,
      logs: recon.logs,
      globalAutoDeductEnabled: durableGlobalAutoDeductEnabled,
    },
    reconciliation: recon,
    nativeListFailed: recon.nativeListFailed === true,
    durabilityBlocked: recon.durabilityBlocked === true,
  };
}
