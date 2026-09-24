import type { Medication } from '../types';
import { addCalendarDays, parseCalendarDate } from './dateCalculations';


function normalizeCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return parseCalendarDate(value) ? value : null;
}

/**
 * A medication is chronic only when its current treatment mode explicitly says so.
 * Temporary treatment boundaries require an explicit durable treatmentStartDate.
 */
export function isMedicationChronic(medication: Medication): boolean {
  return medication.isChronic === true;
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
