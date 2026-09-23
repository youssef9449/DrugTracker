import { GenerationGuard } from '../async/GenerationGuard';
import { OperationQueue } from '../async/OperationQueue';

/**
 * Generic async coordinator for scheduled-identity reconciliation.
 *
 * It provides only the two mechanics shared by alarm features:
 *   - per-identity serialization;
 *   - generation-based stale-operation invalidation.
 *
 * Feature policy, desired-state calculation, native adapter semantics, and
 * delivery/recovery behavior remain outside this class.
 */
export class ScheduledOperationCoordinator<Key> {
  private readonly generationGuard = new GenerationGuard<Key>();
  private readonly operationQueue = new OperationQueue<Key>();

  bump(key: Key): number {
    return this.generationGuard.bump(key);
  }

  current(key: Key): number {
    return this.generationGuard.current(key);
  }

  isCurrent(key: Key, generation: number): boolean {
    return this.generationGuard.isCurrent(key, generation);
  }

  enqueue(
    key: Key,
    generation: number,
    operation: () => Promise<void>
  ): Promise<void> {
    return this.operationQueue.enqueue(key, async () => {
      if (!this.generationGuard.isCurrent(key, generation)) return;
      await operation();
    });
  }

  enqueueCurrent(
    key: Key,
    operation: () => Promise<void>
  ): Promise<number> {
    const generation = this.generationGuard.bump(key);
    return this.enqueue(key, generation, operation).then(
      () => generation
    );
  }
}
