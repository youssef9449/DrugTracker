/**
 * Snooze reconciliation for Dose Reminder.
 *
 * Owns snooze-slot cancellation: bumping the snooze generation, enqueueing
 * the guarded native cancel + durable marker clear through the bounded retry
 * scheduler. Feature policy for WHEN snoozes are cancelled stays in the
 * reconciliation coordinators.
 */
import { cancelSnoozedDoseReminder } from './notifications/doseReminderNotifications';
import { clearSnoozedDose } from './doseReminderStorage';
import { doseScheduleKey } from './doseReminderDefinitions';
import {
  bumpDoseReminderSnoozeGeneration,
  isCurrentDoseReminderSnoozeGeneration,
  enqueueDoseReminderSnoozeOpGuarded,
  doseReminderSnoozeKey,
} from './doseReminderOperations';
import type { DoseReminderRetryScheduler } from './doseReminderRetry';

export class DoseReminderSnoozeCoordinator {
  constructor(private readonly retry: DoseReminderRetryScheduler) {}

  cancelSnoozeSlot(medId: string, doseId: string): void {
    const scheduleKey = doseScheduleKey(medId, doseId);
    const operationKey = doseReminderSnoozeKey(medId, doseId);
    const generation = bumpDoseReminderSnoozeGeneration(operationKey);
    this.retry.enqueueRetryable({
      retryKey: 'snooze:' + scheduleKey,
      operationKey,
      generation,
      enqueue: enqueueDoseReminderSnoozeOpGuarded,
      isCurrent: isCurrentDoseReminderSnoozeGeneration,
      operation: async () => {
        await cancelSnoozedDoseReminder(medId, doseId);
        if (!clearSnoozedDose(medId, doseId)) {
          throw new Error('snooze_clear_persistence_failed');
        }
      },
    });
  }
}
