/**
 * Granular Critical Stock scheduling-signature memoization (#494).
 *
 * Problem: rebuilding one large signature for EVERY medication on EVERY
 * medication change re-serializes (and re-sorts) scheduling history for
 * medications that did not change at all.
 *
 * Solution: stable PER-MEDICATION signatures memoized at the correct
 * granularity. Each medication's signature is recomputed ONLY when one of
 * its scheduling-relevant inputs changes:
 * - same object reference → definitely unchanged (O(1) reuse);
 * - different reference → shallow-compare the scheduling-relevant scalars
 *   and reference-compare the doseSchedule/history containers. The app
 *   updates doseSchedule and history maps immutably (every writer creates a
 *   new object — see doseHistory.ts / medActions.ts / pruneDoseConsumption.ts),
 *   so equal references imply equal contents, and changed references force a
 *   recompute of ONLY that medication.
 *
 * Correctness rules:
 * - Every field that can affect getCriticalAlarmDate() / Critical scheduling
 *   is included (stock, daily amount/rate, threshold, Auto state, per-med
 *   Critical setting, dose schedule rows, consume history, skip history,
 *   notification metadata: name/unit).
 * - History serialization keeps the #494 scheduling-relevant window
 *   (dates >= cutoff): the projection reads markers for TODAY (suppression)
 *   and FUTURE dates (exception days) only.
 * - No probabilistic hashing, no polling, no object-identity-only reliance
 *   (changed references are fully re-derived; equal references are provably
 *   equal because all writers are immutable).
 */

import type { Medication } from '../types';
import { dailyScheduleAmount } from './dateCalculations';

/**
 * Scheduling-relevant fast-path equality. `true` means the signature
 * computed for `prev` is still exactly valid for `next`.
 */
export function isCriticalSchedulingStateUnchanged(
  prev: Medication,
  next: Medication
): boolean {
  return (
    prev.id === next.id &&
    prev.name === next.name &&
    Number(prev.currentPills) === Number(next.currentPills) &&
    Number(prev.dailyDose) === Number(next.dailyDose) &&
    Number(prev.warningThresholdDays) === Number(next.warningThresholdDays) &&
    prev.autoDeductEnabled === next.autoDeductEnabled &&
    prev.criticalStockAlertsEnabled === next.criticalStockAlertsEnabled &&
    (prev.unit ?? '') === (next.unit ?? '') &&
    prev.doseSchedule === next.doseSchedule &&
    prev.doseConsumptionHistory === next.doseConsumptionHistory &&
    prev.doseSkippedHistory === next.doseSkippedHistory
  );
}

/** Deterministic schedule-row serialization (time → id → amount). */
function serializeSchedule(
  schedule: Medication['doseSchedule']
): { schedulePart: string; doseIds: string[] } {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return { schedulePart: '', doseIds: [] };
  }
  const rows = schedule
    .map((d) => ({
      id: d?.id != null ? String(d.id) : '',
      amount: Number(d?.amount) || 0,
      time: typeof d?.time === 'string' ? d.time : '',
    }))
    .sort((a, b) => {
      const t = a.time.localeCompare(b.time);
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });
  const doseIds = rows.map((r) => r.id).filter(Boolean);
  const schedulePart = rows
    .map((r) => `${r.id}@${r.time}=${r.amount}`)
    .join(',');
  return { schedulePart, doseIds };
}

/**
 * Scheduling-relevant history serialization: markers for dates >= cutoff
 * only (today + future). Older rows cannot change the projection.
 */
function serializeHistory(
  hist: Record<string, string[]> | undefined,
  doseIds: string[],
  cutoff: string
): string {
  if (!hist || doseIds.length === 0) return '';
  return doseIds
    .map((id) => {
      const dates = hist[id];
      if (!Array.isArray(dates) || dates.length === 0) return `${id}:`;
      const sorted = [...dates]
        .filter((d) => typeof d === 'string' && d && d >= cutoff)
        .sort();
      return `${id}:${sorted.join(',')}`;
    })
    .join(';');
}

/** Full scheduling signature for ONE medication (#494 granularity). */
export function computeMedicationCriticalSchedulingSignature(
  med: Medication,
  cutoff: string
): string {
  const { schedulePart, doseIds } = serializeSchedule(med.doseSchedule);
  return [
    med.id,
    Number(med.currentPills) || 0,
    Number(med.dailyDose) || 0,
    dailyScheduleAmount(med),
    Number(med.warningThresholdDays) || 0,
    med.autoDeductEnabled === false ? 0 : 1,
    med.criticalStockAlertsEnabled === true ? 1 : 0,
    med.name,
    med.unit ?? '',
    schedulePart,
    serializeHistory(med.doseConsumptionHistory, doseIds, cutoff),
    serializeHistory(med.doseSkippedHistory, doseIds, cutoff),
  ].join('|');
}

export interface CriticalSignatureMemoizerStats {
  /** Signatures reused from the per-medication cache. */
  reused: number;
  /** Signatures recomputed (new/changed medications). */
  recomputed: number;
}

export interface CriticalSchedulingSignatureMemoizer {
  /**
   * Combined signature across the medication list. Medications whose
   * scheduling-relevant state is unchanged reuse their cached per-med
   * signature; changed/new ones recompute individually. Removed
   * medications are evicted. Deterministic order (sorted) so list
   * reordering alone does not change the result.
   */
  signature(medications: readonly Medication[], cutoff: string): string;
  /** Cache hit/miss counters (exposed for granular-invalidation tests). */
  stats(): CriticalSignatureMemoizerStats;
  /** Drop every cached signature (e.g. for tests). */
  reset(): void;
}

export function createCriticalSchedulingSignatureMemoizer(): CriticalSchedulingSignatureMemoizer {
  const cache = new Map<
    string,
    { med: Medication; signature: string; cutoff: string }
  >();
  const counters: CriticalSignatureMemoizerStats = { reused: 0, recomputed: 0 };

  return {
    signature(medications, cutoff) {
      const alive = new Set<string>();
      const parts = medications.map((med) => {
        alive.add(med.id);
        const cached = cache.get(med.id);
        if (
          cached &&
          cached.cutoff === cutoff &&
          isCriticalSchedulingStateUnchanged(cached.med, med)
        ) {
          // Keep the newest reference so future fast-path checks compare
          // against the latest objects without recomputation.
          cache.set(med.id, { med, signature: cached.signature, cutoff });
          counters.reused += 1;
          return cached.signature;
        }
        const signature = computeMedicationCriticalSchedulingSignature(
          med,
          cutoff
        );
        cache.set(med.id, { med, signature, cutoff });
        counters.recomputed += 1;
        return signature;
      });
      for (const id of [...cache.keys()]) {
        if (!alive.has(id)) cache.delete(id);
      }
      return parts.sort().join('\n');
    },
    stats() {
      return { reused: counters.reused, recomputed: counters.recomputed };
    },
    reset() {
      cache.clear();
      counters.reused = 0;
      counters.recomputed = 0;
    },
  };
}
