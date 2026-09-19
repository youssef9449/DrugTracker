/**
 * Phase 3 — JS reconciliation of native exact-time auto-deduction FIRED events.
 *
 * Idempotency vs legacy syncAutoDailyDeductions:
 * - Per-dose consume/skip markers (same as Take)
 * - lastSyncDate day-settlement horizon: past calendar days already folded
 *   into currentPills by gated/legacy sync are treated as applied without
 *   inventing fake consume markers for slots that were only day-settled
 *
 * Log identity for exact events is deterministic so retries do not create
 * duplicate ConsumptionLog rows.
 */

import type { ConsumptionLog, Medication } from '../types';
import type { AutoDeductionEvent } from './autoDeductionNative';
import { autoDeductionOccurrenceKey } from './autoDeductionNative';
import {
  computeDueDoseBreakdown,
  getTodayDateString,
  historicalRangeDueUnits,
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
 * Not used for legacy bulk auto_daily logs from syncAutoDailyDeductions.
 *
 * Issue #268 / PR #271: this id MUST never be built with an empty doseId.
 * The only valid path to here is through {@link applyExactAutoEventToMedication},
 * which rejects any Medication without a non-empty `doseSchedule` whose array
 * contains `doseId`. Callers that bypass that gate (none in production) would
 * produce an id shaped `exact-auto:<med>::<date>` — that is rejected upstream by
 * `isValidExactOccurrenceIdentity` and never persisted as an Exact log.
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
 * 2. lastSyncDate day-settlement horizon — past days already settled into
 *    currentPills by syncAutoDailyDeductions (no fake consume markers invented)
 */
export function isExactAutoOccurrenceApplied(
  med: Medication,
  doseId: string,
  calendarDate: string,
  todayStr: string = getTodayDateString()
): boolean {
  const id = normalizeExactDoseId(doseId);
  if (!id) return false;

  if (isDoseConsumedOnDate(med, id, calendarDate)) return true;
  if (isDoseSkippedOnDate(med, id, calendarDate)) return true;

  const lastSync = med.lastSyncDate;
  if (lastSync && calendarDate.length === 10) {
    // Past calendar day already included in day settlement into currentPills
    if (calendarDate < todayStr && calendarDate <= lastSync) {
      return true;
    }
  }

  return false;
}


/** Local calendar day before YYYY-MM-DD, or null if invalid. */
function calendarDayBefore(calendarDate: string): string | null {
  if (!calendarDate || calendarDate.length !== 10) return null;
  try {
    const y = parseInt(calendarDate.slice(0, 4), 10);
    const m = parseInt(calendarDate.slice(5, 7), 10);
    const d = parseInt(calendarDate.slice(8, 10), 10);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - 1);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  } catch {
    return null;
  }
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

/**
 * Issue #268 / PR #271 — Exact occurrence identity is authoritative ONLY when
 * the Medication carries an explicit, non-empty `doseSchedule` AND the event's
 * `doseId` is a member of that schedule. No synthetic/legacy identity, no
 * `dailyDose`/`reminderTime`/`reminderEnabled`/`lastConsumedDate` fallback, no
 * "first/next dose", no array-index, no empty/sentinel doseId.
 *
 * This is the single source of truth for whether an Exact stock mutation may
 * run. Returning false here means: no deduction, no Exact log, no applied
 * marker — the caller MUST treat the event as not-applicable (not as a
 * malformed identity that requires terminal ACK).
 */
export function isExactDoseScheduleMember(
  med: Medication,
  doseId: string
): boolean {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return false;
  }
  const id = normalizeExactDoseId(doseId);
  if (!id) return false;
  return med.doseSchedule.some((d) => normalizeExactDoseId(d.id) === id);
}

