/**
 * Phase 4 — Manual Take / Restore through the same durable stock gate as
 * exact auto-deduction reconciliation.
 *
 * Callers must NOT treat React snapshots as authoritative. Each entry loads
 * fresh localStorage state, applies pure medActions helpers, commits, and
 * returns the post-commit durable arrays for React to follow.
 *
 * Crash consistency (reuse Phase 3 exact-auto envelope):
 *   1. Write js_ready envelope with intended meds+logs
 *   2. commitDurableAutoStockState (meds then logs)
 *   3. Clear envelope on full success
 * If meds succeed and logs fail (or process dies mid-way), the envelope
 * remains. Next gate entry (manual or exact reconciliation) recovers both
 * keys so markers + logs stay consistent and exact auto cannot double-deduct.
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
import {
  defaultLoadEnvelope,
  defaultSaveEnvelope,
  type ExactAutoEnvelope,
} from './runAutoDeductionReconciliation';
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
 * If a prior mutation left a js_ready envelope (crash between partial
 * storage writes), finish committing meds+logs and clear the envelope.
 */
function recoverEnvelopeInto(
  fresh: AutoStockDurableState
): { ok: true; state: AutoStockDurableState } | { ok: false; state: AutoStockDurableState } {
  const existing = defaultLoadEnvelope();
  if (!existing) {
    return { ok: true, state: fresh };
  }
  const err = commitDurableAutoStockState({
    medications: existing.medications,
    logs: existing.logs,
  });
  if (err) {
    // Keep envelope for a later retry; surface current durable snapshot.
    return { ok: false, state: fresh };
  }
  defaultSaveEnvelope(null);
  return {
    ok: true,
    state: {
      medications: existing.medications,
      logs: existing.logs,
    },
  };
}

/**
 * Durability sequence shared with Phase 3 exact auto:
 * envelope → meds+logs commit → clear envelope.
 */
function commitWithEnvelope(
  state: AutoStockDurableState,
  toAcknowledge: ExactAutoEnvelope['toAcknowledge']
): string | null {
  const envelope: ExactAutoEnvelope = {
    version: 1,
    status: 'js_ready',
    medications: state.medications,
    logs: state.logs,
    toAcknowledge,
    createdAt: new Date().toISOString(),
  };
  const envErr = defaultSaveEnvelope(envelope);
  if (envErr) return envErr;

  const commitErr = commitDurableAutoStockState(state);
  if (commitErr) {
    // Leave envelope so recovery can finish both keys.
    return commitErr;
  }

  defaultSaveEnvelope(null);
  return null;
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

  return withAutoStockMutationGate((freshIn: AutoStockDurableState) => {
    const recovered = recoverEnvelopeInto(freshIn);
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
    const err = commitWithEnvelope(
      { medications, logs },
      [
        {
          medicationId: med.id,
          doseId: doseKey,
          calendarDate: todayStr,
        },
      ]
    );
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        // Prefer post-mutation snapshot for callers that still apply UI from
        // returned arrays only on 'applied'; durable may be partial until recovery.
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
  makeLogId?: () => string;
}): Promise<GatedManualRestoreResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate((freshIn: AutoStockDurableState) => {
    const recovered = recoverEnvelopeInto(freshIn);
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

    const doseKey = normalizeExactDoseId(result.doseId);
    const err = commitWithEnvelope(
      { medications, logs },
      [
        {
          medicationId: med.id,
          doseId: doseKey,
          calendarDate: todayStr,
        },
      ]
    );
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
