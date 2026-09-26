import { DEFAULT_MEDICATION_UNIT } from '../constants/medicationDefaults';
import type { Medication } from '../types';
import { validateMedicationDose, normalizeDoseId } from './doseIdentity';

export interface DoseReminderSlot {
  medId: string;
  doseId: string;
  time: string;
  amount: number;
  name: string;
  unit: string;
  description?: string;
}

/** Stable application identity for one explicit dose reminder slot. */
export function doseScheduleKey(medId: string, doseId: string): string {
  const canonicalDoseId = normalizeDoseId(doseId);
  if (canonicalDoseId === null) {
    throw new Error('invalid_dose_id');
  }
  return `${medId}::${canonicalDoseId}`;
}

export function parseDoseScheduleKey(
  key: string
): { medId: string; doseId: string } {
  const idx = key.indexOf('::');
  if (idx < 0) return { medId: key, doseId: '' };
  return { medId: key.slice(0, idx), doseId: key.slice(idx + 2) };
}

/**
 * Build reminder slots from explicit doseSchedule only.
 * Rows are validated by the canonical domain dose contract; invalid, empty,
 * and duplicate dose IDs are ignored at the domain boundary (no substitute
 * identities are invented).
 */
export function getDoseReminderSlots(med: Medication): DoseReminderSlot[] {
  const name = med.name;
  const unit = med.unit || DEFAULT_MEDICATION_UNIT;
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const slots: DoseReminderSlot[] = [];
  for (const row of med.doseSchedule) {
    const validated = validateMedicationDose(row);
    if (!validated.ok) continue;
    const doseId = validated.dose.id;
    if (seen.has(doseId)) continue;
    seen.add(doseId);

    slots.push({
      medId: med.id,
      doseId,
      time: validated.dose.time,
      amount: validated.dose.amount,
      name,
      unit,
      ...(validated.dose.description !== undefined
        ? { description: validated.dose.description }
        : {}),
    });
  }
  return slots;
}

/**
 * Returns true when a durable medication mutation changes anything encoded
 * into the native Dose Reminder schedule payload or identity.
 *
 * The manual-take capability is represented by the medication-level Auto
 * flag at this application boundary; the native Dose Reminder path receives
 * only the neutral boolean capability.
 */
export function doseReminderDefinitionChanged(
  before: Medication,
  after: Omit<Medication, 'id' | 'createdAt'>
): boolean {
  if (before.reminderEnabled !== after.reminderEnabled) return true;
  if (before.name !== after.name || before.unit !== after.unit) return true;
  if (before.autoDeductEnabled !== after.autoDeductEnabled) return true;
  if (before.treatmentStartDate !== after.treatmentStartDate) return true;

  const beforeEnd =
    before.isChronic === false
      ? before.durationDays ?? null
      : null;
  const afterEnd =
    after.isChronic === false
      ? after.durationDays ?? null
      : null;
  if (beforeEnd !== afterEnd || before.isChronic !== after.isChronic) {
    return true;
  }

  const serialize = (med: Medication | Omit<Medication, 'id' | 'createdAt'>) =>
    Array.isArray(med.doseSchedule)
      ? med.doseSchedule
          .map((row) =>
            `${row?.id ?? ''}@${row?.time ?? ''}@${row?.amount ?? ''}@${typeof row?.description === 'string' ? row.description.trim() : ''}`
          )
          .join(',')
      : '';

  return serialize(before) !== serialize(after);
}
