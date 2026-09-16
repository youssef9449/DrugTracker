/**
 * Phase 4 — Manual Take / Restore through the same durable stock gate as
 * exact auto-deduction reconciliation.
 *
 * Callers must NOT treat React snapshots as authoritative. Each entry loads
 * fresh localStorage state, applies pure medActions helpers, commits, and
 * returns the post-commit durable arrays for React to follow.
 *
 * Crash consistency — dedicated Manual JS envelope (NOT Exact Auto envelope):
 *   1. Write manual_js_ready envelope with intended meds+logs only
 *   2. commitDurableAutoStockState (meds then logs)
 *   3. Clear Manual envelope on full success
 *
 * Manual envelope never carries native toAcknowledge. Exact Auto reconciliation
 * alone ACKs real FIRED events after reading the native ledger.
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
import { loadJson, persist } from './storage';

/** Dedicated Manual recovery key — must not share Exact Auto envelope storage. */
export const STORAGE_MANUAL_ENVELOPE_KEY =
  'android_med_tracker_manual_stock_envelope_v1';

/**
 * JS-only recovery payload for Manual Take/Restore partial writes.
 * Intentionally has no toAcknowledge — native markReconciled is Exact Auto only.
 */
export interface ManualStockEnvelope {
  version: 1;
  status: 'manual_js_ready';
  medications: Medication[];
  logs: ConsumptionLog[];
  createdAt: string;
}

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

/** @internal test-only */
let testLoadManualEnvelope: (() => ManualStockEnvelope | null) | null = null;
let testSaveManualEnvelope:
  | ((env: ManualStockEnvelope | null) => string | null)
  | null = null;

/** @internal test-only */
export function __setManualEnvelopeTestHooks(hooks: {
  load?: () => ManualStockEnvelope | null;
  save?: (env: ManualStockEnvelope | null) => string | null;
} | null): void {
  testLoadManualEnvelope = hooks?.load ?? null;
  testSaveManualEnvelope = hooks?.save ?? null;
}

export function loadManualStockEnvelope(): ManualStockEnvelope | null {
  if (testLoadManualEnvelope) return testLoadManualEnvelope();
  const raw = loadJson<ManualStockEnvelope | null>(
    STORAGE_MANUAL_ENVELOPE_KEY,
    null
  );
  if (!raw || raw.version !== 1 || raw.status !== 'manual_js_ready') return null;
  if (!Array.isArray(raw.medications) || !Array.isArray(raw.logs)) return null;
  return raw;
}

export function saveManualStockEnvelope(
  env: ManualStockEnvelope | null
): string | null {
  if (testSaveManualEnvelope) return testSaveManualEnvelope(env);
  if (env == null) {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_MANUAL_ENVELOPE_KEY);
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  return persist(STORAGE_MANUAL_ENVELOPE_KEY, env, { json: true });
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

/**
 * Persist Manual recovered meds+logs as one durable pair.
 * Envelope must only be cleared by the caller after this returns null.
 * Never calls markReconciled.
 */
export function persistManualRecoveredPair(
  state: AutoStockDurableState,
  opts?: {
    /** Test injectors: both required; failure of either keeps envelope. */
    persistMeds?: (meds: Medication[]) => string | null;
    persistLogs?: (logs: ConsumptionLog[]) => string | null;
  }
): string | null {
  if (opts?.persistMeds && opts?.persistLogs) {
    const medErr = opts.persistMeds(state.medications);
    if (medErr) return medErr;
    const logErr = opts.persistLogs(state.logs);
    if (logErr) return logErr;
    return null;
  }
  // Production path: same meds-then-logs contract as withAutoStockMutationGate.
  return commitDurableAutoStockState(state);
}

/**
 * Finish a prior Manual partial write: meds+logs only. Never markReconciled.
 * Clears Manual envelope only after both durable writes succeed.
 */
export function recoverManualEnvelopeInto(
  fresh: AutoStockDurableState,
  opts?: {
    persistMeds?: (meds: Medication[]) => string | null;
    persistLogs?: (logs: ConsumptionLog[]) => string | null;
  }
): { ok: true; state: AutoStockDurableState } | { ok: false; state: AutoStockDurableState } {
  const existing = loadManualStockEnvelope();
  if (!existing) {
    return { ok: true, state: fresh };
  }
  const pair: AutoStockDurableState = {
    medications: existing.medications,
    logs: existing.logs,
  };
  const err = persistManualRecoveredPair(pair, opts);
  if (err) {
    // Leave Manual envelope for retry; do not ACK native.
    return { ok: false, state: fresh };
  }
  saveManualStockEnvelope(null);
  return { ok: true, state: pair };
}

/**
 * Manual durability: envelope (JS state only) → meds+logs → clear.
 * No native acknowledgement list.
 */
function commitWithManualEnvelope(state: AutoStockDurableState): string | null {
  const envelope: ManualStockEnvelope = {
    version: 1,
    status: 'manual_js_ready',
    medications: state.medications,
    logs: state.logs,
    createdAt: new Date().toISOString(),
  };
  const envErr = saveManualStockEnvelope(envelope);
  if (envErr) return envErr;

  const commitErr = commitDurableAutoStockState(state);
  if (commitErr) {
    // Leave Manual envelope so recovery can finish both keys (no native ACK).
    return commitErr;
  }

  saveManualStockEnvelope(null);
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
    const err = commitWithManualEnvelope({ medications, logs });
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
  makeLogId?: () => string;
}): Promise<GatedManualRestoreResult> {
  const todayStr = opts.todayStr ?? getTodayDateString();
  const now = opts.now ?? new Date();

  return withAutoStockMutationGate((freshIn: AutoStockDurableState) => {
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

    const err = commitWithManualEnvelope({ medications, logs });
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
