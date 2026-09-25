import type { Medication } from '../types';
import {
  getMedicationTreatmentStartDate,
  getMedicationTreatmentEndDate,
} from './medicationTreatment';
import { isMedicationAutoDeductActive } from './doseSchedule';
import { validateMedicationDose } from './doseIdentity';

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
  /**
   * True when this medication carries no usable explicit doseSchedule rows
   * (missing, empty, or every row invalid). This is the EXPLICIT
   * unsupported state of Auto-Deduction for such medications (#502): the
   * canonical definition produces zero occurrences and consumers surface
   * this state instead of silently treating it as a healthy empty schedule.
   * There is no derived/fallback dose source.
   */
  scheduleMissing: boolean;
}

export function getAutoDeductionDefinition(
  med: Medication
): AutoDeductionDefinition {
  const doses: AutoDeductionDoseDefinition[] = [];
  const seen = new Set<string>();

  if (Array.isArray(med.doseSchedule)) {
    for (const dose of med.doseSchedule) {
      const validated = validateMedicationDose(dose);
      if (!validated.ok) continue;
      if (seen.has(validated.dose.id)) continue;
      seen.add(validated.dose.id);
      doses.push({
        id: validated.dose.id,
        time: validated.dose.time,
        amount: validated.dose.amount,
      });
    }
  }

  return {
    medicationId: med.id,
    // Single canonical Auto policy source (documented ON default for a
    // missing autoDeductEnabled field — #499).
    enabled: isMedicationAutoDeductActive(med),
    treatmentStartDate: getMedicationTreatmentStartDate(med) ?? '',
    treatmentEndDate: getMedicationTreatmentEndDate(med) ?? '',
    doses,
    scheduleMissing: doses.length === 0,
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

/**
 * Medication IDs that are Auto-Deduction enabled but carry NO usable
 * explicit doseSchedule rows. Auto-Deduction is explicitly unsupported for
 * them (#502): the canonical definition produces zero occurrences and the
 * runtime surfaces this state instead of silently showing an inactive
 * feature. No per-caller fallbacks exist — this is derived from the same
 * canonical definition the scheduler consumes.
 */
export function medicationIdsWithoutAutoSchedule(medications: readonly Medication[]): string[] {
  return medications
    .filter(
      (med) =>
        isMedicationAutoDeductActive(med) &&
        getAutoDeductionDefinition(med).scheduleMissing
    )
    .map((med) => med.id);
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
