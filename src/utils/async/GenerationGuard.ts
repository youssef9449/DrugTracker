/**
 * Small shared async primitive for rejecting stale work.
 *
 * Generations are in-memory only. Persistence, business state, and ownership
 * rules remain in the feature that uses the guard.
 */
export class GenerationGuard<K = string> {
  private readonly generations = new Map<K, number>();

  bump(key: K): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  current(key: K): number {
    return this.generations.get(key) ?? 0;
  }

  isCurrent(key: K, generation: number): boolean {
    return this.current(key) === generation;
  }
}
