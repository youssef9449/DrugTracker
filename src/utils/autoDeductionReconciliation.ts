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
import { LEGACY_DOSE_ID } from './notifications';

export type ReconcileEventOutcome =
  | 'applied'
  | 'already_applied'
  | 'skipped_invalid'
  | 'skipped_missing_med'
  | 'skipped_disabled';

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

export function normalizeExactDoseId(doseId: string | undefined | null): string {
  if (doseId == null || doseId === '') return LEGACY_DOSE_ID;
  return doseId;
}

/**
 * Deterministic log id for one exact auto occurrence (retry-safe).
 * Not used for legacy bulk auto_daily logs from syncAutoDailyDeductions.
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
 * 2. legacy lastConsumedDate for single-dose
 * 3. lastSyncDate day-settlement horizon — past days already settled into
 *    currentPills by syncAutoDailyDeductions (no fake consume markers invented)
 */
export function isExactAutoOccurrenceApplied(
  med: Medication,
  doseId: string,
  calendarDate: string,
  todayStr: string = getTodayDateString()
): boolean {
  const id = normalizeExactDoseId(doseId);
  const multi = Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;

  if (!multi || id === LEGACY_DOSE_ID) {
    if (med.lastConsumedDate === calendarDate) return true;
    if (isDoseConsumedOnDate(med, LEGACY_DOSE_ID, calendarDate)) return true;
    if (isDoseSkippedOnDate(med, LEGACY_DOSE_ID, calendarDate)) return true;
  } else {
    if (isDoseConsumedOnDate(med, id, calendarDate)) return true;
    if (isDoseSkippedOnDate(med, id, calendarDate)) return true;
  }

  const lastSync = med.lastSyncDate;
  if (lastSync && calendarDate.length === 10) {
    // Past calendar day already included in day settlement into currentPills
    if (calendarDate < todayStr && calendarDate <= lastSync) {
      return true;
    }
    // Legacy non-schedule: sync settles today when lastSync advances to today
    if (!multi && calendarDate === todayStr && lastSync === todayStr) {
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

  if (doseId === LEGACY_DOSE_ID || !Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    lastConsumedDate = calendarDate;
    const recorded = recordDoseConsumed(med, LEGACY_DOSE_ID, calendarDate);
    nextConsumption = recorded.doseConsumption;
    nextHistory = recorded.doseConsumptionHistory;
  } else {
    const recorded = recordDoseConsumed(med, doseId, calendarDate);
    nextConsumption = recorded.doseConsumption;
    nextHistory = recorded.doseConsumptionHistory;
    const allConsumed =
      Array.isArray(med.doseSchedule) &&
      med.doseSchedule.every((d) =>
        d.id === doseId
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
    doseId: doseId === LEGACY_DOSE_ID ? undefined : doseId,
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
  const globalOn = options.globalAutoDeductEnabled !== false;
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

    if (!medicationId || !calendarDate) {
      details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      continue;
    }

    if (!isValidEventAmount(amount)) {
      details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }

    const med = medById.get(medicationId);
    if (!med) {
      details.push({ ...baseDetail, outcome: 'skipped_missing_med' });
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }

    if (!globalOn || med.autoDeductEnabled === false) {
      details.push({ ...baseDetail, outcome: 'skipped_disabled' });
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }

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
        details.push({ ...baseDetail, outcome: 'already_applied' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
      } else {
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
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
