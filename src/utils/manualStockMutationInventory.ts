import type { ConsumptionLog } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type { GatedRefillResult } from './manualStockMutationTypes';
import { applyDurableStockDelta } from './medActions';
import { generateId } from './id';

export function runGatedRefill(opts: {
  medicationId: string;
  addedPills: number;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedRefillResult> {
  return runManualStockTransaction({
      todayStr: opts.todayStr, now: opts.now,
      onFailure: (failure) => ({
        outcome: 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        addedPills: 0,
        log: null,
        reason: failure.reason,
      }),
      operation: async ({ fresh, todayStr, now }) => {
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
    // refill adds user-entered amount to durable currentPills only.
    const updatedMed = applyDurableStockDelta(med, opts.addedPills);
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const log: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : generateId('refill'),
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
    const err = await commitWithManualEnvelope({ medications, logs }, fresh.medications);
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
      medicationName: med.name,
      unit: med.unit,
    };
  }
  });
}

export function runGatedUndoRefill(opts: {
  medicationId: string;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedRefillResult> {
  return runManualStockTransaction({
      todayStr: opts.todayStr, now: opts.now,
      onFailure: (failure) => ({
        outcome: 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        addedPills: 0,
        log: null,
        reason: failure.reason,
      }),
      operation: async ({ fresh, todayStr, now }) => {
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
    // Most recent un-reversed refill by durable contract: highest timestamp,
    // then highest id (stable, independent of array position / React snapshot).
    const candidates = fresh.logs.filter(
      (l) =>
        l.medicationId === opts.medicationId &&
        l.type === 'refill' &&
        l.amount > 0 &&
        !l.reversedAt
    );
    const refill =
      candidates.length === 0
        ? undefined
        : candidates.reduce((best, cur) => {
            const bt = best.timestamp || '';
            const ct = cur.timestamp || '';
            if (ct > bt) return cur;
            if (ct < bt) return best;
            return cur.id > best.id ? cur : best;
          });
    if (!refill) {
      return {
        outcome: 'rejected' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        addedPills: 0,
        log: null,
        reason: 'rejected',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const reverseTimestamp = new Date(now).toISOString();
    // refill undo reverses from durable currentPills only.
    // reversedAmount = min(refill.amount, max(0, currentPills)).
    // No read-time projection and no elapsed-day settlement.
    const reversedAmount = Math.min(
      Math.max(0, refill.amount),
      Math.max(0, med.currentPills)
    );
    const updatedMed = applyDurableStockDelta(med, -reversedAmount);
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const undoLog: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : generateId('refill-undo'),
      medicationId: med.id,
      medicationName: med.name,
      type: 'refill_undo',
      amount: 0 - reversedAmount,
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
    const err = await commitWithManualEnvelope({ medications, logs }, fresh.medications);
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
      addedPills: 0 - reversedAmount,
      log: undoLog,
      medicationName: med.name,
      unit: med.unit,
    };
  }
  });
}