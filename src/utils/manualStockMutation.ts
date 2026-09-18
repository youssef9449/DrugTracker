/**
 * Phase 4 — Manual Take / Restore through the same durable stock gate as
 * exact auto-deduction reconciliation.
 *
 * Crash consistency — dedicated Manual JS envelope (NOT Exact Auto envelope):
 *   1. Allocate mutationSeq + write manual_js_ready envelope (meds+logs only)
 *   2. commitDurableAutoStockState with appliedMutationSeq
 *   3. Clear Manual envelope on full success
 *
 * Shared causal order with Exact Auto via mutationSeq / lastAppliedMutationSeq.
 * Manual envelope never carries toAcknowledge; never calls markReconciled.
 */

import type { ConsumptionLog, Medication } from '../types';
import {
  consumeDose,
  restoreDose,
  settleAndAdjust,
  type ConsumeDoseResult,
} from './medActions';
import {
  markAutoDeductionEventReconciled,
  getOccurrenceSnapshot,
  invalidateAutoDeductionRecurrence,
  scheduleAutoDeduction,
  type OccurrenceSnapshotResult,
} from './autoDeductionNative';
import {
  isDoseSkippedOnDate,
  getTodayDateString,
  computeDueDoseBreakdown,
  effectiveCurrentPills,
  settleAutoDeductToggle,
  settleDoseChange,
} from './dateCalculations';
import { pruneDoseConsumption } from './pruneDoseConsumption';
import { isValidDoseTime, normalizeTimeString } from './doseSchedule';
import { LEGACY_DOSE_ID } from './notifications';
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
import { reconcileExactBeforeLegacySettlement } from './reconcileExactBeforeLegacySettlement';

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
  if (schedule.length === 0) return LEGACY_DOSE_ID;
  return undefined;
}

