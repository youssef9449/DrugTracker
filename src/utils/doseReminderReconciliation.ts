import type { Medication } from '../types';
import type { ExactAlarmPermission } from './exactAlarm';
import {
  getTodayDateString,
  isDoseConsumedOnDate,
} from './dateCalculations';
import {
  getMedicationTreatmentEndDate,
  isMedicationTreatmentActiveOnDate,
} from './medicationTreatment';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  isDoseReminderPending,
  isNativeDoseReminderReArmed,
  isDoseReminderTimeStillAhead,
  cancelStaleDoseReminderAlarms,
} from './doseReminderScheduling';
import { cancelSnoozedDoseReminder } from './notifications/doseReminderNotifications';
import { clearSnoozedDose } from './doseReminderStorage';
import {
  doseScheduleKey,
  parseDoseScheduleKey,
  getDoseReminderSlots,
} from './doseReminderDefinitions';
import {
  bumpDoseReminderScheduleGeneration,
  isCurrentDoseReminderScheduleGeneration,
  enqueueDoseReminderScheduleOpGuarded,
  bumpDoseReminderSnoozeGeneration,
  isCurrentDoseReminderSnoozeGeneration,
  enqueueDoseReminderSnoozeOpGuarded,
  doseReminderSnoozeKey,
} from './doseReminderOperations';

export interface DoseReminderReconciliationOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  lifecycleTick?: number;
}

export interface DoseReminderConsumptionReconciliationOptions {
  medications: Medication[];
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  resumeTick?: number;
}

/**
 * Framework-neutral Dose Reminder reconciliation state machine.
 *
 * React supplies the current medication/capability snapshot and lifecycle
 * signals; this service owns desired-state calculation, native reconciliation,
 * stale cleanup, bounded retries, generation invalidation, snooze cleanup,
 * and consume/restore transitions.
 */
export class DoseReminderReconciliationService {
  private readonly scheduledDoseIds = new Set<string>();
  private readonly appliedSignature = new Map<string, string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private retryGeneration = 0;
  private disposed = false;

  private readonly prevConsumedKeys = new Set<string>();
  private prevResumeTick: number | null = null;
  private lastMainInputSignature: string | null = null;
  private lastConsumptionInputSignature: string | null = null;

  private clearRetry(key: string): void {
    const timer = this.retryTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
    this.retryAttempts.delete(key);
  }

  private enqueueRetryable(
    retryKey: string,
    operationKey: string,
    generation: number,
    enqueue: (
      key: string,
      generation: number,
      operation: () => Promise<void>
    ) => Promise<void>,
    isCurrent: (key: string, generation: number) => boolean,
    operation: () => Promise<void>
  ): void {
    this.clearRetry(retryKey);

    const run = (attempt: number): Promise<void> =>
      enqueue(operationKey, generation, async () => {
        if (this.disposed || !isCurrent(operationKey, generation)) return;
        try {
          await operation();
          this.clearRetry(retryKey);
        } catch (error) {
          if (this.disposed || !isCurrent(operationKey, generation)) return;
          const nextAttempt = attempt + 1;
          if (nextAttempt > 3) {
            console.warn(
              '[dose-reminder] bounded retry exhausted:',
              operationKey,
              error
            );
            return;
          }
          const delays = [1000, 4000, 16000] as const;
          const timer = setTimeout(() => {
            this.retryTimers.delete(retryKey);
            if (this.disposed || !isCurrent(operationKey, generation)) return;
            void run(nextAttempt).catch((retryError) => {
              console.warn(
                '[dose-reminder] retry enqueue failed:',
                operationKey,
                retryError
              );
            });
          }, delays[attempt]);
          this.retryTimers.set(retryKey, timer);
          this.retryAttempts.set(retryKey, nextAttempt);
        }
      });

    void run(0).catch((error) => {
      console.warn(
        '[dose-reminder] operation enqueue failed:',
        operationKey,
        error
      );
    });
  }