export function applyExactAutoEventToMedication(
  med: Medication,
  event: AutoDeductionEvent,
  now: Date = new Date()
): { ok: true; updatedMed: Medication; log: ConsumptionLog } | { ok: false; reason: string } {
  if (!isValidEventAmount(event.amount)) {
    return { ok: false, reason: 'invalid_amount' };
  }

  const doseId = normalizeExactDoseId(event.doseId);
  const calendarDate = event.calendarDate;
  if (!calendarDate || calendarDate.length !== 10) {
    return { ok: false, reason: 'invalid_calendarDate' };
  }

  // Issue #268 / PR #271 — Exact stock mutation requires an explicit,
  // non-empty `doseSchedule` whose array contains the event doseId. A
  // Medication without/with-empty `doseSchedule`, or an event whose doseId
  // is not a schedule member, CANNOT produce an Exact occurrence. No
  // legacy single-dose fallback, no dailyDose/reminderTime/lastConsumedDate
  // fallback, no first/next/index fallback. Do not deduct, do not log,
  // do not touch lastConsumedDate.
  if (!isExactDoseScheduleMember(med, doseId)) {
    return { ok: false, reason: 'invalid_dose_schedule' };
  }

  const todayStr = getTodayDateString();
  if (isExactAutoOccurrenceApplied(med, doseId, calendarDate, todayStr)) {
    return { ok: false, reason: 'already_applied' };
  }

  // Historical settlement while applying exact event on day D must cover only
  // days strictly after lastSync and strictly before D — never the event day
  // itself (that occurrence is charged solely via event.amount). Same-day
  // sibling doses on D are left for their own exact events / later legacy path.
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);
  const lastSync = med.lastSyncDate || todayStr;
  let priorHistoricalUnits = 0;
  if (
    breakdown.gated &&
    med.autoDeductEnabled !== false &&
    calendarDate > lastSync
  ) {
    priorHistoricalUnits = historicalRangeDueUnits(med, lastSync, calendarDate);
  }
  const settleBase = Math.max(0, med.currentPills - priorHistoricalUnits);

  const requested = event.amount;
  // Actual stock change after clamping at zero (may be < requested).
  const actualDeducted = Math.min(Math.max(0, requested), settleBase);
  const newPills = settleBase - actualDeducted;

  let nextConsumption = med.doseConsumption;
  let nextHistory = med.doseConsumptionHistory;
  let lastConsumedDate = med.lastConsumedDate;

  const recorded = recordDoseConsumed(med, doseId, calendarDate);
  nextConsumption = recorded.doseConsumption;
  nextHistory = recorded.doseConsumptionHistory;
  // Exact Auto only updates lastConsumedDate when every slot for the calendar
  // day is consumed. The apply gate above already guarantees a non-empty
  // explicit doseSchedule and that `doseId` is a member, so there is no
  // Legacy Single-Dose path here — lastConsumedDate is set ONLY when all
  // schedule slots for the calendar day are consumed. #268 / PR #271.
  const allConsumed = med.doseSchedule!.every((d) =>
    normalizeExactDoseId(d.id) === doseId
      ? true
      : isDoseConsumedOnDate(
          {
            ...med,
            doseConsumption: nextConsumption,
            doseConsumptionHistory: nextHistory,
          },
          d.id,
          calendarDate
        )
  );
  if (allConsumed) {
    lastConsumedDate = calendarDate;
  }

  // If prior days (after lastSync, before event day) were folded into the
  // snapshot, advance lastSync to the day before the event (end of that
  // exclusive-end window). Do NOT jump to today — that would imply the
  // rest of the event day and later days were settled.
  let lastSyncDate = med.lastSyncDate || todayStr;
  if (priorHistoricalUnits > 0) {
    const prev = calendarDayBefore(calendarDate);
    if (prev && prev > lastSyncDate) {
      lastSyncDate = prev;
    }
  }

  const updatedMed: Medication = {
    ...med,
    currentPills: newPills,
    lastSyncDate,
    lastConsumedDate,
    doseConsumption: nextConsumption,
    doseConsumptionHistory: nextHistory,
  };

  const log: ConsumptionLog = {
    id: exactAutoLogId(med.id, doseId, calendarDate),
    medicationId: med.id,
    medicationName: med.name,
    type: 'auto_daily',
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
  const todayStr = getTodayDateString();

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

    if (isExactAutoOccurrenceApplied(med, doseId, calendarDate, todayStr)) {
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
      } else if (applied.reason === 'invalid_amount') {
        // Amount still retryable — defensive if amount gate is bypassed.
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      } else if (applied.reason === 'invalid_dose_schedule') {
        // Issue #268 / PR #271: Medication has no/empty doseSchedule, or the
        // event doseId is not a member of it. The occurrence identity itself
        // is well-formed (medicationId + doseId + calendarDate all valid) and
        // the amount is positive — this is NOT a malformed identity that must
        // be terminalized. The event may become applicable later if the
        // Medication is edited to add a matching doseSchedule, so leave the
        // native FIRED row unreconciled (no ACK) — identical to the invalid
        // amount contract: no stock mutation, no Exact log, retryable.
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
