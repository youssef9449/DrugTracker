import { OperationQueue } from './async/OperationQueue';

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
const criticalAlarmOperationQueue = new OperationQueue<string>();

export function enqueueCriticalAlarmOp(
  medId: string,
  operation: () => Promise<void>
): Promise<void> {
  return criticalAlarmOperationQueue.enqueue(medId, operation);
}
