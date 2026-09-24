import type { ConsumptionLog, Medication } from '../types';
import { addCalendarDays, getLocalDateString } from './dateCalculations';

/**
 * Centralized durable-history retention policy (#507).
 *
 * Purpose-bound bounds (documented contract):
 * - Per-dose consume/skip history (`doseConsumptionHistory`,
 *   `doseSkippedHistory`): user-visible episode history AND runtime
 *   bookkeeping. Runtime correctness only needs today's markers (Dose
 *   Reminder suppression, Restore idempotency) and future exception dates
 *   (Critical projection reads only markers newer than today, and no future
 *   marker is ever recorded). 400 days comfortably covers the longest
 *   practical treatment horizon while giving long-lived users a hard bound.
 * - `ConsumptionLog[]` (`STORAGE_LOGS_KEY`): user-visible activity history
 *   only. Deduction evidence for Restore is per-occurrence and stays relevant
 *   for the same bounded window; older rows are dropped deterministically.
 * - Crash/recovery evidence (stock envelopes, mutation ordering seq, native
 *   FIRED events) is NOT pruned here: it is owned by its own recovery
 *   lifecycle and cleared only after finalization.
 *
 * Pruning is applied at the durable write boundaries (medication mutations
 * via {@link pruneDoseConsumption}, meds+logs commits via
 * {@link pruneConsumptionLogs}) so it is deterministic, centralized, and
 * covered by regression tests.
 */

/** Retention window for per-dose consumption/skip history (calendar days). */
export const DOSE_HISTORY_RETENTION_DAYS = 400;
/** Retention window for the user-visible consumption log (calendar days). */
export const CONSUMPTION_LOG_RETENTION_DAYS = 400;

/** Cutoff (YYYY-MM-DD, local calendar) for the dose-history window. */
export function doseHistoryRetentionCutoff(now: Date = new Date()): string {
  return addCalendarDays(getLocalDateString(now), -DOSE_HISTORY_RETENTION_DAYS);
}

/** Cutoff (YYYY-MM-DD, local calendar) for the consumption-log window. */
export function consumptionLogRetentionCutoff(now: Date = new Date()): string {
  return addCalendarDays(getLocalDateString(now), -CONSUMPTION_LOG_RETENTION_DAYS);
}

function isValidHistoryDates(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((d) => typeof d === 'string');
}

/** Drop history dates strictly older than the cutoff (YYYY-MM-DD compare). */
function pruneHistoryDates(
  hist: Record<string, string[]> | undefined,
  cutoffDateStr: string
): { next: Record<string, string[]> | undefined; changed: boolean } {
  if (!hist) return { next: undefined, changed: false };
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [id, dates] of Object.entries(hist)) {
    if (!isValidHistoryDates(dates)) {
      // Foreign shape: keep untouched rather than inventing data.
      next[id] = dates as string[];
      continue;
    }
    const kept = dates.filter((d) => d >= cutoffDateStr);
    if (kept.length !== dates.length) changed = true;
    if (kept.length > 0) {
      next[id] = kept;
    } else {
      changed = true;
    }
  }
  return { next, changed };
}

/**
 * Drop per-dose history entries whose dates fell out of the retention
 * window. Returns the same object when nothing changed.
 */
export function pruneMedicationDoseHistoryByRetention(
  med: Medication,
  now: Date = new Date()
): Medication {
  const cutoffDateStr = doseHistoryRetentionCutoff(now);
  const consumption = pruneHistoryDates(med.doseConsumptionHistory, cutoffDateStr);
  const skipped = pruneHistoryDates(med.doseSkippedHistory, cutoffDateStr);
  if (!consumption.changed && !skipped.changed) return med;
  return {
    ...med,
    ...(consumption.next ? { doseConsumptionHistory: consumption.next } : {}),
    ...(skipped.next ? { doseSkippedHistory: skipped.next } : {}),
  };
}

/**
 * Deterministically prune the durable consumption log to the retention
 * window. A row whose `date` is inside the window (or unparsable — never
 * invent facts) is kept.
 */
export function pruneConsumptionLogs(
  logs: ConsumptionLog[],
  now: Date = new Date()
): ConsumptionLog[] {
  const cutoffDateStr = consumptionLogRetentionCutoff(now);
  const kept = logs.filter((log) => {
    if (typeof log.date !== 'string' || log.date.length === 0) return true;
    // Lexical YYYY-MM-DD compare; unparsable values stay (fail-safe).
    return log.date >= cutoffDateStr;
  });
  return kept.length === logs.length ? logs : kept;
}

/** True when the date string is inside the dose-history retention window. */
export function isWithinDoseHistoryRetention(
  dateStr: string,
  now: Date = new Date()
): boolean {
  const cutoffDateStr = doseHistoryRetentionCutoff(now);
  return dateStr >= cutoffDateStr;
}

/**
 * Drop doseConsumptionHistory entries whose doseId is no longer on the
 * schedule, then apply the centralized retention window (#507) to the
 * remaining per-dose history. Pure helper — same semantics for the current
 * per-dose history model.
 */
export function pruneDoseConsumption(
  medData: Omit<Medication, 'id' | 'createdAt'>,
  existing?: Medication,
  now: Date = new Date()
): Omit<Medication, 'id' | 'createdAt'> {
  const schedule = medData.doseSchedule;
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return medData;
  }
  const valid = new Set(schedule.map((d) => d.id));
  const prevHist =
    medData.doseConsumptionHistory ?? existing?.doseConsumptionHistory;
  let changed = false;
  let nextHist = prevHist;
  if (prevHist) {
    nextHist = {};
    for (const [id, dates] of Object.entries(prevHist)) {
      if (valid.has(id)) nextHist[id] = dates;
      else changed = true;
    }
  }
  // Also prune doseSkippedHistory if present
  const prevSkip =
    (medData as Medication).doseSkippedHistory ?? existing?.doseSkippedHistory;
  let nextSkip = prevSkip;
  if (prevSkip) {
    nextSkip = {};
    for (const [id, dates] of Object.entries(prevSkip)) {
      if (valid.has(id)) nextSkip[id] = dates;
      else changed = true;
    }
  }
  if (!changed && nextHist === prevHist && nextSkip === prevSkip) {
    // Schedule-id pruning found nothing — retention may still apply.
    return pruneMedicationDoseHistoryByRetention(medData as Medication, now);
  }
  const pruned: Omit<Medication, 'id' | 'createdAt'> = {
    ...medData,
    ...(nextHist ? { doseConsumptionHistory: nextHist } : {}),
    ...(nextSkip ? { doseSkippedHistory: nextSkip } : {}),
  };
  return pruneMedicationDoseHistoryByRetention(pruned as Medication, now);
}
