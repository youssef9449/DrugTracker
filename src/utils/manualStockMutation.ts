/**
 * Phase 4 — Manual Take / Restore through the same durable stock gate as
 * exact auto-deduction reconciliation.
 *
 * Crash consistency — dedicated Manual JS envelope (NOT Exact Auto envelope):
 *   1. Allocate mutationSeq + write the complete current envelope, including
 *      signed Native stock deltas and occurrence resolutions
 *   2. Apply the Native stock mutation idempotently and commit the JS snapshot
 *      with appliedMutationSeq
 *   3. Clear the Manual envelope on full success
 *
 * Shared causal order with Exact Auto via mutationSeq / lastAppliedMutationSeq.
 * Manual envelope never carries toAcknowledge; never calls markReconciled.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  consumeDose,
  restoreDose,
  applyDurableStockDelta,
} from './medActions';
import {
  markAutoDeductionEventReconciled,
  applyForegroundAutoStockDeltas,
  getOccurrenceSnapshot,
  invalidateAutoDeductionRecurrence,
  scheduleAutoDeduction,
  type OccurrenceSnapshotResult,
} from './autoDeductionNative';
import {
  isDoseSkippedOnDate,
  getTodayDateString,
} from './dateCalculations';
import { pruneDoseConsumption } from './pruneDoseConsumption';
import { isValidDoseTime, normalizeTimeString } from './doseSchedule';
import {
  withAutoStockMutationGate,
  commitDurableAutoStockState,
  loadStockGeneration,
  loadDurableGlobalAutoDeductEnabled,
  type AutoStockDurableState,
} from './autoDeductionStockGate';
import { allocateMutationSeq } from './stockMutationOrdering';
import {
  recoverManualEnvelopeInto,
  saveManualStockEnvelope,
  type ManualStockEnvelope,
} from './stockEnvelopeRecovery';
import { reconcileExactBeforeManualMutation } from './reconcileExactBeforeManualMutation';

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
  | 'missing_dose_id'
  | 'persist_failed'
  | 'rejected';

export interface GatedManualConsumeResult {
  outcome: GatedManualOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  doseAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
  /** Fresh durable medication name/unit for UI (never from React snapshot). */
  medicationName?: string;
  unit?: string;
}

export interface GatedManualRestoreResult {
  outcome: GatedManualOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  restoredAmount: number;
  log: ConsumptionLog | null;
  reason?: string;
  /** Fresh durable medication name for UI toasts (never from React snapshot). */
  medicationName?: string;
  /** Fresh durable unit for UI log descriptions. */
  unit?: string;
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
  return undefined;
}

function preSettlementBlockReason(pre: {
  nativeListFailed: boolean;
  durabilityBlocked?: boolean;
}): string | null {
  if (pre.durabilityBlocked === true) return 'exact_reconciliation_blocked';
  if (pre.nativeListFailed) return 'native_list_failed';
  return null;
}

