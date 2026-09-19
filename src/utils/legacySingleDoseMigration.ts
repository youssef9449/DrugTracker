/**
 * Issue #268 — migrate implicit legacy single-dose medications to an
 * explicit `doseSchedule` before Exact Auto scheduling.
 *
 * Deterministic + idempotent. Does not mutate stock, logs, or lastSyncDate.
 * Does not invent amount/time when legacy fields are incomplete.
 */

import type { Medication, MedicationDose } from '../types';
import { isValidDoseTime, normalizeTimeString } from './doseSchedule';

/**
 * Stable dose id for a medication migrated from the legacy single-dose
 * representation. Same medicationId → same id on every run (no random,
 * timestamp, or array index). Must not equal the native LEGACY_DOSE_ID
 * sentinel used by historical FIRED events.
 */
export function stableMigratedLegacyDoseId(medicationId: string): string {
  return `dose-${medicationId}-s1`;
}

/**
 * True when the medication already has at least one explicit schedule row
 * with a non-empty id, valid HH:mm time, and amount > 0.
 */
export function hasValidExplicitDoseSchedule(
  med: Pick<Medication, 'doseSchedule'>
): boolean {
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return false;
  }
  for (const d of med.doseSchedule) {
    if (!d) continue;
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    if (!id) continue;
    if (!isValidDoseTime(d.time)) continue;
    if (!(Number(d.amount) > 0)) continue;
    return true;
  }
  return false;
}

/**
 * Whether legacy fields are sufficient to build one exact-equivalent dose
 * (same eligibility as the former Exact scheduler LEGACY path).
 */
export function canMigrateLegacySingleDose(
  med: Pick<Medication, 'dailyDose' | 'reminderEnabled' | 'reminderTime'>
): boolean {
  return (
    med.reminderEnabled === true &&
    typeof med.reminderTime === 'string' &&
    isValidDoseTime(med.reminderTime) &&
    Number(med.dailyDose) > 0
  );
}

function buildMigratedSchedule(med: Medication): MedicationDose[] {
  return [
    {
      id: stableMigratedLegacyDoseId(med.id),
      amount: Number(med.dailyDose),
      time: normalizeTimeString(med.reminderTime as string),
    },
  ];
}

function schedulesEqual(
  a: MedicationDose[] | undefined,
  b: MedicationDose[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      Number(a[i].amount) !== Number(b[i].amount) ||
      a[i].time !== b[i].time
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Migrate one medication: if it lacks a valid explicit doseSchedule and
 * has valid legacy reminder + dailyDose, attach exactly one explicit dose.
 * Otherwise return the same object reference (no change).
 *
 * Does not touch currentPills, lastSyncDate, consumption history, or
 * dailyDose / reminderEnabled / reminderTime fields.
 */
export function migrateLegacySingleDoseToSchedule(med: Medication): Medication {
  if (hasValidExplicitDoseSchedule(med)) {
    return med;
  }
  if (!canMigrateLegacySingleDose(med)) {
    return med;
  }
  const doseSchedule = buildMigratedSchedule(med);
  if (schedulesEqual(med.doseSchedule, doseSchedule)) {
    return med;
  }
  return {
    ...med,
    doseSchedule,
  };
}

/**
 * Map medications through {@link migrateLegacySingleDoseToSchedule}.
 * `changed` is true when any medication received a new doseSchedule.
 */
export function migrateMedicationsLegacySingleDose(meds: Medication[]): {
  medications: Medication[];
  changed: boolean;
} {
  let changed = false;
  const medications = meds.map((m) => {
    const next = migrateLegacySingleDoseToSchedule(m);
    if (next !== m) changed = true;
    return next;
  });
  return { medications, changed };
}
