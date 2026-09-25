import { act } from '@testing-library/react';

/** Flush pending microtasks inside act. */
export async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Resolve a deferred promise the test controls. */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Poll until `predicate()` turns true, yielding to the microtask AND
 * macrotask queues between attempts so chained async operations
 * (operation queues, bounded-retry scheduling) can settle.
 *
 * Note: vitest's `vi.waitFor` resolves as soon as its callback does not
 * THROW (it does not poll falsy return values), so it cannot express
 * "wait until this spy was called" — hence this explicit loop.
 */
export async function flushUntil(
  predicate: () => boolean,
  timeoutMs: number = 1000
): Promise<void> {
  await act(async () => {
    const startedAt = Date.now();
    while (!predicate()) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `flushUntil: condition not met within ${timeoutMs}ms`
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    }
  });
}
