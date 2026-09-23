import { ScheduledOperationCoordinator } from './scheduling/ScheduledOperationCoordinator';

/**
 * Shared Critical Stock async-operation boundary.
 *
 * The queue instance is feature-owned, while the queue mechanism itself is the
 * generic OperationQueue primitive. Every Critical Stock caller that can issue
 * a native alarm operation must enqueue through this module so scheduling and
 * foreground cancellation share the same per-medication serialization chain.
 *
 * Business ownership, claim state, and generation checks remain in the calling
 * Critical Stock code.
 */
const criticalAlarmCoordinator = new ScheduledOperationCoordinator<string>();

export function bumpCriticalAlarmGeneration(medId: string): number {
  return criticalAlarmCoordinator.bump(medId);
}

export function currentCriticalAlarmGeneration(medId: string): number {
  return criticalAlarmCoordinator.current(medId);
}

export function isCurrentCriticalAlarmGeneration(
  medId: string,
  generation: number
): boolean {
  return criticalAlarmCoordinator.isCurrent(medId, generation);
}

export function enqueueCriticalAlarmOp(
  medId: string,
  operation: () => Promise<unknown>
): Promise<void> {
  return criticalAlarmCoordinator.enqueueSerialized(
    medId,
    async () => {
      await operation();
    }
  );
}

export function enqueueCriticalAlarmOpGuarded(
  medId: string,
  generation: number,
  operation: () => Promise<unknown>
): Promise<void> {
  return criticalAlarmCoordinator.enqueue(
    medId,
    generation,
    async () => {
      await operation();
    }
  );
}
