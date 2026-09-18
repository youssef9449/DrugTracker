/**
 * Shared pre-settlement step: before ANY legacy stock settlement runs inside
 * the withAutoStockMutationGate critical section, recover pending Manual /
 * Exact-Auto envelopes and reconcile all durable native FIRED exact events.
 *
 * Guarantees: exact event.amount is applied before historicalDayDueUnits /
 * settleAndAdjust / syncAutoDailyDeductions / toggle settlement can charge
 * the current schedule amount for the same occurrence.
 */

import type { AutoStockDurableState } from './autoDeductionStockGate';
import {
  runAutoDeductionReconciliation,
  type RunReconciliationOutput,
} from './runAutoDeductionReconciliation';

export interface PreSettlementResult {
  state: AutoStockDurableState;
  reconciliation: RunReconciliationOutput | null;
  /** True when native FIRED list failed — caller should fail-closed or retry. */
  nativeListFailed: boolean;
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

  return {
    state: {
      medications: recon.medications,
      logs: recon.logs,
      globalAutoDeductEnabled: opts.fresh.globalAutoDeductEnabled,
    },
    reconciliation: recon,
    nativeListFailed: recon.nativeListFailed === true,
  };
}