/** Native recurrence chains affected by an auto-deduction configuration change. */
function recurrenceDoseIds(med: Medication): string[] {
  const ids = new Set<string>();
  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    for (const d of med.doseSchedule) {
      const id = typeof d?.id === 'string' ? d.id.trim() : '';
      if (id) ids.add(id);
    }
  } else {
    ids.add(LEGACY_DOSE_ID);
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
  if (schedule.length > 0) {
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
  if (doseId !== LEGACY_DOSE_ID || med.reminderEnabled !== true) return null;
  if (!med.reminderTime || !isValidDoseTime(med.reminderTime) || !(Number(med.dailyDose) > 0)) {
    return null;
  }
  return {
    doseId: LEGACY_DOSE_ID,
    time: normalizeTimeString(med.reminderTime),
    amount: Number(med.dailyDose),
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
 * Manual durability: envelope (JS state only) → meds+logs → clear.
 */
function commitWithManualEnvelope(
  state: AutoStockDurableState,
  globalOverride?: boolean
): string | null {
  const durableState: AutoStockDurableState = {
    ...state,
    globalAutoDeductEnabled:
      globalOverride ?? state.globalAutoDeductEnabled ?? loadDurableGlobalAutoDeductEnabled(),
  };
  const alloc = allocateMutationSeq();
  if (!alloc.ok) return alloc.error;
  const mutationSeq = alloc.seq;
  const baseGeneration = loadStockGeneration();
  const envelope: ManualStockEnvelope = {
    version: 1,
    status: 'manual_js_ready',
    medications: durableState.medications,
    logs: durableState.logs,
    globalAutoDeductEnabled: durableState.globalAutoDeductEnabled,
    createdAt: new Date().toISOString(),
    baseGeneration,
    mutationSeq,
  };
  const envErr = saveManualStockEnvelope(envelope);
  if (envErr) return envErr;

  // meds+logs+lastApplied must all succeed before clearing recovery evidence.
  const commitErr = commitDurableAutoStockState(durableState, {
    appliedMutationSeq: mutationSeq,
  });
  if (commitErr) {
    // Keep envelope (pair and/or lastApplied incomplete).
    return commitErr;
  }

  // Clear after lastApplied is durable. Clear failure is NOT a caller-facing
  // failure: the mutation is fully durable (meds + logs + lastApplied all
  // succeeded). lastAppliedMutationSeq is the completion proof. The envelope
  // stays for retry — recoverManualEnvelopeInto cleans it up on the next
  // gate entry (mutationSeq <= lastApplied → collect acks + clear). Return
  // null so the caller sees 'applied' (the mutation is durable; the clear is
  // best-effort cleanup). This matches the Phase 4 completion contract:
  // lastAppliedMutationSeq >= envelope.mutationSeq ⇒ mutation finalized.
  const clearErr = saveManualStockEnvelope(null);
  if (clearErr) return null;
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

    const recovered = recoverManualEnvelopeInto(freshIn);
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
    // Exact FIRED reconciliation BEFORE any legacy settlement / manual math.
    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: true,
      now: opts.now,
    });
    if (pre.nativeListFailed) {
      // Fail-closed: do not run legacy or manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        doseAmount: 0,
        log: null,
        reason: 'native_list_failed',
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
    // FIRED / SCHEDULED → native amount; ABSENT / CANCELLED → JS schedule;
    // native failure → no mutation (no silent schedule fallback on Android).
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

    const result: ConsumeDoseResult = consumeDose(
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
    const err = commitWithManualEnvelope({ medications, logs });
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

    const recovered = recoverManualEnvelopeInto(freshIn);
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
    // Exact FIRED reconciliation BEFORE any legacy settlement / manual math.
    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: true,
      now: opts.now,
    });
    if (pre.nativeListFailed) {
      // Fail-closed: do not run legacy or manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        restoredAmount: 0,
        log: null,
        reason: 'native_list_failed',
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
    // Occurrence identity: the restored slot id for scheduled meds; the
    // LEGACY_DOSE_ID sentinel for legacy meds (no doseSchedule) — the same
    // identity the per-day legacy due calculation and Exact Auto
    // reconciliation use for the implicit daily dose.
    const isLegacyOccurrence =
      !Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0;
    const occurrenceDoseId =
      result.doseId ?? (isLegacyOccurrence ? LEGACY_DOSE_ID : undefined);
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

    // Mark the ACTIVE deduction log (auto_daily / dose_taken) that this
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

    const err = commitWithManualEnvelope({ medications, logs });
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
 * Behavior preserved: settleAndAdjust at the effective balance + add the
 * refill amount, set lastSyncDate=today, prepend a refill log. The only
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

    const recovered = recoverManualEnvelopeInto(freshIn);
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
    // Exact FIRED reconciliation BEFORE any legacy settlement / manual math.
    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: true,
      now: opts.now,
    });
    if (pre.nativeListFailed) {
      // Fail-closed: do not run legacy or manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        addedPills: 0,
        log: null,
        reason: 'native_list_failed',
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

    const { updatedMed } = settleAndAdjust(med, opts.addedPills, todayStr, now);
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

    const err = commitWithManualEnvelope({ medications, logs });
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

    const recovered = recoverManualEnvelopeInto(freshIn);
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
    // Exact FIRED reconciliation BEFORE any legacy settlement / manual math.
    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: true,
      now: opts.now,
    });
    if (pre.nativeListFailed) {
      // Fail-closed: do not run legacy or manual mutation when native read failed.
      return {
        outcome: 'persist_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        addedPills: 0,
        log: null,
        reason: 'native_list_failed',
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

    // Compute settleBase with the SAME semantics as settleAndAdjust /
    // reverseRefill (dateCalculations.ts): for gated meds, settle at the
    // past-only balance; for legacy, at the full effective balance. Then
    // clamp the reversal to what is actually reversible — the refill may
    // have added 10, but if consumption/settlement has since reduced the
    // settleBase to 5, only 5 can be reversed. Without this clamp, the
    // refill_undo log and the operation result would record -10 even though
    // only -5 was actually reversed (the snapshot would be correct due to
    // settleAndAdjust's own Math.max(0, …) clamp, but the audit log and
    // caller-facing amount would be wrong — a data-integrity regression).
    const breakdown = computeDueDoseBreakdown(med, now, todayStr);
    const settleBase = breakdown.gated
      ? Math.max(0, med.currentPills - breakdown.pastDueUnits)
      : Math.max(0, effectiveCurrentPills(med, todayStr, now));
    const reversedAmount = Math.min(
      Math.max(0, refill.amount),
      settleBase
    );
    // Reverse: settle at effective balance, then subtract the ACTUAL
    // (clamped) reversed amount — not the full refill.amount.
    const { updatedMed } = settleAndAdjust(
      med,
      -reversedAmount,
      todayStr,
      now
    );
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

    const err = commitWithManualEnvelope({ medications, logs });
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
 * Ordering: recover → exact FIRED reconciliation → settleAutoDeductToggle on durable med.
 */
export function runGatedAutoDeductToggle(opts: {
  medicationId: string;
  todayStr?: string;
  now?: Date;
  globalAutoDeductEnabled?: boolean;
}): Promise<GatedAutoDeductToggleResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = recoverManualEnvelopeInto(freshIn);
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

    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: opts.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        newState: false,
        settleLog: null,
        reason: 'native_list_failed',
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

    // undefined/true → false; false → true
    const newState = med.autoDeductEnabled === false;
    const { updatedMed, log: settleLog } = settleAutoDeductToggle(
      med,
      newState,
      todayStr,
      now
    );

    const medications = fresh.medications.map((m) =>
      m.id === opts.medicationId ? updatedMed : m
    );
    const logs = settleLog ? [settleLog, ...fresh.logs] : fresh.logs;

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

    const err = commitWithManualEnvelope({ medications, logs });
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
 * Exact FIRED reconciliation runs before any per-med legacy settlement.
 */
export function runGatedGlobalAutoDeductToggle(opts: {
  enable: boolean;
  todayStr?: string;
  now?: Date;
}): Promise<GatedGlobalAutoDeductToggleResult> {
  return withAutoStockMutationGate(async (freshIn: AutoStockDurableState) => {
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = recoverManualEnvelopeInto(freshIn);
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

    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: opts.enable,
      now,
    });
    if (pre.nativeListFailed) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        enable: opts.enable,
        settleLogs: [],
        reason: 'native_list_failed',
      };
    }
    const fresh = pre.state;
    const invalidatedMeds: Array<{ med: Medication; doseIds: string[] }> = [];

    // Invalidate all existing native recurrence chains before committing the
    // global policy change, so no old alarm can become FIRED after disable.
    for (const med of fresh.medications) {
      const invalidation = await invalidateMedicationRecurrences(med);
      if (!invalidation.ok) {
        for (const completed of invalidatedMeds) {
          if (completed.doseIds.length > 0) {
            await restoreInvalidatedRecurrences(completed.med, completed.doseIds, now);
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
      invalidatedMeds.push({ med, doseIds: invalidation.invalidatedDoseIds });
    }

    const settleLogs: ConsumptionLog[] = [];
    const medications = fresh.medications.map((med) => {
      const { updatedMed, log } = settleAutoDeductToggle(
        med,
        opts.enable,
        todayStr,
        now
      );
      if (log) settleLogs.push(log);
      return updatedMed;
    });
    const logs =
      settleLogs.length > 0 ? [...settleLogs, ...fresh.logs] : fresh.logs;

    const err = commitWithManualEnvelope({ medications, logs });
    if (err) {
      for (const invalidated of invalidatedMeds) {
        if (invalidated.doseIds.length > 0) {
          await restoreInvalidatedRecurrences(
            invalidated.med,
            invalidated.doseIds,
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
      logs,
      enable: opts.enable,
      settleLogs,
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
    const recovered = recoverManualEnvelopeInto(freshIn);
    if (!recovered.ok) {
      return {
        outcome: 'persist_failed' as const,
        medications: recovered.state.medications,
        logs: recovered.state.logs,
        reason: 'persist_failed',
      };
    }

    await acknowledgeExactAutoEvents(recovered.exactToAcknowledge);
    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: true,
    });
    if (pre.nativeListFailed) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        reason: 'native_list_failed',
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
    const err = commitWithManualEnvelope({
      medications,
      logs: pre.state.logs,
    });
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
    const todayStr = opts.todayStr ?? getTodayDateString();
    const now = opts.now ?? new Date();

    const recovered = recoverManualEnvelopeInto(freshIn);
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

    const pre = await reconcileExactBeforeLegacySettlement({
      fresh: recovered.state,
      globalAutoDeductEnabled: opts.globalAutoDeductEnabled !== false,
      now,
    });
    if (pre.nativeListFailed) {
      return {
        outcome: 'native_list_failed' as const,
        medications: pre.state.medications,
        logs: pre.state.logs,
        settleLog: null,
        reason: 'native_list_failed',
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

    const isDoseChanging = opts.medData.dailyDose !== freshMed.dailyDose;

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

    let stockBase = freshMed;
    let settleLog: ConsumptionLog | null = null;
    if (isDoseChanging) {
      const settled = settleDoseChange(
        freshMed,
        opts.medData.dailyDose,
        todayStr,
        now
      );
      stockBase = settled.updatedMed;
      settleLog = settled.log;
    }

    // Prune from durable/settled history + NEW schedule — never from React form history.
    // Authority: fresh durable state → settlement result → prune using final schedule.
    const forPrune: Omit<Medication, 'id' | 'createdAt'> = {
      ...opts.medData,
      // Override any form-snapshot history with durable/settled authority.
      doseConsumption: stockBase.doseConsumption,
      doseConsumptionHistory: stockBase.doseConsumptionHistory,
      doseSkippedHistory: stockBase.doseSkippedHistory,
    };
    const pruned = pruneDoseConsumption(forPrune, stockBase);

    // Build final med: user-editable fields from medData/pruned; stock/history from
    // stockBase then pruned schedule (pruned doseConsumption* wins over stockBase).
    const finalMed: Medication = {
      ...freshMed,
      ...pruned,
      id: freshMed.id,
      createdAt: freshMed.createdAt,
      currentPills: stockBase.currentPills,
      lastSyncDate: stockBase.lastSyncDate,
      lastConsumedDate: stockBase.lastConsumedDate,
      autoDeductEnabled: stockBase.autoDeductEnabled,
      // Explicitly take pruned history (not stockBase) so removed dose IDs stay gone.
      doseConsumption: pruned.doseConsumption,
      doseConsumptionHistory: pruned.doseConsumptionHistory,
      doseSkippedHistory:
        pruned.doseSkippedHistory ?? stockBase.doseSkippedHistory,
    };

    const medications = fresh.medications.map((m) =>
      m.id === opts.editId ? finalMed : m
    );
    const logs = settleLog ? [settleLog, ...fresh.logs] : fresh.logs;

    const err = commitWithManualEnvelope({ medications, logs });
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
