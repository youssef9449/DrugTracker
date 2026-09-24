/**
 * JS reconciliation of native exact-time auto-deduction FIRED events.
 * Idempotency:
 * - Per-dose consume/skip markers (same as Take)
 * - Existing exact auto log (deterministic id) for the occurrence
 *   NOT used to mark an occurrence as applied. Idempotency relies solely on
 *   durable occurrence-specific evidence.
 * Log identity for exact events is deterministic so retries do not create
 * duplicate ConsumptionLog rows.
 */
import type { ConsumptionLog, Medication } from '../types';
import type { AutoDeductionEvent } from './autoDeductionNativeTypes';
import { autoDeductionOccurrenceKey } from './autoDeductionNativeIdentity';
import { isValidCalendarDateString } from './date/calendarPrimitives';
import {
  isDoseConsumedOnDate,
  isDoseSkippedOnDate,
  recordDoseConsumed,
} from './dateCalculations';
export type ReconcileEventOutcome =
  | 'applied'
  | 'already_applied'
  | 'skipped_invalid'
  | 'skipped_missing_med'
  | 'skipped_disabled'; // retained for type compat; never used for valid FIRED
export interface ReconcileEventDetail {
  medicationId: string;
  doseId: string;
  calendarDate: string;
  amount: number;
  outcome: ReconcileEventOutcome;
  occurrenceKey: string;
}
export interface ReconcileFiredResult {
  medications: Medication[];
  logs: ConsumptionLog[];
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  details: ReconcileEventDetail[];
  mutated: boolean;
  /** Newly created exact-auto logs in this pass (for durability envelope). */
  newExactLogs: ConsumptionLog[];
}
function isValidEventAmount(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}
/**
 * Exact occurrence calendarDate must be a REAL calendar date (YYYY-MM-DD
 * shape + valid month/day incl. leap years) — semantically consistent with
 * the native contract (#523: native ExactAlarmContract/Calendar strict
 * validation). Impossible dates like 2026-02-31 are rejected on BOTH sides.
 * Invalid dates are unrecoverable identity failures — correcting the date
 * changes the occurrence key.
 */
export function isValidExactCalendarDate(calendarDate: string): boolean {
  return isValidCalendarDateString(calendarDate);
}
/**
 * Occurrence identity for Exact Auto is medicationId + doseId + calendarDate.
 * All three components are required and non-empty. Empty/missing doseId is
 * invalid — malformed identity cannot
 * be repaired by a later amount fix and must not remain FIRED forever (#262 F3).
 */
export function isValidExactOccurrenceIdentity(
  medicationId: string,
  doseId: string,
  calendarDate: string
): boolean {
  return (
    typeof medicationId === 'string' &&
    medicationId.trim().length > 0 &&
    typeof doseId === 'string' &&
    doseId.trim().length > 0 &&
    isValidExactCalendarDate(calendarDate)
  );
}
/**
 * Normalize doseId for keying. Does not invent an identity for missing values —
 * null/undefined become '' which fails {@link isValidExactOccurrenceIdentity}.
 */
export function normalizeExactDoseId(doseId: string | undefined | null): string {
  if (doseId == null) return '';
  return String(doseId).trim();
}
/**
 * Deterministic log id for one exact auto occurrence (retry-safe).
 * Reconciliation is occurrence-based.
 * Issue current occurrence-identity contract: this id MUST never be built with an empty doseId.
 * `applyExactAutoEventToMedication` rejects any event whose `doseId` is empty
 * (malformed identity → terminal ACK at the runner level, before apply).
 * A FIRED Exact occurrence that already fired is durable: its identity is
 * `medicationId + doseId + calendarDate` and `event.amount` is the
 * authoritative charge, even if the dose was later edited or removed from
 * the Medication's current `doseSchedule`. `doseSchedule` is the sole source
 * for scheduling FUTURE occurrences, NOT a precondition for reconciling a
 * FIRED one.
 */
export function exactAutoLogId(
  medicationId: string,
  doseId: string,
  calendarDate: string
): string {
  const d = normalizeExactDoseId(doseId);
  // Avoid characters that are awkward in some storage contexts; keep readable.
  return `exact-auto:${medicationId}:${d}:${calendarDate}`;
}
export function findExactAutoLog(
  logs: ConsumptionLog[],
  medicationId: string,
  doseId: string,
  calendarDate: string
): ConsumptionLog | undefined {
  const id = exactAutoLogId(medicationId, doseId, calendarDate);
  return logs.find((l) => l.id === id);
}

