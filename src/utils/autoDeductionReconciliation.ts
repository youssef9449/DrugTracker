/**
 * Phase 3 — JS reconciliation of native exact-time auto-deduction FIRED events.
 *
 * Crash-safe protocol (localStorage + native SharedPreferences are not one TX):
 *
 *   1. Read FIRED events from native
 *   2. For each event, if JS occurrence marker already applied → acknowledge only
 *   3. Else apply stock + marker in memory, persist localStorage synchronously,
 *      then mark native RECONCILED
 *   4. If crash after persist and before mark: restart sees marker → no re-deduct,
 *      only mark RECONCILED
 *   5. If crash before persist: restart applies once
 *
 * JS occurrence marker (durable): doseConsumption / doseConsumptionHistory
 * for the occurrence (medicationId + doseId + calendarDate), same as Take.
 * Skipped occurrences (doseSkippedHistory) are also treated as terminal.
 *
 * Does NOT redesign Take/Restore (Phase 4). Does NOT touch notifications.
 */

import type { ConsumptionLog, Medication } from '../types';
import type { AutoDeductionEvent } from './autoDeductionNative';
import { autoDeductionOccurrenceKey } from './autoDeductionNative';
import {
  computeDueDoseBreakdown,
  getTodayDateString,
  isDoseConsumedOnDate,
  isDoseSkippedOnDate,
  recordDoseConsumed,
} from './dateCalculations';
import { generateId } from './id';
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
  /** Events that need native markReconciled (applied or already_applied or safe no-op). */
  toAcknowledge: Array<{
    medicationId: string;
    doseId: string;
    calendarDate: string;
  }>;
  details: ReconcileEventDetail[];
  /** True if medications or logs changed (stock/log mutation). */
  mutated: boolean;
}

function isValidEventAmount(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}

function normalizeDoseId(doseId: string | undefined | null): string {
  if (doseId == null || doseId === '') return LEGACY_DOSE_ID;
  return doseId;
}

/**
 * Whether this occurrence was already applied in JS state
 * (manual take, prior exact auto, or skip/restore terminal).
 */
export function isExactAutoOccurrenceApplied(
  med: Medication,
  doseId: string,
  calendarDate: string
): boolean {
  const id = normalizeDoseId(doseId);
  if (id === LEGACY_DOSE_ID || !Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    // Legacy: lastConsumedDate or consumption on synthetic id
    if (med.lastConsumedDate === calendarDate) return true;
    if (isDoseConsumedOnDate(med, LEGACY_DOSE_ID, calendarDate)) return true;
    if (isDoseSkippedOnDate(med, LEGACY_DOSE_ID, calendarDate)) return true;
    return false;
  }
  if (isDoseConsumedOnDate(med, id, calendarDate)) return true;
  if (isDoseSkippedOnDate(med, id, calendarDate)) return true;
  return false;
}

/**
 * Apply one exact auto event to a medication (pure).
 * Settles past due for gated multi-dose (mirrors consumeDose), then deducts
 * event.amount and records consumption marker.
 */
export function applyExactAutoEventToMedication(
  med: Medication,
  event: AutoDeductionEvent,
  now: Date = new Date()
): { ok: true; updatedMed: Medication; log: ConsumptionLog } | { ok: false; reason: string } {
  if (!isValidEventAmount(event.amount)) {
    return { ok: false, reason: 'invalid_amount' };
  }

  const doseId = normalizeDoseId(event.doseId);
  const calendarDate = event.calendarDate;
  if (!calendarDate || calendarDate.length !== 10) {
    return { ok: false, reason: 'invalid_calendarDate' };
  }

  if (isExactAutoOccurrenceApplied(med, doseId, calendarDate)) {
    return { ok: false, reason: 'already_applied' };
  }

  const todayStr = getTodayDateString();
  const breakdown = computeDueDoseBreakdown(med, now, todayStr);

  // Settle past fully-elapsed days into snapshot before deducting this slot
  // (same idea as consumeDose for gated multi-dose).
  const settleBase = breakdown.gated
    ? Math.max(0, med.currentPills - breakdown.pastDueUnits)
    : Math.max(0, med.currentPills);

  const amount = event.amount;
  const newPills = Math.max(0, settleBase - amount);

  let nextConsumption = med.doseConsumption;
  let nextHistory = med.doseConsumptionHistory;
  let lastConsumedDate = med.lastConsumedDate;

  if (doseId === LEGACY_DOSE_ID || !Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    lastConsumedDate = calendarDate;
    // Also record under LEGACY_DOSE_ID when history maps are used
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

  // lastSyncDate: after applying an occurrence, keep remaining same-day
  // projection coherent — use calendarDate of the event when it is today
  // or later; otherwise leave existing unless past settlement moved base.
  let lastSyncDate = med.lastSyncDate || todayStr;
  if (breakdown.gated && breakdown.pastDueUnits > 0) {
    // Past units settled into snapshot; align lastSync like settlement helpers.
    lastSyncDate = todayStr;
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
    id: generateId('log'),
    medicationId: med.id,
    medicationName: med.name,
    type: 'auto_daily',
    amount: -amount,
    date: calendarDate,
    timestamp: new Date(now).toISOString(),
    description: `خصم تلقائي دقيق (−${amount} ${med.unit || 'وحدة'})`,
    doseId: doseId === LEGACY_DOSE_ID ? undefined : doseId,
  };

  return { ok: true, updatedMed, log };
}

/**
 * Pure reconciliation of a list of FIRED events against current JS state.
 * Deterministic order: scheduledAtEpochMs ascending, then occurrence key.
 *
 * Does not call native APIs. Caller persists and marks RECONCILED.
 */
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

  const newLogs: ConsumptionLog[] = [];
  const details: ReconcileEventDetail[] = [];
  const toAcknowledge: ReconcileFiredResult['toAcknowledge'] = [];
  let mutated = false;

  for (const event of sorted) {
    const medicationId = event.medicationId ?? '';
    const doseId = normalizeDoseId(event.doseId);
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
      // Do not acknowledge malformed identity — leave FIRED for inspection
      continue;
    }

    if (!isValidEventAmount(amount)) {
      details.push({ ...baseDetail, outcome: 'skipped_invalid' });
      // Acknowledge invalid amount so the queue does not grow forever
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }

    const med = medById.get(medicationId);
    if (!med) {
      details.push({ ...baseDetail, outcome: 'skipped_missing_med' });
      // Deleted medication: acknowledge without stock change
      toAcknowledge.push({ medicationId, doseId, calendarDate });
      continue;
    }

    if (!globalOn || med.autoDeductEnabled === false) {
      details.push({ ...baseDetail, outcome: 'skipped_disabled' });
      // Policy: no-op + acknowledge when auto disabled (avoid unbounded FIRED queue)
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
        details.push({ ...baseDetail, outcome: 'already_applied' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
      } else {
        details.push({ ...baseDetail, outcome: 'skipped_invalid' });
        toAcknowledge.push({ medicationId, doseId, calendarDate });
      }
      continue;
    }

    medById.set(medicationId, applied.updatedMed);
    newLogs.push(applied.log);
    mutated = true;
    details.push({ ...baseDetail, outcome: 'applied' });
    toAcknowledge.push({ medicationId, doseId, calendarDate });
  }

  const updatedMeds = medications.map((m) => medById.get(m.id) ?? m);
  // Preserve order; also include any meds only in map if needed (same set)
  return {
    medications: updatedMeds,
    logs: newLogs.length > 0 ? [...newLogs, ...logs] : logs,
    toAcknowledge,
    details,
    mutated,
  };
}
