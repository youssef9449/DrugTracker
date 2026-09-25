/**
 * Canonical dose identity + validation domain boundary.
 *
 * ONE definition of dose identity normalization, dose-row validity, and
 * dose-ID resolution. Storage hydration, Dose Reminder, Auto-Deduction,
 * and the manual stock-mutation paths all consume these contracts so a
 * persisted dose row has exactly one meaning everywhere:
 * - `normalizeDoseId` — one stable representation of a dose identity
 *   (trimmed; blank/invalid → null). Whitespace variants of the same
 *   logical dose can never become two identities.
 * - `validateMedicationDose` — canonical dose-row validation (id + HH:mm
 *   + positive amount + optional description). Invalid rows fail closed;
 *   no substitute identities are invented.
 * - `resolveDoseId` — the single resolver for Take/Restore/stock-mutation
 *   identity (single-dose default slot, multi-dose explicit requirement).
 */
import type { Medication, MedicationDose } from '../types';
import { isValidTimeHhmm } from './time';

/**
 * Canonical dose-ID normalization: trim; null when blank/absent/non-string.
 * Used at every boundary that creates or consumes a dose identity
 * (schedule rows, history keys, notification identities, native metadata).
 */
export function normalizeDoseId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export interface MedicationDoseValidation {
  /** Normalized row (trimmed id, padded time) when valid. */
  ok: true;
  dose: MedicationDose;
}

/** Canonical failure reasons for a persisted/runtime dose row. */
export type MedicationDoseInvalidReason =
  | 'invalid_id'
  | 'invalid_time'
  | 'invalid_amount'
  | 'invalid_description';

export type MedicationDoseValidationResult =
  | MedicationDoseValidation
  | { ok: false; reason: MedicationDoseInvalidReason };

/**
 * Canonical medication dose-row validation + normalization.
 *
 * Rules (the ONE source of dose-shape validity):
 * - id: non-blank after trim (canonical identity representation).
 * - time: canonical strict HH:mm (2-digit shape + real hour/minute ranges).
 * - amount: finite number > 0.
 * - description: optional; trimmed; empty → dropped.
 *
 * Time is normalized to zero-padded HH:mm when the value is a valid
 * H:mm/HH:mm 24-hour time. Blank/invalid IDs are rejected — callers must
 * never invent substitute identities for an invalid persisted row.
 */
export function validateMedicationDose(row: unknown): MedicationDoseValidationResult {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, reason: 'invalid_id' };
  }
  const raw = row as Record<string, unknown>;
  const id = normalizeDoseId(raw.id);
  if (!id) return { ok: false, reason: 'invalid_id' };
  if (typeof raw.time !== 'string') return { ok: false, reason: 'invalid_time' };
  const time = normalizeDoseTimeValue(raw.time);
  if (!time || !isValidTimeHhmm(time)) return { ok: false, reason: 'invalid_time' };
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      return { ok: false, reason: 'invalid_description' };
    }
  }
  const description = normalizeDoseDescription(raw.description);
  return {
    ok: true,
    dose: {
      id,
      amount,
      time,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

/** Normalize an optional dose description (trimmed; empty → undefined). */
export function normalizeDoseDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Normalize a dose time to zero-padded HH:mm. Accepts valid H:mm/HH:mm
 * 24-hour input (UI boundary) and returns null for anything else. The
 * RESULT must still be checked with the canonical validator.
 */
export function normalizeDoseTimeValue(value: string): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Typed result of canonical dose-ID resolution. */
export type ResolveDoseIdResult =
  | { ok: true; doseId: string }
  | {
      ok: false;
      reason: 'missing_dose_id' | 'invalid_dose_id' | 'no_dose';
    };

/**
 * The ONE dose-ID resolver for stock-mutation paths (Take/Restore/manual).
 *
 * Semantics:
 * - No usable doseSchedule: omitted id → `no_dose`; explicit id →
 *   `invalid_dose_id` (a stale identity for a schedule-less medication).
 * - Omitted id: single-slot schedule → that slot's canonical id;
 *   multi-dose schedule → `missing_dose_id` (ambiguous).
 * - Explicit id: matched against schedule rows using canonical identity
 *   (trim on both sides); unknown id → `invalid_dose_id`.
 *
 * Callers must consume the returned canonical id for all downstream
 * decisions (history, logs, notification/native identities) — never the
 * original optional argument.
 */
export function resolveDoseId(
  med: Pick<Medication, 'doseSchedule'>,
  requestedDoseId?: string
): ResolveDoseIdResult {
  const schedule = Array.isArray(med.doseSchedule) ? med.doseSchedule : [];
  if (schedule.length === 0) {
    const requested = normalizeDoseId(requestedDoseId);
    return requested
      ? { ok: false, reason: 'invalid_dose_id' }
      : { ok: false, reason: 'no_dose' };
  }
  const requested = normalizeDoseId(requestedDoseId);
  if (!requested) {
    if (schedule.length === 1) {
      const single = normalizeDoseId(schedule[0]?.id);
      return single
        ? { ok: true, doseId: single }
        : { ok: false, reason: 'invalid_dose_id' };
    }
    return { ok: false, reason: 'missing_dose_id' };
  }
  const slot = schedule.find((d) => normalizeDoseId(d?.id) === requested);
  if (!slot) return { ok: false, reason: 'invalid_dose_id' };
  const canonical = normalizeDoseId(slot.id);
  return canonical
    ? { ok: true, doseId: canonical }
    : { ok: false, reason: 'invalid_dose_id' };
}
