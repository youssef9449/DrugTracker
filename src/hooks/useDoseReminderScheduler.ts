import { useEffect, useRef } from 'react';
import type { Medication } from '../types';
import type { ExactAlarmPermission } from '../utils/exactAlarm';
import {
  DoseReminderReconciliationService,
  type DoseReminderReconciliationOptions,
  type DoseReminderConsumptionReconciliationOptions,
} from '../utils/doseReminderReconciliation';
import {
  doseScheduleKey,
  parseDoseScheduleKey,
  getDoseReminderSlots,
  type DoseReminderSlot,
} from '../utils/doseReminderDefinitions';

export {
  doseScheduleKey,
  parseDoseScheduleKey,
  getDoseReminderSlots,
};
export type { DoseReminderSlot };
export type {
  DoseReminderReconciliationOptions,
  DoseReminderConsumptionReconciliationOptions,
};

/**
 * React lifecycle/state adapter for the framework-neutral Dose Reminder
 * reconciliation state machine.
 *
 * Scheduling decisions, stale cleanup, retries, generation ownership, snooze
 * cancellation, consumption suppression, and restore transitions live in
 * DoseReminderReconciliationService so they are testable without React.
 */
export interface UseDoseReminderSchedulerOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  resumeTick?: number | undefined;
  lifecycleTick?: number | undefined;
}

export function useDoseReminderScheduler({
  medications,
  allowManualTakeActionByMedicationId,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmPermission,
  resumeTick,
  lifecycleTick,
}: UseDoseReminderSchedulerOptions): void {
  const serviceRef = useRef<DoseReminderReconciliationService | null>(null);
  if (serviceRef.current === null) {
    serviceRef.current = new DoseReminderReconciliationService();
  }

  const service = serviceRef.current;

  useEffect(() => {
    service.reconcile({
      medications,
      allowManualTakeActionByMedicationId,
      notificationsEnabled,
      hydrated,
      isFirstRun,
      exactAlarmPermission,
      lifecycleTick,
    } satisfies DoseReminderReconciliationOptions);
  }, [
    service,
    medications,
    allowManualTakeActionByMedicationId,
    notificationsEnabled,
    hydrated,
    isFirstRun,
    exactAlarmPermission,
    lifecycleTick,
  ]);

  useEffect(() => {
    service.reconcileConsumption({
      medications,
      allowManualTakeActionByMedicationId,
      notificationsEnabled,
      hydrated,
      isFirstRun,
      exactAlarmPermission,
      resumeTick,
    } satisfies DoseReminderConsumptionReconciliationOptions);
  }, [
    service,
    medications,
    allowManualTakeActionByMedicationId,
    notificationsEnabled,
    hydrated,
    isFirstRun,
    exactAlarmPermission,
    resumeTick,
  ]);

  useEffect(() => () => service.dispose(), [service]);
}
