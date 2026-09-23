import type { Medication, ConsumptionLog } from '../../src/types';
import type { ExactAlarmPermission } from '../../src/utils/exactAlarm';
import type { AutoDeductionEvent } from '../../src/utils/autoDeductionNativeTypes';
import { exactAutoLogId } from '../../src/utils/autoDeductionReconciliation';

export function makeMedication(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'TestMed',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2026-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '22:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

export function makeAutoDeductionEvent(
  overrides: Partial<AutoDeductionEvent> &
    Pick<AutoDeductionEvent, 'doseId' | 'calendarDate' | 'amount'>
): AutoDeductionEvent {
  return {
    medicationId: 'med-1',
    scheduledAtEpochMs: 1,
    status: 'FIRED',
    createdAtEpochMs: 1,
    reconciledAtEpochMs: null,
    ...overrides,
  };
}

export function makeDoseTakenLog(
  medId: string,
  medName: string,
  doseId: string,
  date: string,
  amount: number,
  logId: string,
  timestamp = `${date}T08:00:00.000Z`
): ConsumptionLog {
  return {
    id: logId,
    medicationId: medId,
    medicationName: medName,
    type: 'dose_taken',
    amount: -amount,
    date,
    timestamp,
    description: 'test dose_taken',
    doseId,
  };
}

export function makeExactAutoLog(
  medId: string,
  medName: string,
  doseId: string,
  date: string,
  amount: number,
  _logId = '',
  timestamp = `${date}T08:00:00.000Z`
): ConsumptionLog {
  return {
    id: exactAutoLogId(medId, doseId, date),
    medicationId: medId,
    medicationName: medName,
    type: 'exact_auto',
    amount: -amount,
    date,
    timestamp,
    description: 'test exact_auto',
    doseId,
  };
}

export function makeRefillLog(
  medId: string,
  medName: string,
  date: string,
  amount: number,
  logId: string,
  timestamp = `${date}T10:00:00.000Z`
): ConsumptionLog {
  return {
    id: logId,
    medicationId: medId,
    medicationName: medName,
    type: 'refill',
    amount,
    date,
    timestamp,
    description: 'test refill',
  };
}

export function makeDoseReminderMedication(overrides: Partial<Medication> = {}): Medication {
  const reminderTime = overrides.reminderTime ?? '09:00';
  const dailyDose = overrides.dailyDose ?? 1;
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    reminderEnabled: true,
    reminderTime,
    doseSchedule: [{ id: 'd1', amount: dailyDose, time: reminderTime }],
    dosesPerDay: 1,
    ...overrides,
  };
}

export function makeDoseReminderCapabilityMap(medications: Medication[]): ReadonlyMap<string, boolean> {
  return new Map(medications.map((med) => [med.id, med.autoDeductEnabled === false]));
}

export async function flushTestMicrotasks(
  predicate: () => boolean,
  maxIterations = 20
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
}

export function makeDoseReminderOptions(
  medications: Medication[] = [],
  overrides: Record<string, unknown> = {}
) {
  return {
    medications,
    allowManualTakeActionByMedicationId: makeDoseReminderCapabilityMap(medications),
    notificationsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    exactAlarmPermission: 'granted' as ExactAlarmPermission | null,
    resumeTick: 0 as number | undefined,
    ...overrides,
  };
}

export function seedTestMedication(overrides: Partial<Medication> = {}): void {
  localStorage.setItem(
    'android_med_tracker_items_v2',
    JSON.stringify([
      makeMedication({
        id: 'med-toggle',
        name: 'Toggle Med',
        currentPills: 60,
        dailyDose: 2,
        reminderEnabled: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        ...overrides,
      }),
    ])
  );
  localStorage.setItem('android_med_tracker_logs_v2', JSON.stringify([]));
}

export function readDurableMedication(id = 'med-toggle'): Record<string, unknown> | undefined {
  const raw = localStorage.getItem('android_med_tracker_items_v2');
  if (!raw) return undefined;
  const medications = JSON.parse(raw) as Record<string, unknown>[];
  return medications.find((medication) => medication.id === id);
}

export function readDurableLogs(): Record<string, unknown>[] {
  const raw = localStorage.getItem('android_med_tracker_logs_v2');
  return raw ? JSON.parse(raw) as Record<string, unknown>[] : [];
}
