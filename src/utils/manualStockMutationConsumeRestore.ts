import type { ConsumptionLog } from '../types';
import { runManualStockTransaction, commitWithManualEnvelope } from './manualStockTransaction';
import type {
  GatedManualConsumeResult,
  GatedManualRestoreResult,
} from './manualStockMutationTypes';
import { consumeDose, restoreDose, resolveRestoreDoseId } from './medActions';
import { getOccurrenceSnapshot, type OccurrenceSnapshotResult } from './autoDeductionNativeEvents';
import { isDoseSkippedOnDate } from './dateCalculations';
import { generateId } from './id';
import { resolveDoseId } from './doseIdentity';
import type { GatedManualOutcome } from './manualStockMutationTypes';

export function shouldDismissAlarmAfterManualTake(
  outcome: GatedManualOutcome
): boolean {
  return outcome === 'applied' || outcome === 'already_consumed';
}

export function runGatedManualConsume(opts: {
  medicationId: string;
  doseId?: string | undefined;
  source: 'alarm' | 'manual';
  todayStr?: string | undefined;
  now?: Date | undefined;
  /**
   * Test inject for native occurrence snapshot.
   * Must not convert infrastructure failure into fake ABSENT.
   */
  getOccurrenceSnapshot?: (
    medicationId: string,
    doseId: string,
    calendarDate: string
  ) => Promise<OccurrenceSnapshotResult>;
}): Promise<GatedManualConsumeResult> {
  return runManualStockTransaction({
      todayStr: opts.todayStr, now: opts.now,
      onFailure: (failure) => ({
        outcome: 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        doseAmount: 0,
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
        doseAmount: 0,
        log: null,
        reason: 'missing_med',
      };
    }
    // Resolve dose identity ONCE from durable med (never React) via the
    // canonical resolver. Multi-dose without doseId cannot proceed;
    // single-dose maps to the sole slot id; explicit ids are validated
    // against schedule rows and normalized.
    const resolved = resolveDoseId(med, opts.doseId);
    if (!resolved.ok) {
      return {
        outcome: resolved.reason === 'missing_dose_id'
          ? ('missing_dose_id' as const)
          : ('rejected' as const),
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: resolved.reason,
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const resolvedDoseId = resolved.doseId;
    // Authoritative amount: native occurrence snapshot under SCHEDULE_LOCK.
    // FIRED → immutable native event amount; SCHEDULED / ABSENT / CANCELLED
    // → fresh durable JS schedule amount; native failure → no mutation.
    let amountOverride: number | undefined;
    const snapshotFn = opts.getOccurrenceSnapshot ?? getOccurrenceSnapshot;
    const snap = await snapshotFn(opts.medicationId, resolvedDoseId, todayStr);
    if (!snap.ok) {
      return {
        outcome: 'rejected' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: 'native_snapshot_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    if (snap.status === 'FIRED') {
      // Only an already-fired occurrence carries immutable amount authority.
      // SCHEDULED is a native copy of configuration and may be stale while a
      // JS medication edit is propagating; fresh durable JS schedule remains
      // authoritative until the occurrence actually fires.
      const n = Number(snap.amount);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          outcome: 'rejected' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          doseAmount: 0,
          log: null,
          reason: 'invalid_exact_event',
          medicationName: med.name,
          unit: med.unit,
        };
      }
      amountOverride = n;
    }
    // SCHEDULED / ABSENT / CANCELLED: consumeDose uses fresh durable JS schedule.
    const result = consumeDose(
      med,
      opts.source,
      todayStr,
      now,
      resolvedDoseId,
      amountOverride !== undefined ? { amountOverride } : undefined
    );
    if (!result.updatedMed || !result.log || result.doseAmount <= 0) {
      const reason = result.reason ?? 'rejected';
      if (reason === 'missing_dose_id') {
        return {
          outcome: 'missing_dose_id' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          doseAmount: 0,
          log: null,
          reason,
          medicationName: med.name,
          unit: med.unit,
        };
      }
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
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const medications = fresh.medications.map((m) =>
      m.id === med.id ? result.updatedMed! : m
    );
    const logs = [result.log, ...fresh.logs];
    const err = await commitWithManualEnvelope(
      { medications, logs },
      fresh.medications,
      undefined,
      [{
        medicationId: med.id,
        doseId: resolvedDoseId,
        calendarDate: todayStr,
        type: 'CONSUMED',
      }]
    );
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: 'persist_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs,
      doseAmount: result.doseAmount,
      log: result.log,
      /** Canonical consumed identity for downstream notification cancel. */
      doseId: resolvedDoseId,
      medicationName: med.name,
      unit: med.unit,
    };
  }
  });
}