/**
 * THE canonical exact-occurrence settlement decision (#532).
 *
 * Every caller (reconciliation, defensive apply gate, UI evidence lookups)
 * branches on this ONE typed result instead of independently re-deriving
 * whether an occurrence is already applied:
 * - `logged`   — the deterministic exact-auto log row exists.
 * - `consumed` — a durable per-dose consume marker exists.
 * - `skipped`  — a durable per-dose skip/restore marker exists.
 * - `unsettled` — no durable evidence; the occurrence may be applied.
 *
 * Duplicate settlement stays impossible under retries/replay/concurrency:
 * every settlement path consults the same durable evidence through here.
 */
export type ExactOccurrenceSettlement =
  | { state: 'unsettled' }
  | { state: 'logged'; source: 'exact_log' }
  | { state: 'consumed'; source: 'consume_marker' }
  | { state: 'skipped'; source: 'skip_marker' };

export function getExactOccurrenceSettlementState(
  logs: ConsumptionLog[],
  med: Medication,
  doseId: string,
  calendarDate: string
): ExactOccurrenceSettlement {
  const id = normalizeExactDoseId(doseId);
  if (!id) return { state: 'unsettled' };
  if (findExactAutoLog(logs, med.id, id, calendarDate)) {
    return { state: 'logged', source: 'exact_log' };
  }
  if (isDoseConsumedOnDate(med, id, calendarDate)) {
    return { state: 'consumed', source: 'consume_marker' };
  }
  if (isDoseSkippedOnDate(med, id, calendarDate)) {
    return { state: 'skipped', source: 'skip_marker' };
  }
  return { state: 'unsettled' };
}

/**
 * Boolean convenience over {@link getExactOccurrenceSettlementState} —
 * whether the occurrence is already reflected in JS stock semantics.
 * Kept as the named evidence-consumption API for callers/tests that only
 * need the boolean; the typed decision is canonical.
 */
export function isExactAutoOccurrenceApplied(
  med: Medication,
  doseId: string,
  calendarDate: string
): boolean {
  const settlement = getExactOccurrenceSettlementState([], med, doseId, calendarDate);
  return settlement.state !== 'unsettled';
}
/**
 * Locate a native Exact Auto occurrence that is FIRED and not yet reconciled
 * for the given medicationId + doseId + calendarDate.
 * When present, event.amount is the authoritative requested amount for this
 * occurrence (even if Medication.doseSchedule was edited after scheduling).
 */
