/**
 * Framework-neutral Dose Reminder reconciliation orchestrator.
 *
 * Focused coordinators (#469) — this service only orchestrates:
 * - `doseReminderDesiredState` — pure desired-state + input signatures.
 * - `doseReminderRetry` — bounded retry/backoff mechanics.
 * - `doseReminderSnoozeCleanup` — snooze-slot cancellation coordinator.
 * - `doseReminderConsumptionReconciliation` — consume/restore transitions.
 * - native scheduling/cancellation + stale cleanup wiring (here).
 *
 * React supplies the current medication/capability snapshot and lifecycle
 * signals; generation invalidation and cancellation semantics are unchanged
 * from the previous single-class implementation.
 */
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  isDoseReminderPending,
  isNativeDoseReminderReArmed,
  cancelStaleDoseReminderAlarms,
} from './doseReminderScheduling';
import {
  doseScheduleKey,
  parseDoseScheduleKey,
} from './doseReminderDefinitions';
import {
  bumpDoseReminderScheduleGeneration,
  isCurrentDoseReminderScheduleGeneration,
  enqueueDoseReminderScheduleOpGuarded,
} from './doseReminderOperations';
import {
  DoseReminderRetryScheduler,
} from './doseReminderRetry';
import {
  DoseReminderSnoozeCoordinator,
} from './doseReminderSnoozeCleanup';
import {
  DoseReminderConsumptionReconciler,
} from './doseReminderConsumptionReconciliation';
import {
  buildDesiredDoseReminderState,
  mainInputSignature,
  type DoseReminderReconciliationOptions,
  type DoseReminderConsumptionReconciliationOptions,
} from './doseReminderDesiredState';

export type {
  DoseReminderReconciliationOptions,
  DoseReminderConsumptionReconciliationOptions,
} from './doseReminderDesiredState';

/**
 * Dose Reminder reconciliation service: desired-state calculation, native
 * reconciliation, stale cleanup, bounded retries, generation invalidation,
 * snooze cleanup, and consume/restore transitions via focused coordinators.
 */
export class DoseReminderReconciliationService {
  private readonly scheduledDoseIds = new Set<string>();
  private readonly appliedSignature = new Map<string, string>();
  private readonly retry = new DoseReminderRetryScheduler();
  private readonly snooze = new DoseReminderSnoozeCoordinator(this.retry);
  private readonly consumption: DoseReminderConsumptionReconciler;
  private retryGeneration = 0;
  private disposed = false;
  private lastMainInputSignature: string | null = null;

  constructor() {
    this.consumption = new DoseReminderConsumptionReconciler(this.retry, this.snooze);
  }

  private bumpStaleGeneration(): number {
    return ++this.retryGeneration;
  }

  private cancelSlot(medId: string, doseId: string): void {
    const key = doseScheduleKey(medId, doseId);
    const generation = bumpDoseReminderScheduleGeneration(key);
    this.appliedSignature.delete(key);
    this.retry.clearRetry('schedule:' + key);

    this.retry.enqueueRetryable({
      retryKey: 'schedule:' + key,
      operationKey: key,
      generation,
      enqueue: enqueueDoseReminderScheduleOpGuarded,
      isCurrent: isCurrentDoseReminderScheduleGeneration,
      operation: async () => {
        await cancelDoseReminder(medId, doseId);
      },
    });

    this.snooze.cancelSnoozeSlot(medId, doseId);
  }

  reconcile(options: DoseReminderReconciliationOptions): void {
    if (this.disposed) return;

    const inputSignature = mainInputSignature(options);
    if (this.lastMainInputSignature === inputSignature) return;
    this.lastMainInputSignature = inputSignature;

    if (!options.hydrated || options.isFirstRun) return;

    if (
      !options.notificationsEnabled ||
      options.exactAlarmPermission === null ||
      options.exactAlarmPermission === 'denied'
    ) {
      for (const key of this.scheduledDoseIds) {
        const { medId, doseId } = parseDoseScheduleKey(key);
        this.cancelSlot(medId, doseId);
      }

      const staleGenerationToken = this.bumpStaleGeneration();
      this.retry.runStaleCleanupWithRetry(
        staleGenerationToken,
        (token) => !this.disposed && this.retryGeneration === token,
        () => cancelStaleDoseReminderAlarms(new Set())
      );

      this.scheduledDoseIds.clear();
      this.appliedSignature.clear();
      return;
    }

    const { desired, stillScheduled, keepNativeIds } =
      buildDesiredDoseReminderState(options);

    const staleGenerationToken = this.bumpStaleGeneration();
    this.retry.runStaleCleanupWithRetry(
      staleGenerationToken,
      (token) => !this.disposed && this.retryGeneration === token,
      () => cancelStaleDoseReminderAlarms(keepNativeIds)
    );

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
        this.retry.enqueueRetryable({
          retryKey: 'schedule:' + key,
          operationKey: key,
          generation,
          enqueue: enqueueDoseReminderScheduleOpGuarded,
          isCurrent: isCurrentDoseReminderScheduleGeneration,
          operation: async () => {
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
          },
        });
        continue;
      }

      this.snooze.cancelSnoozeSlot(medId, doseId);

      const generation = bumpDoseReminderScheduleGeneration(key);
      this.retry.enqueueRetryable({
        retryKey: 'schedule:' + key,
        operationKey: key,
        generation,
        enqueue: enqueueDoseReminderScheduleOpGuarded,
        isCurrent: isCurrentDoseReminderScheduleGeneration,
        operation: async () => {
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
        },
      });
    }

    for (const prevKey of this.scheduledDoseIds) {
      if (!stillScheduled.has(prevKey)) {
        const { medId, doseId } = parseDoseScheduleKey(prevKey);
        this.cancelSlot(medId, doseId);
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

    if (this.consumption.isSignatureCurrent(options)) return;
    this.consumption.markSignature(options);

    if (!options.hydrated || options.isFirstRun) return;
    if (
      !options.notificationsEnabled ||
      options.exactAlarmPermission === null ||
      options.exactAlarmPermission === 'denied'
    ) {
      return;
    }

    this.consumption.reconcile(options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retry.markDisposed();
    this.retry.clearAllRetries();
    this.retryGeneration += 1;
    this.scheduledDoseIds.clear();
    this.appliedSignature.clear();
    this.consumption.reset();
  }
}

/** Re-exported for direct consumers that build desired state themselves. */
export { buildDesiredDoseReminderState } from './doseReminderDesiredState';