/** Native recurrence chains affected by an auto-deduction configuration change. */
function recurrenceDoseIds(med: Medication): string[] {
  const ids = new Set<string>();
  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    for (const d of med.doseSchedule) {
      const id = typeof d?.id === 'string' ? d.id.trim() : '';
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function autoDeductionDefinitionSignature(med: {
  autoDeductEnabled?: boolean;
  reminderEnabled?: boolean;
  reminderTime?: string;
  dailyDose: number;
  doseSchedule?: Medication['doseSchedule'];
}): string {
  const schedulePart =
    Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0
      ? med.doseSchedule
          .map((d) => String(d.id) + '@' + String(d.time) + '@' + String(d.amount))
          .join(',')
      : '';
  return [
    med.autoDeductEnabled === false ? '0' : '1',
    med.reminderEnabled === true ? '1' : '0',
    med.reminderTime ?? '',
    med.dailyDose,
    schedulePart,
  ].join('|');
}

function autoDeductionDefinitionChanged(
  oldMed: Medication,
  nextMed: Omit<Medication, 'id' | 'createdAt'>
): boolean {
  return autoDeductionDefinitionSignature(oldMed) !==
    autoDeductionDefinitionSignature(nextMed);
}

/**
 * Invalidate every native recurrence chain belonging to one medication.
 * On web `not_android` is a successful no-op. Real native failure blocks
 * the JS configuration commit so an old authorized alarm cannot survive it.
 */
let manualRecurrenceInvalidationTestHook:
  ((medicationId: string, doseId: string) => Promise<{ ok: boolean; error?: string }>) | null = null;

/** @internal test-only */
export function __setManualRecurrenceInvalidationTestHook(
  hook: typeof manualRecurrenceInvalidationTestHook
): void {
  manualRecurrenceInvalidationTestHook = hook;
}

function nextCalendarDateString(calendarDate: string): string | null {
  const [y, m, d] = calendarDate.split('-').map((n) => Number(n));
  if (![y, m, d].every(Number.isFinite)) return null;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return [
    String(dt.getFullYear()).padStart(4, '0'),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-');
}

function localEpochMs(calendarDate: string, timeHhmm: string): number | null {
  const [y, m, d] = calendarDate.split('-').map((n) => Number(n));
  if (![y, m, d].every(Number.isFinite)) return null;
  const colon = timeHhmm.indexOf(':');
  if (colon < 1) return null;
  const hour = Number(timeHhmm.slice(0, colon));
  const minute = Number(timeHhmm.slice(colon + 1));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const dt = new Date(y, m - 1, d, hour, minute, 0, 0);
  const epoch = dt.getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

function recurrenceDefinition(
  med: Medication,
  doseId: string
): { doseId: string; time: string; amount: number } | null {
  if (med.autoDeductEnabled === false) return null;
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  if (schedule.length === 0) return null;
  const dose = schedule.find((d) => d?.id === doseId);
  if (!dose || !isValidDoseTime(dose.time) || !(Number(dose.amount) > 0)) {
    return null;
  }
  return {
    doseId: String(dose.id),
    time: normalizeTimeString(dose.time),
    amount: Number(dose.amount),
  };
}

async function restoreInvalidatedRecurrences(
  med: Medication,
  doseIds: string[],
  now: Date
): Promise<{ ok: true } | { ok: false; error: string }> {
  const today = getTodayDateString();
  const tomorrow = nextCalendarDateString(today);
  if (!tomorrow) return { ok: false, error: 'invalid_next_date' };

  for (const doseId of doseIds) {
    const def = recurrenceDefinition(med, doseId);
    if (!def) continue;
    for (const calendarDate of [today, tomorrow]) {
      const epoch = localEpochMs(calendarDate, def.time);
      if (epoch == null || epoch <= now.getTime() - 2000) continue;
      const result = await scheduleAutoDeduction({
        medicationId: med.id,
        doseId: def.doseId,
        calendarDate,
        timeHhmm: def.time,
        amount: def.amount,
        scheduledAtEpochMs: epoch,
      });
      if (!result.ok && result.error !== 'not_android') {
        return { ok: false, error: result.error ?? 'schedule_failed' };
      }
    }
  }
  return { ok: true };
}

interface RecurrenceInvalidationResult {
  ok: boolean;
  error?: string;
  invalidatedDoseIds: string[];
}

async function invalidateMedicationRecurrences(
  med: Medication
): Promise<RecurrenceInvalidationResult> {
  const invalidatedDoseIds: string[] = [];
  for (const doseId of recurrenceDoseIds(med)) {
    const result = manualRecurrenceInvalidationTestHook
      ? await manualRecurrenceInvalidationTestHook(med.id, doseId)
      : await invalidateAutoDeductionRecurrence(med.id, doseId);
    if (!result.ok && result.error !== 'not_android') {
      if (invalidatedDoseIds.length > 0) {
        const compensation = await restoreInvalidatedRecurrences(
          med,
          invalidatedDoseIds,
          new Date()
        );
        if (!compensation.ok) {
          return {
            ok: false,
            error: `${result.error ?? 'native_invalidation_failed'};compensation:${compensation.error}`,
            invalidatedDoseIds,
          };
        }
      }
      return {
        ok: false,
        error: result.error ?? 'native_invalidation_failed',
        invalidatedDoseIds,
      };
    }
    if (result.ok) invalidatedDoseIds.push(doseId);
  }
  return { ok: true, invalidatedDoseIds };
}


/**
 * Hand Exact Auto toAcknowledge to the existing native ACK path.
 * Manual does not own ACK semantics — only forwards finalized recovery ACKs.
 * Deduplicates by medicationId+doseId+calendarDate. Never called when recovery blocked.
 */
async function acknowledgeExactAutoEvents(
  acks: Array<{ medicationId: string; doseId: string; calendarDate: string }>
): Promise<void> {
  if (!acks.length) return;
  const seen = new Set<string>();
  for (const a of acks) {
    const key = `${a.medicationId}${a.doseId}${a.calendarDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await markAutoDeductionEventReconciled(
        a.medicationId,
        a.doseId,
        a.calendarDate
      );
    } catch {
      // Native ACK failures remain retryable via Exact Auto reconciliation.
    }
  }
}

/**
 * Shared JS-stock durability: recovery envelope → meds+logs+global → completion marker → clear.
 * Safe to call from an already-held withAutoStockMutationGate, including
 * startup manual mutation; callers must NOT wrap it in another gate.
 */
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

export function runGatedManualConsume(opts: {
  medicationId: string;
  doseId?: string;
  source: 'alarm' | 'manual';
  todayStr?: string;
  now?: Date;
  /**
   * Test inject for native occurrence snapshot (production uses getOccurrenceSnapshot).
   * Must not convert infrastructure failure into fake ABSENT.
   */
  getOccurrenceSnapshot?: (
    medicationId: string,
    doseId: string,
    calendarDate: string
  ) => Promise<OccurrenceSnapshotResult>;
}): Promise<GatedManualConsumeResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    // Capture date/time inside the critical section so a mutation that waited
    // on the gate still uses the clock at execution time (not call time).
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
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
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    // Exact FIRED reconciliation BEFORE any manual mutation.
    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      // Fail-closed: do not run manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        doseAmount: 0,
        log: null,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

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

    // Resolve dose identity once from durable med (never React). Multi-dose
    // without doseId cannot proceed; single-dose maps to the sole slot id.
    const resolvedDoseId = resolveConsumeDoseId(med, opts.doseId);
    if (resolvedDoseId === undefined) {
      return {
        outcome: 'missing_dose_id' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        doseAmount: 0,
        log: null,
        reason: 'missing_dose_id',
        medicationName: med.name,
        unit: med.unit,
      };
    }

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
      medicationName: med.name,
      unit: med.unit,
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
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    // Capture date/time inside the critical section (not at call time).
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
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
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    // Exact FIRED reconciliation BEFORE any manual mutation.
    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      // Fail-closed: do not run manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        restoredAmount: 0,
        log: null,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

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
          reason: result.reason,
          medicationName: med.name,
          unit: med.unit,
        };
      }
      // Issue #267: missing_deduction_evidence after a prior Restore set a
      // skip marker is already_restored (idempotent — the occurrence was
      // already handled). This happens when the first Restore cleared the
      // consume marker and set a skip; the second Restore finds no active
      // deduction and no consume marker.
      if (result.reason === 'missing_deduction_evidence') {
        const occurrenceDoseId = opts.doseId;
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
        reason: result.reason,
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
      id: opts.makeLogId ? opts.makeLogId() : `restore-${Date.now()}`,
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
  });
}

export interface GatedAddMedicationResult {
  outcome: 'applied' | 'duplicate_med_id' | 'persist_failed';
  medications: Medication[];
  logs: ConsumptionLog[];
  medicationName?: string;
  unit?: string;
  reason?: string;
}

/**
 * Add a medication through the same durable stock gate as every other
 * post-hydration medication/stock mutation. The caller provides a complete
 * new Medication object; the gate is authoritative for the final collection
 * and the durable global auto-deduct value.
 */
export function runGatedAddMedication(opts: {
  medication: Medication;
}): Promise<GatedAddMedicationResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);

    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }

    if (pre.state.medications.some((m) => m.id === opts.medication.id)) {
      return {
        outcome: 'duplicate_med_id' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        medicationName: opts.medication.name,
        unit: opts.medication.unit,
        reason: 'duplicate_med_id',
      };
    }

    const durableGlobal =
      pre.state.globalAutoDeductEnabled ??
      loadDurableGlobalAutoDeductEnabled();
    const medication: Medication = {
      ...opts.medication,
      // The durable global value is the default for new medications, but an
      // explicit per-med choice from the creation form is authoritative.
      autoDeductEnabled:
        opts.medication.autoDeductEnabled !== undefined
          ? opts.medication.autoDeductEnabled
          : durableGlobal,
    };
    const medications = [medication, ...pre.state.medications];
    const logs = pre.state.logs;

    const err = await commitWithManualEnvelope({
      medications,
      logs,
      globalAutoDeductEnabled: pre.state.globalAutoDeductEnabled,
    }, pre.state.medications);
    if (err) {
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: 'persist_failed',
        medicationName: medication.name,
        unit: medication.unit,
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      medicationName: medication.name,
      unit: medication.unit,
    };
  });
}

export type GatedRefillOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'rejected';

export interface GatedRefillResult {
  outcome: GatedRefillOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  addedPills: number;
  log: ConsumptionLog | null;
  reason?: string;
  /** Fresh durable medication name for UI toasts (never from React snapshot). */
  medicationName?: string;
  unit?: string;
}

/**
 * Route a stock refill (handleConfirmRefill) through the same durable stock
 * mutation gate as Manual Take/Restore and Exact Auto reconciliation. This
 * serializes refills with concurrent deductions so a refill can never write
 * a stale snapshot over a just-committed deduction (and vice versa).
 *
 * Behavior preserved:  at the effective balance + add the
 * refill amount, prepend a refill log. The only
 * change is that the settle + commit happen inside the gate against FRESH
 * durable state (not a potentially-stale React snapshot), and the commit
 * uses the Manual envelope crash-recovery path (allocate seq → envelope →
 * commit meds+logs+lastApplied → clear).
 */
export function runGatedRefill(opts: {
  medicationId: string;
  addedPills: number;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedRefillResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    // Capture date/time inside the critical section (not at call time).
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        addedPills: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    // Exact FIRED reconciliation BEFORE any manual mutation.
    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      // Fail-closed: do not run manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        addedPills: 0,
        log: null,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

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

    // Issue #267: refill adds user-entered amount to durable currentPills only.
    const updatedMed = applyDurableStockDelta(med, opts.addedPills);
    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const log: ConsumptionLog = {
      id: opts.makeLogId ? opts.makeLogId() : `refill-${Date.now()}`,
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
  });
}

/**
 * Route a refill undo (handleUndoRefill) through the same durable stock
 * mutation gate. Reverses the most recent un-reversed refill log for the
 * medication, marks it `reversedAt`, and prepends a refill_undo log linked
 * via `relatedLogId` (same pattern as dose-deduction reversal above).
 */
export function runGatedUndoRefill(opts: {
  medicationId: string;
  todayStr?: string;
  now?: Date;
  makeLogId?: () => string;
}): Promise<GatedRefillResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    // Capture date/time inside the critical section (not at call time).
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        addedPills: 0,
        log: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    // Exact FIRED reconciliation BEFORE any manual mutation.
    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      // Fail-closed: do not run manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        addedPills: 0,
        log: null,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

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

    // Issue #267: refill undo reverses from durable currentPills only.
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
      id: opts.makeLogId ? opts.makeLogId() : `refill-undo-${Date.now()}`,
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
  });
}


export type GatedToggleOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'native_list_failed'
  | 'native_invalidation_failed';

export interface GatedAutoDeductToggleResult {
  outcome: GatedToggleOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  newState: boolean;
  settleLog: ConsumptionLog | null;
  medicationName?: string;
  unit?: string;
  reason?: string;
}

/**
 * Per-med auto-deduct toggle inside the stock gate.
 * Ordering: recover → exact FIRED reconciliation →  on durable med.
 */
export function runGatedAutoDeductToggle(opts: {
  medicationId: string;
  todayStr?: string;
  now?: Date;
  globalAutoDeductEnabled?: boolean;
}): Promise<GatedAutoDeductToggleResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        newState: false,
        settleLog: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);

    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      // The durable recovered global policy is the authority; React's copy is
      // only an input hint and may lag after crash/recovery.
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        newState: false,
        settleLog: null,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

    const med = fresh.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState: false,
        settleLog: null,
        reason: 'missing_med',
      };
    }

    // Issue #267: per-med Auto ON/OFF changes configuration only.
    const newState = med.autoDeductEnabled === false;
    const updatedMed: Medication = { ...med, autoDeductEnabled: newState };
    const settleLog: ConsumptionLog | null = null;

    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const logs = fresh.logs;

    // Native recurrence invalidation is the cross-domain ordering barrier.
    const invalidation = await invalidateMedicationRecurrences(med);
    if (!invalidation.ok) {
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState,
        settleLog: null,
        reason: invalidation.error,
        medicationName: med.name,
        unit: med.unit,
      };
    }

    const err = await commitWithManualEnvelope({ medications, logs }, fresh.medications);
    if (err) {
      // Native invalidation already linearized the old schedule chain. Restore
      // it when the JS commit fails so a failed mutation does not leave the
      // medication without its previously authorized exact schedule.
      if (invalidation.invalidatedDoseIds.length > 0) {
        await restoreInvalidatedRecurrences(med, invalidation.invalidatedDoseIds, now);
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        newState,
        settleLog: null,
        reason: 'persist_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      newState,
      settleLog,
      medicationName: updatedMed.name,
      unit: updatedMed.unit,
    };
  });
}

export interface GatedGlobalAutoDeductToggleResult {
  outcome:
    | 'applied'
    | 'persist_failed'
    | 'native_list_failed'
    | 'native_invalidation_failed';
  medications: Medication[];
  logs: ConsumptionLog[];
  enable: boolean;
  settleLogs: ConsumptionLog[];
  reason?: string;
}

/**
 * Global auto-deduct toggle inside the stock gate.
 * Exact FIRED reconciliation runs before any per-med manual mutation.
 */
export function runGatedGlobalAutoDeductToggle(opts: {
  enable: boolean;
  todayStr?: string;
  now?: Date;
}): Promise<GatedGlobalAutoDeductToggleResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        enable: opts.enable,
        settleLogs: [],
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);

    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: opts.enable,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        enable: opts.enable,
        settleLogs: [],
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

    // Global is a bulk state setter for ALL existing medications AND the
    // default for newly added ones. Flip autoDeductEnabled only — do not
    // settle stock, invent consumption logs, or mutate currentPills here.
    // Schedulers/reminders react to the resulting medication-level flags.
    //
    // Global OFF: invalidate ALL native recurrences BEFORE the durable bulk
    // commit (same ordering barrier as per-med toggle) so a near-fire
    // occurrence cannot FIRE after OFF is durable but before the scheduler
    // cleans up. Global ON does not invalidate.
    const invalidatedMeds: Array<{ med: Medication; doseIds: string[] }> = [];
    if (opts.enable === false) {
      for (const med of fresh.medications) {
        const invalidation = await invalidateMedicationRecurrences(med);
        if (!invalidation.ok) {
          for (const completed of invalidatedMeds) {
            if (completed.doseIds.length > 0) {
              await restoreInvalidatedRecurrences(
                completed.med,
                completed.doseIds,
                now
              );
            }
          }
          return {
            outcome: 'native_invalidation_failed' as const,
            medications: fresh.medications,
            logs: fresh.logs,
            enable: opts.enable,
            settleLogs: [],
            reason: invalidation.error,
          };
        }
        invalidatedMeds.push({
          med,
          doseIds: invalidation.invalidatedDoseIds,
        });
      }
    }

    const medications = fresh.medications.map((med) =>
      med.autoDeductEnabled === opts.enable
        ? med
        : { ...med, autoDeductEnabled: opts.enable }
    );

    const err = await commitWithManualEnvelope({
      medications,
      logs: fresh.logs,
      globalAutoDeductEnabled: opts.enable,
    }, fresh.medications);
    if (err) {
      for (const completed of invalidatedMeds) {
        if (completed.doseIds.length > 0) {
          await restoreInvalidatedRecurrences(
            completed.med,
            completed.doseIds,
            now
          );
        }
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        enable: opts.enable,
        settleLogs: [],
        reason: 'persist_failed',
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs: fresh.logs,
      enable: opts.enable,
      settleLogs: [],
    };
  });
}

export type GatedDeleteMedicationOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'native_list_failed'
  | 'native_invalidation_failed';

export interface GatedDeleteMedicationResult {
  outcome: GatedDeleteMedicationOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  medicationName?: string;
  unit?: string;
  reason?: string;
}

/**
 * Delete a medication from the durable stock state.
 *
 * Native FIRED events for a deleted medication remain harmless: the existing
 * Exact Auto reconciler ACKs missing-med occurrences without mutating stock.
 * Native schedule cleanup is handled by the normal desired-state scheduler
 * after React reflects the committed deletion.
 */
export function runGatedDeleteMedication(opts: {
  medicationId: string;
}): Promise<GatedDeleteMedicationResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        reason: 'persist_failed',
      };
    }

    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }

    const med = pre.state.medications.find((m) => m.id === opts.medicationId);
    if (!med) {
      return {
        outcome: 'missing_med' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: 'missing_med',
      };
    }

    // Invalidate the deleted medication's old native recurrence before the
    // deletion is committed. This closes the same cross-domain race as edit/
    // toggle: a queued old alarm cannot create a new FIRED occurrence after
    // the deletion has linearized.
    const invalidation = await invalidateMedicationRecurrences(med);
    if (!invalidation.ok) {
      return {
        outcome: 'native_invalidation_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: invalidation.error,
        medicationName: med.name,
        unit: med.unit,
      };
    }

    const medications = pre.state.medications.filter((m) => m.id !== opts.medicationId);
    const err = await commitWithManualEnvelope({
      medications,
      logs: pre.state.logs,
    }, pre.state.medications);
    if (err) {
      if (invalidation.invalidatedDoseIds.length > 0) {
        await restoreInvalidatedRecurrences(med, invalidation.invalidatedDoseIds, new Date());
      }
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: 'persist_failed',
        medicationName: med.name,
        unit: med.unit,
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs: pre.state.logs,
      medicationName: med.name,
      unit: med.unit,
    };
  });
}

export type GatedMedicationUpdateOutcome =
  | 'applied'
  | 'missing_med'
  | 'persist_failed'
  | 'native_list_failed'
  | 'native_invalidation_failed';

export interface GatedMedicationUpdateResult {
  outcome: GatedMedicationUpdateOutcome;
  medications: Medication[];
  logs: ConsumptionLog[];
  settleLog: ConsumptionLog | null;
  medicationName?: string;
  unit?: string;
  reason?: string;
}

/**
 * Medication edit inside the stock gate.
 * Uses durable medication for settlement; form data cannot overwrite stock-owned fields.
 */
export function runGatedMedicationUpdate(opts: {
  editId: string;
  medData: Omit<Medication, 'id' | 'createdAt'>;
  todayStr?: string;
  now?: Date;
  globalAutoDeductEnabled?: boolean;
}): Promise<GatedMedicationUpdateResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const now = opts.now ?? new Date();

    const recovered = await recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        settleLog: null,
        reason: 'persist_failed',
      };
    }
    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);

    const pre = await reconcileExactBeforeManualMutation({
      fresh: recovered.state,
      // The durable recovered global policy is authoritative; the React value
      // may lag after crash/recovery and must not control stock reconciliation.
      globalAutoDeductEnabled: recovered.state.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed || pre.durabilityBlocked === true) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        settleLog: null,
        reason: preSettlementBlockReason(pre) ?? 'native_list_failed',
      };
    }
    const fresh = pre.state;

    const freshMed = fresh.medications.find((m) => m.id === opts.editId);
    if (!freshMed) {
      return {
        outcome: 'missing_med' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        settleLog: null,
        reason: 'missing_med',
      };
    }

    let invalidation: RecurrenceInvalidationResult = {
      ok: true,
      invalidatedDoseIds: [],
    };
    if (autoDeductionDefinitionChanged(freshMed, opts.medData)) {
      // Invalidate the old native chain before committing new amount/time,
      // reminder, schedule-id, or per-med auto-deduction configuration.
      invalidation = await invalidateMedicationRecurrences(freshMed);
      if (!invalidation.ok) {
        return {
          outcome: 'native_invalidation_failed' as const,
          medications: fresh.medications,
          logs: fresh.logs,
          settleLog: null,
          reason: invalidation.error,
          medicationName: freshMed.name,
          unit: freshMed.unit,
        };
      }
    }

    // Issue #267: dose edit changes configuration only. No stock settlement,
    // by a dose edit.
    const stockBase = freshMed;
    const settleLog: ConsumptionLog | null = null;

    // Prune from durable/settled history + NEW schedule — never from React form history.
    // Authority: fresh durable state → settlement result → prune using final schedule.
    const forPrune: Omit<Medication, 'id' | 'createdAt'> = {
      ...opts.medData,
      // Override any form-snapshot history with durable/settled authority.
      doseConsumptionHistory: stockBase.doseConsumptionHistory,
      doseSkippedHistory: stockBase.doseSkippedHistory,
    };
    const pruned = pruneDoseConsumption(forPrune, stockBase);

    // Build final med: user-editable fields from medData/pruned; stock/history from
    // stockBase then pruned schedule (pruned doseConsumptionHistory wins over stockBase).
    const finalMed: Medication = {
      ...freshMed,
      ...pruned,
      id: freshMed.id,
      createdAt: freshMed.createdAt,
      currentPills: stockBase.currentPills,
      lastConsumedDate: stockBase.lastConsumedDate,
      autoDeductEnabled:
        opts.medData.autoDeductEnabled !== undefined
          ? opts.medData.autoDeductEnabled
          : stockBase.autoDeductEnabled,
      // Explicitly take pruned history (not stockBase) so removed dose IDs stay gone.
      doseConsumptionHistory: pruned.doseConsumptionHistory,
      doseSkippedHistory:
        pruned.doseSkippedHistory ?? stockBase.doseSkippedHistory,
    };

    const medications = fresh.medications.map((m) =>
      m.id === opts.editId ? finalMed : m
    );
    const logs = settleLog ? [settleLog, ...fresh.logs] : fresh.logs;

    const err = await commitWithManualEnvelope({ medications, logs }, fresh.medications);
    if (err) {
      // Only configuration-changing edits invalidate native recurrences.
      // Restore the old chain when the new JS state could not be committed.
      if (
        autoDeductionDefinitionChanged(freshMed, opts.medData) &&
        invalidation.invalidatedDoseIds.length > 0
      ) {
        await restoreInvalidatedRecurrences(
          freshMed,
          invalidation.invalidatedDoseIds,
          now
        );
      }
      return {
        outcome: 'persist_failed' as const,
        medications: fresh.medications,
        logs: fresh.logs,
        settleLog: null,
        reason: 'persist_failed',
        medicationName: freshMed.name,
        unit: freshMed.unit,
      };
    }

    return {
      outcome: 'applied' as const,
      medications,
      logs,
      settleLog,
      medicationName: finalMed.name,
      unit: finalMed.unit,
    };
  });
}
