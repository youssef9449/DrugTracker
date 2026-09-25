/**
 * Desired-state building for Dose Reminder reconciliation.
 *
 * Pure calculation: which reminder slots SHOULD be armed given the durable
 * medication/capability snapshot, and the input signatures used to skip
 * redundant reconciliation passes. No native I/O and no timers.
 */
import type { Medication } from '../types';
import type { ExactAlarmPermission } from './exactAlarm';
import {
  getMedicationTreatmentEndDate,
  isMedicationTreatmentActiveOnDate,
} from './medicationTreatment';
import { getDoseReminderSlots, doseScheduleKey } from './doseReminderDefinitions';
import { getTodayDateString, isDoseConsumedOnDate } from './dateCalculations';

export interface DoseReminderReconciliationOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  lifecycleTick?: number | undefined;
}

export interface DoseReminderConsumptionReconciliationOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  resumeTick?: number | undefined;
}

export interface DesiredDoseReminderSlot {
  key: string;
  medId: string;
  doseId: string;
  time: string;
  amount: number;
  name: string;
  unit: string;
  description?: string | undefined;
  slotConsumedToday: boolean;
  allowManualTakeAction: boolean;
  treatmentEndDate?: string | undefined;
  sig: string;
}

export interface DesiredDoseReminderState {
  /** All slots the current configuration wants armed. */
  desired: DesiredDoseReminderSlot[];
  /** Identity keys still desired (for prev-state diffing). */
  stillScheduled: Set<string>;
  /** Identity keys to keep in the native alarm store (stale cleanup input). */
  keepNativeIds: Set<string>;
}

/** Stable per-medication configuration signature (desired-state inputs). */
export function configurationSignature(
  medications: Medication[],
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>
): string {
  return medications
    .map((medication) => {
      const schedulePart =
        Array.isArray(medication.doseSchedule) && medication.doseSchedule.length > 0
          ? medication.doseSchedule
              .map(
                (dose) =>
                  `${dose.id}@${dose.time}@${dose.amount}@${typeof dose.description === 'string' ? dose.description.trim() : ''}`
              )
              .join(',')
          : '';
      return [
        medication.id,
        medication.reminderEnabled === true ? '1' : '0',
        medication.isChronic === false ? 'temporary' : 'chronic',
        getMedicationTreatmentEndDate(medication) ?? '',
        medication.treatmentStartDate ?? '',
        schedulePart,
        medication.name,
        medication.unit ?? '',
        (allowManualTakeActionByMedicationId.get(medication.id) ?? true) ? '1' : '0',
      ].join('|');
    })
    .sort()
    .join('\n');
}

/** Stable consumption-history signature (consumption reconciliation input). */
export function consumptionSignature(medications: Medication[]): string {
  return medications
    .map((medication) => {
      const perDose = medication.doseConsumptionHistory
        ? Object.entries(medication.doseConsumptionHistory)
            .map(([id, dates]) => `${id}=${Array.isArray(dates) ? dates.join('|') : dates}`)
            .sort()
            .join(',')
        : '';
      return `${medication.id}|${perDose}`;
    })
    .sort()
    .join('\n');
}

export function mainInputSignature(
  options: DoseReminderReconciliationOptions
): string {
  return [
    configurationSignature(
      options.medications,
      options.allowManualTakeActionByMedicationId
    ),
    options.notificationsEnabled ? '1' : '0',
    options.hydrated ? '1' : '0',
    options.isFirstRun ? '1' : '0',
    options.exactAlarmPermission ?? 'null',
    String(options.lifecycleTick ?? 0),
  ].join('::');
}

export function consumptionInputSignature(
  options: DoseReminderConsumptionReconciliationOptions
): string {
  return [
    consumptionSignature(options.medications),
    options.notificationsEnabled ? '1' : '0',
    options.hydrated ? '1' : '0',
    options.isFirstRun ? '1' : '0',
    options.exactAlarmPermission ?? 'null',
    String(options.resumeTick ?? 0),
    Array.from(options.allowManualTakeActionByMedicationId.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value ? '1' : '0'}`)
      .join(','),
  ].join('::');
}

/**
 * Build the complete desired Dose Reminder state from the durable snapshot.
 * Reminder-disabled medications, treatment-inactive dates, and medications
 * without usable slots contribute nothing.
 */
export function buildDesiredDoseReminderState(
  options: Pick<
    DoseReminderReconciliationOptions,
    'medications' | 'allowManualTakeActionByMedicationId'
  >,
  today: string = getTodayDateString()
): DesiredDoseReminderState {
  const stillScheduled = new Set<string>();
  const keepNativeIds = new Set<string>();
  const desired: DesiredDoseReminderSlot[] = [];

  for (const medication of options.medications) {
    if (!medication.reminderEnabled) continue;
    if (!isMedicationTreatmentActiveOnDate(medication, today)) continue;
    const treatmentEndDate = getMedicationTreatmentEndDate(medication) ?? undefined;
    const slots = getDoseReminderSlots(medication);
    if (slots.length === 0) continue;

    for (const slot of slots) {
      const key = doseScheduleKey(slot.medId, slot.doseId);
      const slotConsumedToday = isDoseConsumedOnDate(
        medication,
        slot.doseId,
        today
      );
      const allowManualTakeAction =
        options.allowManualTakeActionByMedicationId.get(medication.id) ?? true;
      const sig = [
        slot.time,
        String(slot.amount),
        slot.name,
        slot.unit,
        slot.description ?? '',
        slotConsumedToday ? '1' : '0',
        allowManualTakeAction ? '1' : '0',
        treatmentEndDate ?? '',
      ].join('|');

      stillScheduled.add(key);
      keepNativeIds.add(key);
      desired.push({
        key,
        medId: slot.medId,
        doseId: slot.doseId,
        time: slot.time,
        amount: slot.amount,
        name: slot.name,
        unit: slot.unit,
        description: slot.description,
        slotConsumedToday,
        allowManualTakeAction,
        treatmentEndDate,
        sig,
      });
    }
  }

  return { desired, stillScheduled, keepNativeIds };
}
