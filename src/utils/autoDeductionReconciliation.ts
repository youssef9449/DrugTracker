/**
 * Phase 3 — JS reconciliation of native exact-time auto-deduction FIRED events.
 *
 * Idempotency:
 * - Per-dose consume/skip markers (same as Take)
 * - Existing exact auto log (deterministic id) for the occurrence
 *   NOT used to mark an occurrence as applied. Idempotency relies solely on
 *   durable occurrence-specific evidence.
 *
 * Log identity for exact events is deterministic so retries do not create
 * duplicate ConsumptionLog rows.
 */

import type { ConsumptionLog, Medication } from '../types';
import type { AutoDeductionEvent } from './autoDeductionNative';
import { autoDeductionOccurrenceKey } from './autoDeductionNative';
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
 * Exact occurrence calendarDate must be YYYY-MM-DD (same shape as native
 * AutoDeductionContract.isValidCalendarDate). Invalid dates are unrecoverable
 * identity failures — correcting the date changes the occurrence key.
 */
export function isValidExactCalendarDate(calendarDate: string): boolean {
  if (!calendarDate || calendarDate.length !== 10) return false;
  if (calendarDate.charAt(4) !== '-' || calendarDate.charAt(7) !== '-') {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = calendarDate.charAt(i);
    if (c < '0' || c > '9') return false;
  }
  return true;
}

/**
 * Occurrence identity for Exact Auto is medicationId + doseId + calendarDate.
 * All three components are required and non-empty. Empty/missing doseId is
 * invalid (not a legacy sentinel) — Issue #268. Malformed identity cannot
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
 * `syncAutoDailyDeductions` that produced them was removed in Issue #268 /
 * PR #271).
 *
 * Issue #268 / PR #271: this id MUST never be built with an empty doseId.
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
 * Whether this occurrence is already reflected in JS stock semantics.
 *
 * Sources (any one is enough):
 * 1. dose consume / skip history (Take, prior exact apply, Restore skip)
 * 2. existing exact auto log for this occurrence (deterministic id)
 *
 * NOT prevent a FIRED event from being applied. Idempotency relies solely
 * on durable occurrence-specific evidence (consume/skip markers + the
 * deterministic exact log id), not on a global date-based settlement
 * horizon.
 */
export function isExactAutoOccurrenceApplied(
  med: Medication,
  doseId: string,
  calendarDate: string
): boolean {
  const id = normalizeExactDoseId(doseId);
  if (!id) return false;

  if (isDoseConsumedOnDate(med, id, calendarDate)) return true;
  if (isDoseSkippedOnDate(med, id, calendarDate)) return true;

  return false;
}


/**
 * Locate a native Exact Auto occurrence that is FIRED and not yet reconciled
 * for the given medicationId + doseId + calendarDate.
 *
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
  // Issue #265 / #268 — a FIRED Exact occurrence is durable: the native
  // AlarmManager created and persisted it at schedule time with identity
  // (medicationId + doseId + calendarDate) and `event.amount`. Editing or
  // removing the dose from the Medication's CURRENT `doseSchedule` AFTER the
  // alarm fired does NOT invalidate the already-occurred event; `event.amount`
  // is the authoritative charge. `doseSchedule` is the sole source for
  // scheduling FUTURE occurrences, NOT a precondition for reconciling a FIRED
  // one.
  //
  // Exact FIRED is the SOLE source of timed automatic stock deduction. There
  // is NO historical / day-based settlement folded into this apply: the stock
  // change is exactly `currentPills → currentPills - event.amount` (clamped
  // at zero). No `computeDueDoseBreakdown`, no `historicalRangeDueUnits`, no
  // A single FIRED event charges its own amount only; past calendar days are
  // not auto-settled by this path.
  //
  // Apply validation (no Legacy Single-Dose fallback): positive finite
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

  if (isExactAutoOccurrenceApplied(med, doseId, calendarDate)) {
    return { ok: false, reason: 'already_applied' };
  }

  // Stock deduction is exactly event.amount (clamped at zero). No historical
  // / day-based settlement is folded into this apply — Exact FIRED is the
  // amount charged for this FIRED occurrence.
  const settleBase = Math.max(0, med.currentPills);
  const requested = event.amount;
  // Actual stock change after clamping at zero (may be < requested).
  const actualDeducted = Math.min(Math.max(0, requested), settleBase);
  const newPills = settleBase - actualDeducted;
  let nextHistory = med.doseConsumptionHistory;
  let lastConsumedDate = med.lastConsumedDate;

  const recorded = recordDoseConsumed(med, doseId, calendarDate);
  nextHistory = recorded.doseConsumptionHistory;
  // Exact Auto updates lastConsumedDate ONLY when the Medication still has an
  // explicit, non-empty `doseSchedule` AND every slot for the calendar day is
  // consumed. A med whose schedule was removed (or edited so this slot is no
  // longer a member) still gets its FIRED occurrence applied via event.amount,
  // but with no schedule to test all-slots-consumed it does NOT write
  // lastConsumedDate — there is no Legacy Single-Dose doseId-only write.
  // #268 / PR #271.
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

    // Validation order (#262 Finding 3 / Issue #268):
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

    // Durable log already present for this occurrence → stock marker path
    if (findExactAutoLog(workingLogs, medicationId, doseId, calendarDate)) {
      details.push({ ...baseDetail, outcome: 'already_applied' });
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }

    if (isExactAutoOccurrenceApplied(med, doseId, calendarDate)) {
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