export function runGatedManualRestore(opts: {
  medicationId: string;
  doseId?: string;
  todayStr?: string;
  now?: Date;
  makeLogId?: (() => string) | undefined;
}): Promise<GatedManualRestoreResult> {
  return runManualStockTransaction({
      todayStr: opts.todayStr, now: opts.now,
      onFailure: (failure) => ({
        outcome: 'persist_failed' as const,
        medications: failure.state.medications,
        logs: failure.state.logs,
        restoredAmount: 0,
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
        restoredAmount: 0,
        log: null,
        reason: 'missing_med',
      };
    }
    const result = restoreDose(med, opts.doseId, todayStr, now, fresh.logs);
    if (!result.ok) {
      // restoreDose rejects a future unconsumed occurrence (no durable
      // deduction, scheduled time not elapsed) with reason
      // 'already_restored' — a settled/no-op outcome, not a hard failure.
      // Surface it as the documented 'already_restored' outcome (same
      // pattern as the consume wrapper's 'already_consumed' mapping) so
      // repeated pre-schedule Restore calls are idempotent zero-mutation
      // successes instead of generic rejections.
      if (result.reason === 'already_restored') {
        return {
          outcome: 'already_restored' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          restoredAmount: 0,
          log: null,
          reason: result.reason ?? 'mutation_failed',
          medicationName: med.name,
          unit: med.unit,
        };
      }
      // missing_deduction_evidence after a prior Restore set a
      // skip marker is already_restored (idempotent — the occurrence was
      // already handled). This happens when the first Restore cleared the
      // consume marker and set a skip; the second Restore finds no active
      // deduction and no consume marker.
      // Identity: the CANONICAL resolved dose id — never the original
      // optional input after resolution (#516). For a single-slot medication
      // an omitted opts.doseId still checks (and persists) under the slot id.
      if (result.reason === 'missing_deduction_evidence') {
        const canonical = resolveRestoreDoseId(med, opts.doseId);
        const occurrenceDoseId = canonical.ok ? canonical.doseId : null;
        if (occurrenceDoseId && isDoseSkippedOnDate(med, occurrenceDoseId, todayStr)) {
          return {
            outcome: 'already_restored' as const,
            medications: fresh.medications,
            logs: fresh.logs,
            restoredAmount: 0,
            log: null,
            reason: 'already_restored',
            medicationName: med.name,
            unit: med.unit,
          };
        }
      }
      return {
        outcome: 'rejected' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: result.reason ?? 'mutation_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    // Idempotency: a projection-only restore (auto-elapsed, no consume
    // marker) sets a durable skip marker the FIRST time so projection/Exact
    // Auto don't re-deduct. A SECOND restore for the same occurrence (skip
    // already set, no consume marker) is a true no-op (already_restored).
    // But the FIRST auto-only restore must NOT be skipped — it needs to
    // persist the skip marker that restoreDose computed in updatedMed.
    // Occurrence identity: explicit doseSchedule slot id only.
    const occurrenceDoseId = result.doseId;
    const skipAlreadySet = occurrenceDoseId
      ? isDoseSkippedOnDate(med, occurrenceDoseId, todayStr)
      : false;
    if (!result.wasActuallyConsumed && skipAlreadySet) {
      return {
        outcome: 'already_restored' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: 'already_restored',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? result.updatedMed : m
    );
    // Mark the ACTIVE deduction log (exact_auto / dose_taken) that this
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
      id: opts.makeLogId ? opts.makeLogId() : generateId('restore'),
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
    const err = await commitWithManualEnvelope(
      { medications, logs },
      fresh.medications,
      undefined,
      result.doseId
        ? [{
            medicationId: med.id,
            doseId: result.doseId,
            calendarDate: todayStr,
            type: 'SKIPPED',
          }]
        : []
    );
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        restoredAmount: 0,
        log: null,
        reason: 'persist_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }
    return {
      outcome: 'applied' as const,
      medications,
      logs,
      restoredAmount: result.restoredAmount,
      log,
      medicationName: med.name,
      unit: med.unit,
    };
  }
  });
}