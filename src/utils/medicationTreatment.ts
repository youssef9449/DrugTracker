import type { Medication } from '../types';

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string' || !CALENDAR_DATE_RE.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (![year, month, day].every(Number.isInteger)) return null;
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  return value;
}

function formatLocalCalendarDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function addCalendarDays(calendarDate: string, days: number): string | null {
  const [year, month, day] = calendarDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime())) return null;
  date.setDate(date.getDate() + days);
  return formatLocalCalendarDate(date);
}

/**
 * Legacy records without an explicit treatment flag are chronic by default.
 * A bounded course must explicitly set isChronic=false.
 *
 * Temporary records created by the first treatment-duration implementation
 * may not have treatmentStartDate yet; createdAt is the deterministic fallback.
 */
export function isMedicationChronic(medication: Medication): boolean {
  return medication.isChronic !== false;
}

export function getMedicationTreatmentStartDate(
  medication: Medication,
): string | null {
  if (isMedicationChronic(medication)) return null;

  const configured = normalizeCalendarDate(medication.treatmentStartDate);
  if (configured) return configured;

  const createdAt = new Date(medication.createdAt);
  if (!Number.isFinite(createdAt.getTime())) return null;
  return formatLocalCalendarDate(createdAt);
}

export function getMedicationTreatmentEndDate(
  medication: Medication,
): string | null {
  if (isMedicationChronic(medication)) return null;

  const duration = Number(medication.durationDays);
  if (!Number.isInteger(duration) || duration <= 0) return null;

  const start = getMedicationTreatmentStartDate(medication);
  return start ? addCalendarDays(start, duration - 1) : null;
}

export function isMedicationTreatmentActiveOnDate(
  medication: Medication,
  calendarDate: string,
): boolean {
  if (isMedicationChronic(medication)) return true;

  const date = normalizeCalendarDate(calendarDate);
  const start = getMedicationTreatmentStartDate(medication);
  const end = getMedicationTreatmentEndDate(medication);

  if (!date || !start || !end) return false;
  return start <= date && date <= end;
}
