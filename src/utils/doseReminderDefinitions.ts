import type { Medication } from '../types';
import { isValidDoseTime } from './doseSchedule';

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
  return `${medId}::${doseId}`;
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
 * Invalid, empty, and duplicate dose IDs are ignored at the domain boundary.
 */
export function getDoseReminderSlots(med: Medication): DoseReminderSlot[] {
  const name = med.name;
  const unit = med.unit || 'قرص';
  if (!Array.isArray(med.doseSchedule) || med.doseSchedule.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const slots: DoseReminderSlot[] = [];
  for (const row of med.doseSchedule) {
    if (!row || !isValidDoseTime(row.time) || !(Number(row.amount) > 0)) {
      continue;
    }
    const doseId = typeof row.id === 'string' ? row.id.trim() : '';
    if (!doseId || seen.has(doseId)) continue;
    seen.add(doseId);

    const description =
      typeof row.description === 'string' && row.description.trim()
        ? row.description.trim()
        : undefined;
    slots.push({
      medId: med.id,
      doseId,
      time: row.time,
      amount: Number(row.amount),
      name,
      unit,
      description,
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
