/**
 * Phase 4 — Manual Take / Restore through the same durable stock gate as
 * exact auto-deduction reconciliation.
 *
 * Callers must NOT treat React snapshots as authoritative. Each entry loads
 * fresh localStorage state, applies pure medActions helpers, commits, and
 * returns the post-commit durable arrays for React to follow.
 *
 * Idempotency vs exact auto (same occurrence = medId + doseId + calendarDate):
 * - consume: no second stock deduct if consume markers, exact-auto log, or
 *   isExactAutoOccurrenceApplied already reflect the occurrence
 * - restore: still pure restoreDose semantics (manual markers / lifecycle)
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
  type AutoStockDurableState,
} from './autoDeductionStockGate';

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

function resolveConsumeDoseId(med: Medication, doseId?: string): string | undefined {
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  if (doseId != null && doseId !== '') return doseId;
  if (schedule.length === 1) return schedule[0].id;
  if (schedule.length === 0) return LEGACY_DOSE_ID;
  return undefined;
}

/**
 * Manual / alarm Take for one occurrence, serialized with exact reconciliation.
 */
export function runGatedManualConsume(opts: {
  medicationId: string;
  doseId?: string;
  source: 'alarm' | 'manual';
  todayStr?: string;
  now?: Date;
}): Promise<GatedManualConsumeResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate((fresh: AutoStockDurableState) => {
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

    // Exact-auto durable evidence for this occurrence → no second deduct.
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
    const err = commitDurableAutoStockState({ medications, logs });
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

/**
 * Manual Restore for one dose slot, serialized with exact reconciliation.
 */
export function runGatedManualRestore(opts: {
  medicationId: string;
  doseId?: string;
  todayStr?: string;
  now?: Date;
  /** Optional log id generator (tests / App wire generateId). */
  makeLogId?: () => string;
}): Promise<GatedManualRestoreResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate((fresh: AutoStockDurableState) => {
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

    const err = commitDurableAutoStockState({ medications, logs });
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
