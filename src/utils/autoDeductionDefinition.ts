import type { Medication } from '../types';
import {
  getMedicationTreatmentStartDate,
  getMedicationTreatmentEndDate,
} from './medicationTreatment';
import { isValidDoseTime, normalizeTimeString } from './doseSchedule';

/**
 * Canonical Auto-Deduction configuration definition.
 *
 * This is the single JS definition of fields that can change FUTURE Auto
 * occurrences. Shared runtime operationVersion and Auto recurrenceGeneration
 * are ownership tokens, not medication configuration, so they are intentionally
 * excluded here and remain owned by the native scheduler.
 */
export interface AutoDeductionDoseDefinition {
  id: string;
  time: string;
  amount: number;
}

export interface AutoDeductionDefinition {
  medicationId: string;
  enabled: boolean;
  /** Effective treatment start date for FUTURE Auto scheduling. Empty = no start bound. */
  treatmentStartDate: string;
  /** Effective treatment end date for FUTURE Auto scheduling. Empty = no end. */
  treatmentEndDate: string;
  doses: AutoDeductionDoseDefinition[];
}

export function getAutoDeductionDefinition(
  med: Medication
): AutoDeductionDefinition {
  const doses: AutoDeductionDoseDefinition[] = [];
  const seen = new Set<string>();

  if (Array.isArray(med.doseSchedule)) {
    for (const dose of med.doseSchedule) {
      const id = typeof dose?.id === 'string' ? dose.id.trim() : '';
      const time = typeof dose?.time === 'string' ? dose.time : '';
      const amount = Number(dose?.amount);
      if (!id || seen.has(id) || !isValidDoseTime(time) || !(amount > 0)) continue;
      seen.add(id);
      doses.push({
        id,
        time: normalizeTimeString(time),
        amount,
      });
    }
  }

  return {
    medicationId: med.id,
    enabled: med.autoDeductEnabled !== false,
    treatmentStartDate: getMedicationTreatmentStartDate(med) ?? '',
    treatmentEndDate: getMedicationTreatmentEndDate(med) ?? '',
    doses,
  };
}

/**
 * Stable signature for configuration-change detection.
 *
 * Schedule order is preserved because the persisted doseSchedule order is part
 * of the user's explicit configuration. Duplicate dose IDs are normalized away
 * by getAutoDeductionDefinition().
 */
export function getAutoDeductionDefinitionSignature(med: Medication): string {
  const definition = getAutoDeductionDefinition(med);
  return JSON.stringify(definition);
}

export function autoDeductionDefinitionChanged(
  oldMed: Medication,
  nextMed: Omit<Medication, 'id' | 'createdAt'>
): boolean {
  return getAutoDeductionDefinitionSignature(oldMed) !==
    getAutoDeductionDefinitionSignature({
      ...nextMed,
      id: oldMed.id,
      createdAt: oldMed.createdAt,
    });
}

export function recurrenceDoseIds(med: Medication): string[] {
  return getAutoDeductionDefinition(med).doses.map((dose) => dose.id);
}

export function recurrenceDefinition(
  med: Medication,
  doseId: string
): AutoDeductionDoseDefinition | null {
  const definition = getAutoDeductionDefinition(med);
  if (!definition.enabled) return null;
  return definition.doses.find((dose) => dose.id === doseId) ?? null;
}

/** Explicit future Auto occurrences for one calendar date. */
export function getAutoDeductionDefinitionForDate(
  med: Medication,
  calendarDate: string
): Array<{
  medId: string;
  doseId: string;
  time: string;
  amount: number;
  calendarDate: string;
  treatmentEndDate?: string;
}> {
  const definition = getAutoDeductionDefinition(med);
  return definition.enabled &&
      (!definition.treatmentStartDate || calendarDate >= definition.treatmentStartDate) &&
      (!definition.treatmentEndDate || calendarDate <= definition.treatmentEndDate)
    ? definition.doses.map((dose) => ({
        medId: definition.medicationId,
        doseId: dose.id,
        time: dose.time,
        amount: dose.amount,
        calendarDate,
        treatmentEndDate: definition.treatmentEndDate || undefined,
      }))
    : [];
}
