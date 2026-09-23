import { ScheduledOperationCoordinator } from './scheduling/ScheduledOperationCoordinator';

const scheduleCoordinator = new ScheduledOperationCoordinator<string>();
const snoozeCoordinator = new ScheduledOperationCoordinator<string>();

export function doseReminderScheduleKey(
  medicationId: string,
  doseId: string
): string {
  return 'schedule:' + medicationId + '::' + doseId;
}

export function doseReminderSnoozeKey(
  medicationId: string,
  doseId: string
): string {
  return 'snooze:' + medicationId + '::' + doseId;
}

export function bumpDoseReminderScheduleGeneration(key: string): number {
  return scheduleCoordinator.bump(key);
}

export function isCurrentDoseReminderScheduleGeneration(
  key: string,
  generation: number
): boolean {
  return scheduleCoordinator.isCurrent(key, generation);
}

export function enqueueDoseReminderScheduleOpGuarded(
  key: string,
  generation: number,
  operation: () => Promise<void>
): Promise<void> {
  return scheduleCoordinator.enqueue(key, generation, operation);
}

export function bumpDoseReminderSnoozeGeneration(key: string): number {
  return snoozeCoordinator.bump(key);
}

export function isCurrentDoseReminderSnoozeGeneration(
  key: string,
  generation: number
): boolean {
  return snoozeCoordinator.isCurrent(key, generation);
}

export function enqueueDoseReminderSnoozeOpGuarded(
  key: string,
  generation: number,
  operation: () => Promise<void>
): Promise<void> {
  return snoozeCoordinator.enqueue(key, generation, operation);
}
