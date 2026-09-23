import type { ConsumptionLog, Medication } from '../types';
import {
  withAutoStockMutationGate,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import {
  recoverManualEnvelopeInto,
} from './stockEnvelopeRecovery';
import { reconcileExactBeforeManualMutation } from './reconcileExactBeforeManualMutation';
import { markAutoDeductionEventReconciled } from './autoDeductionNativeEvents';
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

export type { ConsumptionLog, Medication };
