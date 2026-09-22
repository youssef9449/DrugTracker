import type { Medication } from '../types';
import { addCalendarDays } from './dateCalculations';

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

/**
 * Legacy records without an explicit treatment flag are chronic by default.
 * A bounded course must explicitly set isChronic=false.
 *
 * Temporary treatment boundaries require an explicit durable treatmentStartDate.
 */
export function isMedicationChronic(medication: Medication): boolean {
  return medication.isChronic !== false;
}

export function getMedicationTreatmentStartDate(
  medication: Medication,
): string | null {
  if (isMedicationChronic(medication)) return null;

  const configured = normalizeCalendarDate(medication.treatmentStartDate);
  return configured;
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