export function findPendingExactAutoOccurrence(
  events: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
    amount: number;
    status: string;
    reconciledAtEpochMs?: number | null;
  }>,
  medicationId: string,
  doseId: string | undefined,
  calendarDate: string
): { medicationId: string; doseId: string; calendarDate: string; amount: number; status: string } | null {
  const wantDose = normalizeExactDoseId(doseId);
  for (const ev of events) {
    if (ev.medicationId !== medicationId) continue;
    if (ev.calendarDate !== calendarDate) continue;
    if (normalizeExactDoseId(ev.doseId) !== wantDose) continue;
    const status = String(ev.status || '').toUpperCase();
    if (status !== 'FIRED') continue;
    if (ev.reconciledAtEpochMs != null) continue;
    return ev;
  }
  return null;
}
export function applyExactAutoEventToMedication(
  med: Medication,
  event: AutoDeductionEvent,
  now: Date = new Date()
): { ok: true; updatedMed: Medication; log: ConsumptionLog } | { ok: false; reason: string } {
  // A FIRED Exact occurrence is durable: the native
  // AlarmManager created and persisted it at schedule time with identity
  // (medicationId + doseId + calendarDate) and `event.amount`. Editing or
  // removing the dose from the Medication's CURRENT `doseSchedule` AFTER the
  // alarm fired does NOT invalidate the already-occurred event; `event.amount`
  // is the authoritative charge. `doseSchedule` is the sole source for
  // scheduling FUTURE occurrences, NOT a precondition for reconciling a FIRED
  // one.
  // Exact FIRED is the SOLE source of timed automatic stock deduction. There
  // is NO historical / day-based settlement folded into this apply: the stock
  // change is exactly `currentPills → currentPills - event.amount` (clamped
  // at zero). No `computeDueDoseBreakdown`, no `historicalRangeDueUnits`, no
  // A single FIRED event charges its own amount only; past calendar days are
  // not auto-settled by this path.
  // Apply validation: positive finite
  // amount, non-empty doseId, valid YYYY-MM-DD calendarDate, occurrence not
  // already applied.
  if (!isValidEventAmount(event.amount)) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const doseId = normalizeExactDoseId(event.doseId);
  const calendarDate = event.calendarDate;
  if (!calendarDate || calendarDate.length !== 10) {
    return { ok: false, reason: 'invalid_calendarDate' };
  }
  // Empty doseId is a malformed identity — rejected here, and the runner
  // treats it as terminal ACK (no infinite retry). This is the ONLY identity
  // failure that prevents a FIRED occurrence from applying.
  if (!doseId) {
    return { ok: false, reason: 'invalid_dose_id' };
  }
  if (
    getExactOccurrenceSettlementState([], med, doseId, calendarDate).state !== 'unsettled'
  ) {
    return { ok: false, reason: 'already_applied' };
  }
  // Native Auto is the stock authority for normal reconciliation. When the
  // event was already applied natively, currentPills is already the post-dose
  // balance and JS MUST NOT subtract again. The event carries actualDeducted
  // from the idempotent Native occurrence marker for exact log/history evidence.
  const settleBase = Math.max(0, med.currentPills);
  const requested = event.amount;
  let actualDeducted = Math.min(Math.max(0, requested), settleBase);
  let newPills = settleBase - actualDeducted;
  if (event.nativeStockApplied === true) {
    // #524: the native result is validated against the operation contract
    // BEFORE it may mutate JS state or write the settlement log:
    //   0 <= actualDeducted <= requested  AND  actualDeducted <= settleBase.
    // nativeStockApplied=true with a missing/invalid amount is a contract
    // violation — observable (warn) and unreconciled (fail-closed), never
    // an oversized or fabricated settlement.
    const nativeActual = Number(event.actualDeducted);
    const violatesContract =
      !Number.isFinite(nativeActual) ||
      nativeActual < 0 ||
      nativeActual > requested ||
      nativeActual > settleBase;
    if (violatesContract) {
      console.warn(
        '[exact-auto] native stock result violates the operation contract:',
        { requested, settleBase, nativeActual, medicationId: med.id, doseId, calendarDate }
      );
      return { ok: false, reason: 'native_stock_result_contract_violation' };
    }
    actualDeducted = nativeActual;
    newPills = settleBase;
  }
  let nextHistory = med.doseConsumptionHistory;
  let lastConsumedDate = med.lastConsumedDate;
  const recorded = recordDoseConsumed(med, doseId, calendarDate);
  nextHistory = recorded.doseConsumptionHistory;
  // Exact Auto updates lastConsumedDate ONLY when the Medication still has an
  // explicit, non-empty `doseSchedule` AND every slot for the calendar day is
  // consumed. A med whose schedule was removed (or edited so this slot is no
  // longer a member) still gets its FIRED occurrence applied via event.amount,
  // but with no schedule to test all-slots-consumed it does NOT write
  // lastConsumedDate is not used as a dose-specific write target.
  // #268 / .
  if (Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0) {
    const allConsumed = med.doseSchedule.every((d) =>
      normalizeExactDoseId(d.id) === doseId
        ? true
        : isDoseConsumedOnDate(
            {
              ...med,
              doseConsumptionHistory: nextHistory,
            },
            d.id,
            calendarDate
          )
    );
    if (allConsumed) {
      lastConsumedDate = calendarDate;
    }
  }
  // mutation settlement would advance it).
  const updatedMed: Medication = {
    ...med,
    currentPills: newPills,
    lastConsumedDate,
    doseConsumptionHistory: nextHistory,
  };
  const log: ConsumptionLog = {
    id: exactAutoLogId(med.id, doseId, calendarDate),
    medicationId: med.id,
    medicationName: med.name,
    type: 'exact_auto',
    amount: -actualDeducted,
    date: calendarDate,
    timestamp: new Date(now).toISOString(),
    description: `خصم تلقائي دقيق (−${actualDeducted} ${med.unit || 'وحدة'})`,
    doseId,
  };
  return { ok: true, updatedMed, log };
}
export function reconcileFiredEvents(
  medications: Medication[],
  logs: ConsumptionLog[],
  events: AutoDeductionEvent[],
  options: {
    globalAutoDeductEnabled?: boolean;
    now?: Date;
  } = {}
): ReconcileFiredResult {
  const now = options.now ?? new Date();
  const sorted = [...events].sort((a, b) => {
    const ta = Number(a.scheduledAtEpochMs) || 0;
    const tb = Number(b.scheduledAtEpochMs) || 0;
    if (ta !== tb) return ta - tb;
    const ka = autoDeductionOccurrenceKey(a.medicationId, a.doseId, a.calendarDate);
    const kb = autoDeductionOccurrenceKey(b.medicationId, b.doseId, b.calendarDate);
    return ka.localeCompare(kb);
  });
  const medById = new Map<string, Medication>();
  for (const m of medications) {
    medById.set(m.id, m);
  }
  let workingLogs = [...logs];
  const newExactLogs: ConsumptionLog[] = [];
  const details: ReconcileEventDetail[] = [];
  const toAcknowledge: ReconcileFiredResult['toAcknowledge'] = [];
  let mutated = false;
  for (const event of sorted) {
    const medicationId = event.medicationId ?? '';
    const doseId = normalizeExactDoseId(event.doseId);
    const calendarDate = event.calendarDate ?? '';
    const occurrenceKey = autoDeductionOccurrenceKey(medicationId, doseId, calendarDate);
    const amount = event.amount;
    const baseDetail = {
      medicationId,
      doseId,
      calendarDate,
      amount: Number(amount) || 0,
      occurrenceKey,
    };
    // Validation order:
    //   1) occurrence identity (medicationId + doseId + calendarDate) —
    //      terminal ACK if any component is missing/invalid
    //   2) amount — no ACK (retryable when identity is valid)
    if (!isValidExactOccurrenceIdentity(medicationId, doseId, calendarDate)) {
      details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      // Terminal: malformed identity cannot become a valid Exact occurrence
      // without changing the key. ACK via existing markReconciled path so the
      // native FIRED row does not retry forever.
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }
    // Invalid amount: record skipped_invalid but do NOT ACK. Leaving the
    // native FIRED row unreconciled preserves evidence for a later pass with
    // a corrected valid amount (no stock effect was durable this pass).
    if (!isValidEventAmount(amount)) {
      details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      continue;
    }
    const med = medById.get(medicationId);
    if (!med) {
      details.push({ ...baseDetail, outcome: 'skipped_missing_med' });
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }
    // A durable FIRED event means the exact occurrence already fired.
    // Current global/per-med enabled flags must NOT turn it into a no-op;
    // disabled state only prevents future scheduling/recurrence.
    // (skipped_disabled is never applied to a valid FIRED occurrence.)
    // Durable settlement evidence already present for this occurrence →
    // branch on the ONE canonical settlement decision (#532) instead of
    // independently re-deriving already-applied policy per layer.
    const settlement = getExactOccurrenceSettlementState(
      workingLogs,
      med,
      doseId,
      calendarDate
    );
    if (settlement.state !== 'unsettled') {
      details.push({ ...baseDetail, outcome: 'already_applied' });
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }
    const applied = applyExactAutoEventToMedication(med, event, now);
    if (!applied.ok) {
      if (applied.reason === 'already_applied') {
        // Durable marker/log already reflects stock — safe to ACK.
        details.push({ ...baseDetail, outcome: 'already_applied' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
      } else if (applied.reason === 'invalid_calendarDate') {
        // Identity malformed (should normally be filtered above). Terminal ACK.
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
      } else if (applied.reason === 'invalid_dose_id') {
        // Malformed identity (empty doseId) — terminal ACK (no infinite retry).
        // The apply gate normally filters this, but this defensive branch keeps
        // the contract airtight if amount/date were valid but doseId empty.
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
      } else if (
        applied.reason === 'invalid_native_stock_result' ||
        applied.reason === 'native_stock_result_contract_violation'
      ) {
        // #524: malformed/oversized native result — no stock mutation, no
        // log, NO ACK. Stays unreconciled and observable for diagnosis.
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      } else if (applied.reason === 'invalid_amount') {
        // Valid identity, invalid amount → no stock mutation, no log, NO ACK.
        // Stays unreconciled for a later pass with a corrected valid amount.
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      } else {
        // Unknown apply failure: no stock mutation; do not invent policy.
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      }
      continue;
    }
    medById.set(medicationId, applied.updatedMed);
    workingLogs = [applied.log, ...workingLogs];
    newExactLogs.push(applied.log);
    mutated = true;
    details.push({ ...baseDetail, outcome: 'applied' });
    toAcknowledge.push({ medicationId, doseId, calendarDate });
  }
  const updatedMeds = medications.map((m) => medById.get(m.id) ?? m);
  return {
    medications: updatedMeds,
    logs: workingLogs,
    toAcknowledge,
    details,
    mutated,
    newExactLogs,
  };
}