/**
 * Small shared async primitive for serializing operations by key.
 *
 * No feature or business-state semantics belong here. Callers choose the
 * concurrency key that matches their own domain.
 */
export class OperationQueue<K = string> {
  private readonly chains = new Map<K, Promise<void>>();

  enqueue(key: K, operation: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.chains.set(key, next);
    next.catch(() => undefined);
    return next;
  }
}
