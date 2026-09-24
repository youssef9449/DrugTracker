/**
 * Consumption/restore reconciliation coordinator for Dose Reminder.
 *
 * Reacts to consumption-history transitions (dose consumed today / restored)
 * and re-arms or suppresses the corresponding reminder accordingly. The
 * scheduling mechanics (cancel → reschedule with bounded retry + generation
 * guards) are shared with the main reconciliation via the retry scheduler
 * and the schedule-generation coordinator.
 */
import {
  getTodayDateString,
  isDoseConsumedOnDate,
} from './dateCalculations';
import { isMedicationTreatmentActiveOnDate } from './medicationTreatment';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  isDoseReminderPending,
  isDoseReminderTimeStillAhead,
} from './doseReminderScheduling';
import { doseScheduleKey, getDoseReminderSlots } from './doseReminderDefinitions';
import {
  bumpDoseReminderScheduleGeneration,
  isCurrentDoseReminderScheduleGeneration,
  enqueueDoseReminderScheduleOpGuarded,
} from './doseReminderOperations';
import type { DoseReminderRetryScheduler } from './doseReminderRetry';
import type { DoseReminderSnoozeCoordinator } from './doseReminderSnoozeCleanup';
import type { DoseReminderConsumptionReconciliationOptions } from './doseReminderDesiredState';
import { consumptionSignature } from './doseReminderDesiredState';

export class DoseReminderConsumptionReconciler {
  private readonly prevConsumedKeys = new Set<string>();
  private prevResumeTick: number | null = null;
  private lastConsumptionInputSignature: string | null = null;

  constructor(
    private readonly retry: DoseReminderRetryScheduler,
    private readonly snooze: DoseReminderSnoozeCoordinator
  ) {}

  /**
   * True when the given consumption-reconciliation input was already
   * processed (signature-seen dedup is part of the coordinator's contract).
   */
  isSignatureCurrent(
    options: DoseReminderConsumptionReconciliationOptions
  ): boolean {
    const inputSignature = this.buildInputSignature(options);
    return this.lastConsumptionInputSignature === inputSignature;
  }

  markSignature(
    options: DoseReminderConsumptionReconciliationOptions
  ): void {
    this.lastConsumptionInputSignature = this.buildInputSignature(options);
  }

  reconcile(options: DoseReminderConsumptionReconciliationOptions): void {
    const today = getTodayDateString();
    const nextConsumedKeys = new Set<string>();

    const resumeChanged =
      this.prevResumeTick === null ||
      this.prevResumeTick !== (options.resumeTick ?? 0);
    this.prevResumeTick = options.resumeTick ?? 0;

    for (const medication of options.medications) {
      if (!medication.reminderEnabled) continue;
      if (!isMedicationTreatmentActiveOnDate(medication, today)) continue;

      const treatmentEndDate = getMedicationTreatmentEndDate(medication);
      const slots = getDoseReminderSlots(medication);
      if (slots.length === 0) continue;

      for (const slot of slots) {
        const slotConsumedToday = isDoseConsumedOnDate(
          medication,
          slot.doseId,
          today
        );
        const key = doseScheduleKey(slot.medId, slot.doseId);
        const { medId, doseId, time, amount, name, unit, description } = slot;
        const wasConsumed = this.prevConsumedKeys.has(key);

        if (slotConsumedToday) {
          nextConsumedKeys.add(key);
          const newlyConsumed = !wasConsumed;
          if (!newlyConsumed && !resumeChanged) continue;

          this.snooze.cancelSnoozeSlot(medId, doseId);

          const generation = bumpDoseReminderScheduleGeneration(key);
          this.retry.enqueueRetryable({
            retryKey: 'schedule:' + key,
            operationKey: key,
            generation,
            enqueue: enqueueDoseReminderScheduleOpGuarded,
            isCurrent: isCurrentDoseReminderScheduleGeneration,
            operation: async () => {
              if (!isDoseReminderTimeStillAhead(time)) {
                const pendingResult = await isDoseReminderPending(medId, doseId);
                if (!pendingResult.ok) {
                  throw new Error(
                    pendingResult.error || 'dose_reminder_pending_lookup_failed'
                  );
                }
                if (!pendingResult.pending) return;
              }

              if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;
              await cancelDoseReminder(medId, doseId);
              if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;

              const allowManualTakeAction =
                options.allowManualTakeActionByMedicationId.get(medication.id) ?? true;
              const scheduleOptions = {
                skipToday: true as const,
                allowManualTakeAction,
                ...(description ? { doseDescription: description } : {}),
                ...(treatmentEndDate ? { treatmentEndDate } : {}),
              };
              await scheduleDoseReminder(
                medId,
                name,
                time,
                amount,
                unit,
                doseId,
                scheduleOptions
              );
              if (!isCurrentDoseReminderScheduleGeneration(key, generation)) {
                await cancelDoseReminder(medId, doseId);
              }
            },
          });
        } else if (
          wasConsumed &&
          isDoseReminderTimeStillAhead(time)
        ) {
          this.snooze.cancelSnoozeSlot(medId, doseId);

          const generation = bumpDoseReminderScheduleGeneration(key);
          this.retry.enqueueRetryable({
            retryKey: 'schedule:' + key,
            operationKey: key,
            generation,
            enqueue: enqueueDoseReminderScheduleOpGuarded,
            isCurrent: isCurrentDoseReminderScheduleGeneration,
            operation: async () => {
              await cancelDoseReminder(medId, doseId);
              if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;

              const allowManualTakeAction =
                options.allowManualTakeActionByMedicationId.get(medication.id) ?? true;
              const scheduleOptions = {
                allowManualTakeAction,
                ...(description ? { doseDescription: description } : {}),
                ...(treatmentEndDate ? { treatmentEndDate } : {}),
              };
              await scheduleDoseReminder(
                medId,
                name,
                time,
                amount,
                unit,
                doseId,
                scheduleOptions
              );
              if (!isCurrentDoseReminderScheduleGeneration(key, generation)) {
                await cancelDoseReminder(medId, doseId);
              }
            },
          });
        }
      }
    }

    this.prevConsumedKeys.clear();
    for (const key of nextConsumedKeys) this.prevConsumedKeys.add(key);
  }

  reset(): void {
    this.prevConsumedKeys.clear();
    this.prevResumeTick = null;
    this.lastConsumptionInputSignature = null;
  }

  private buildInputSignature(
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
}