  private clearAllRetries(): void {
    for (const key of this.retryTimers.keys()) {
      this.clearRetry(key);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  private cancelSnoozeSlot(medId: string, doseId: string): void {
    const scheduleKey = doseScheduleKey(medId, doseId);
    const operationKey = doseReminderSnoozeKey(medId, doseId);
    const generation = bumpDoseReminderSnoozeGeneration(operationKey);
    this.enqueueRetryable(
      'snooze:' + scheduleKey,
      operationKey,
      generation,
      enqueueDoseReminderSnoozeOpGuarded,
      isCurrentDoseReminderSnoozeGeneration,
      async () => {
        await cancelSnoozedDoseReminder(medId, doseId);
        if (!clearSnoozedDose(medId, doseId)) {
          throw new Error('snooze_clear_persistence_failed');
        }
      }
    );
  }

  private configurationSignature(
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

  private consumptionSignature(medications: Medication[]): string {
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

  private mainInputSignature(options: DoseReminderReconciliationOptions): string {
    return [
      this.configurationSignature(
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

  private consumptionInputSignature(
    options: DoseReminderConsumptionReconciliationOptions
  ): string {
    return [
      this.consumptionSignature(options.medications),
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

  reconcile(options: DoseReminderReconciliationOptions): void {
    if (this.disposed) return;

    const inputSignature = this.mainInputSignature(options);
    if (this.lastMainInputSignature === inputSignature) return;
    this.lastMainInputSignature = inputSignature;

    if (!options.hydrated || options.isFirstRun) return;

    const cancelSlot = (medId: string, doseId: string): void => {
      const key = doseScheduleKey(medId, doseId);
      const generation = bumpDoseReminderScheduleGeneration(key);
      this.appliedSignature.delete(key);
      this.clearRetry('schedule:' + key);

      this.enqueueRetryable(
        'schedule:' + key,
        key,
        generation,
        enqueueDoseReminderScheduleOpGuarded,
        isCurrentDoseReminderScheduleGeneration,
        async () => {
          await cancelDoseReminder(medId, doseId);
        }
      );

      this.cancelSnoozeSlot(medId, doseId);
    };

    if (
      !options.notificationsEnabled ||
      options.exactAlarmPermission === null ||
      options.exactAlarmPermission === 'denied'
    ) {
      for (const key of this.scheduledDoseIds) {
        const { medId, doseId } = parseDoseScheduleKey(key);
        cancelSlot(medId, doseId);
      }

      const staleGeneration = ++this.retryGeneration;
      this.clearRetry('__stale_dose_alarm_cleanup__');
      const retryStaleCleanup = async (attempt: number): Promise<void> => {
        if (this.disposed || this.retryGeneration !== staleGeneration) return;
        const result = await cancelStaleDoseReminderAlarms(new Set());
        if (result.ok) {
          this.clearRetry('__stale_dose_alarm_cleanup__');
          return;
        }
        if (attempt >= 3) {
          console.warn(
            '[dose-reminder] bounded stale-alarm cleanup retry exhausted:',
            result.error,
            result.errorCode
          );
          return;
        }
        const delays = [1000, 4000, 16000] as const;
        const timer = setTimeout(() => {
          this.retryTimers.delete('__stale_dose_alarm_cleanup__');
          void retryStaleCleanup(attempt + 1).catch((error) => {
            console.warn(
              '[dose-reminder] stale cleanup retry failed:',
              error
            );
          });
        }, delays[attempt]);
        this.retryTimers.set('__stale_dose_alarm_cleanup__', timer);
      };
      void retryStaleCleanup(0).catch((error) => {
        console.warn('[dose-reminder] stale cleanup failed:', error);
      });

      this.scheduledDoseIds.clear();
      this.appliedSignature.clear();
      return;
    }

    const stillScheduled = new Set<string>();
    const keepNativeIds = new Set<string>();
    const today = getTodayDateString();
    type DesiredSlot = {
      key: string;
      medId: string;
      doseId: string;
      time: string;
      amount: number;
      name: string;
      unit: string;
      description?: string;
      slotConsumedToday: boolean;
      allowManualTakeAction: boolean;
      treatmentEndDate?: string;
      sig: string;
    };

    const desired: DesiredSlot[] = [];
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

    const staleGeneration = ++this.retryGeneration;
    this.clearRetry('__stale_dose_alarm_cleanup__');
    const retryStaleCleanup = async (attempt: number): Promise<void> => {
      if (this.disposed || this.retryGeneration !== staleGeneration) return;
      const result = await cancelStaleDoseReminderAlarms(keepNativeIds);
      if (result.ok) {
        this.clearRetry('__stale_dose_alarm_cleanup__');
        return;
      }
      if (attempt >= 3) {
        console.warn(
          '[dose-reminder] bounded stale-alarm cleanup retry exhausted:',
          result.error,
          result.errorCode
        );
        return;
      }
      const delays = [1000, 4000, 16000] as const;
      const timer = setTimeout(() => {
        this.retryTimers.delete('__stale_dose_alarm_cleanup__');
        void retryStaleCleanup(attempt + 1).catch((error) => {
          console.warn('[dose-reminder] stale cleanup retry failed:', error);
        });
      }, delays[attempt]);
      this.retryTimers.set('__stale_dose_alarm_cleanup__', timer);
    };
    void retryStaleCleanup(0).catch((error) => {
      console.warn('[dose-reminder] stale cleanup failed:', error);
    });

    for (const slot of desired) {
      const {
        key,
        medId,
        doseId,
        time,
        amount,
        name,
        unit,
        description,
        slotConsumedToday,
        allowManualTakeAction,
        treatmentEndDate,
        sig,
      } = slot;

      const prevSig = this.appliedSignature.get(key);
      if (prevSig === sig) {
        const generation = bumpDoseReminderScheduleGeneration(key);
        this.enqueueRetryable(
          'schedule:' + key,
          key,
          generation,
          enqueueDoseReminderScheduleOpGuarded,
          isCurrentDoseReminderScheduleGeneration,
          async () => {
            if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;
            const pendingResult = await isDoseReminderPending(medId, doseId);
            if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;
            if (!pendingResult.ok) {
              throw new Error(
                pendingResult.error || 'dose_reminder_pending_lookup_failed'
              );
            }
            if (pendingResult.pending) return;

            const nativeReArmed = await isNativeDoseReminderReArmed(
              medId,
              doseId,
              time
            );
            if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;
            if (!nativeReArmed.ok) {
              throw new Error(
                nativeReArmed.error || 'dose_reminder_rearm_lookup_failed'
              );
            }
            if (nativeReArmed.scheduled) return;

            const scheduleOptions = {
              ...(slotConsumedToday ? { skipToday: true as const } : {}),
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
              return;
            }
            this.appliedSignature.set(key, sig);
          }
        );
        continue;
      }

      this.cancelSnoozeSlot(medId, doseId);

      const generation = bumpDoseReminderScheduleGeneration(key);
      this.enqueueRetryable(
        'schedule:' + key,
        key,
        generation,
        enqueueDoseReminderScheduleOpGuarded,
        isCurrentDoseReminderScheduleGeneration,
        async () => {
          if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;
          await cancelDoseReminder(medId, doseId);
          if (!isCurrentDoseReminderScheduleGeneration(key, generation)) return;

          const scheduleOptions = {
            ...(slotConsumedToday ? { skipToday: true as const } : {}),
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
            return;
          }
          this.appliedSignature.set(key, sig);
        }
      );
    }

    for (const prevKey of this.scheduledDoseIds) {
      if (!stillScheduled.has(prevKey)) {
        const { medId, doseId } = parseDoseScheduleKey(prevKey);
        cancelSlot(medId, doseId);
      }
    }

    for (const key of stillScheduled) this.scheduledDoseIds.add(key);
    for (const key of Array.from(this.scheduledDoseIds)) {
      if (!stillScheduled.has(key)) this.scheduledDoseIds.delete(key);
    }
  }

  reconcileConsumption(
    options: DoseReminderConsumptionReconciliationOptions
  ): void {
    if (this.disposed) return;

    const inputSignature = this.consumptionInputSignature(options);
    if (this.lastConsumptionInputSignature === inputSignature) return;
    this.lastConsumptionInputSignature = inputSignature;

    if (!options.hydrated || options.isFirstRun) return;
    if (
      !options.notificationsEnabled ||
      options.exactAlarmPermission === null ||
      options.exactAlarmPermission === 'denied'
    ) {
      return;
    }

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

          this.cancelSnoozeSlot(medId, doseId);

          const generation = bumpDoseReminderScheduleGeneration(key);
          this.enqueueRetryable(
            'schedule:' + key,
            key,
            generation,
            enqueueDoseReminderScheduleOpGuarded,
            isCurrentDoseReminderScheduleGeneration,
            async () => {
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
            }
          );
        } else if (
          wasConsumed &&
          isDoseReminderTimeStillAhead(time)
        ) {
          this.cancelSnoozeSlot(medId, doseId);

          const generation = bumpDoseReminderScheduleGeneration(key);
          this.enqueueRetryable(
            'schedule:' + key,
            key,
            generation,
            enqueueDoseReminderScheduleOpGuarded,
            isCurrentDoseReminderScheduleGeneration,
            async () => {
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
            }
          );
        }
      }
    }

    this.prevConsumedKeys.clear();
    for (const key of nextConsumedKeys) this.prevConsumedKeys.add(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAllRetries();
    this.retryGeneration += 1;
    this.scheduledDoseIds.clear();
    this.appliedSignature.clear();
    this.prevConsumedKeys.clear();
  }
}
