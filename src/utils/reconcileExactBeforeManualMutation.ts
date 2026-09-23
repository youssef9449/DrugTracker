/**
 * Shared pre-mutation step: before any manual mutation runs inside the
 * withAutoStockMutationGate critical section, recover pending Manual /
 * Exact-Auto envelopes and reconcile all durable native FIRED exact events.
 *
 * Guarantees: exact event.amount is applied before the manual mutation
 * (Take / Restore / Refill / dose-edit / auto-toggle) runs, so the manual
 * mutation operates on the post-Exact durable state. Manual mutations use
 * durable `currentPills` directly; no elapsed-day settlement is performed.
 */

import {
  loadDurableGlobalAutoDeductEnabled,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  runAutoDeductionReconciliation,
  type RunReconciliationOutput,
} from './runAutoDeductionReconciliation';

export interface PreMutationResult {
  state: AutoStockDurableState;
  reconciliation: RunReconciliationOutput | null;
  /** True when native FIRED list failed — caller should fail-closed or retry. */
  nativeListFailed: boolean;
  /** True when Exact stock is not durably finalized; callers must not mutate stock afterward. */
  durabilityBlocked: boolean;
}

/**
 * Must be called inside withAutoStockMutationGate (alreadyInGate).
 * Returns the post-reconciliation durable state for the subsequent manual mutation.
 */
export async function reconcileExactBeforeManualMutation(opts: {
  fresh: AutoStockDurableState;
  globalAutoDeductEnabled: boolean;
  now?: Date;
}): Promise<PreMutationResult> {
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
