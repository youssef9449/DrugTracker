/**
 * Per-dose consumption / skip history calculations.
 *
 * Feature policy for dose history bookkeeping built on the shared calendar
 * primitives. Keys and values follow the canonical dose identity domain.
 */
import type { Medication } from '../../types';

/** True when the med has a non-empty dose schedule. */
export function hasDoseSchedule(med: Medication): boolean {
  return Array.isArray(med.doseSchedule) && med.doseSchedule.length > 0;
}
/**
 * Dates on which `doseId` was consumed, from `doseConsumptionHistory` only.
 * Missing or empty history → no consumed dates.
 */
function getDoseConsumedDates(med: Medication, doseId: string): string[] {
  const hist = med.doseConsumptionHistory?.[doseId];
  if (!Array.isArray(hist) || hist.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of hist) {
    if (typeof d === 'string' && d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}
/**
 * Whether a specific dose slot was consumed on `dateStr`.
 * Uses only `doseConsumptionHistory` (no medication-level lastConsumedDate fallback).
 */
export function isDoseConsumedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): boolean {
  return getDoseConsumedDates(med, doseId).includes(dateStr);
}
/**
 * Record a manual consumption of `doseId` on `dateStr`.
 * Appends to `doseConsumptionHistory` (no duplicate dates).
 */
export function recordDoseConsumed(
  med: Medication,
  doseId: string,
  dateStr: string
): {
  doseConsumptionHistory: Record<string, string[]>;
} {
  const doseConsumptionHistory: Record<string, string[]> = {
    ...(med.doseConsumptionHistory ?? {}),
  };
  const prev = doseConsumptionHistory[doseId] ?? [];
  if (!prev.includes(dateStr)) {
    doseConsumptionHistory[doseId] = [...prev, dateStr];
  } else {
    doseConsumptionHistory[doseId] = prev;
  }
  return { doseConsumptionHistory };
}
/**
 * Whether a specific dose slot was restored/skipped on `dateStr`
 * (Auto-Deduct → Restore bookkeeping). Skipped slots are not auto-due
 * again for that date and are available for a later manual Take.
 */
export function isDoseSkippedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): boolean {
  const hist = med.doseSkippedHistory?.[doseId];
  return Array.isArray(hist) && hist.includes(dateStr);
}
/**
 * Record that `doseId` was restored/skipped on `dateStr` so the same
 * occurrence is not treated as still due for Exact Auto deduction.
 * Idempotent per doseId+date; does not itself change durable `currentPills`.
 */
export function recordDoseSkipped(
  med: Medication,
  doseId: string,
  dateStr: string
): { doseSkippedHistory: Record<string, string[]> } {
  const doseSkippedHistory: Record<string, string[]> = {
    ...(med.doseSkippedHistory ?? {}),
  };
  const prev = doseSkippedHistory[doseId] ?? [];
  if (!prev.includes(dateStr)) {
    doseSkippedHistory[doseId] = [...prev, dateStr];
  } else {
    doseSkippedHistory[doseId] = prev;
  }
  return { doseSkippedHistory };
}
/**
 * Clear a skip mark for `doseId` on `dateStr` (e.g. after manual Take
 * following Restore). Does not touch other dates or doseIds.
 */
export function clearDoseSkippedOnDate(
  med: Medication,
  doseId: string,
  dateStr: string
): { doseSkippedHistory: Record<string, string[]> } {
  const doseSkippedHistory: Record<string, string[]> = {
    ...(med.doseSkippedHistory ?? {}),
  };
  const prev = doseSkippedHistory[doseId] ?? [];
  const next = prev.filter((d) => d !== dateStr);
  if (next.length === 0) {
    delete doseSkippedHistory[doseId];
  } else {
    doseSkippedHistory[doseId] = next;
  }
  return { doseSkippedHistory };
}
