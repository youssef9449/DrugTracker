/**
 * Shared async test helpers for Dose Reminder and related lifecycle tests.
 * Deterministic; no shared mutable clocks beyond what the caller provides.
 */
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

export async function flushUntil(predicate: () => boolean): Promise<void> {
  await vi.waitFor(predicate, { timeout: 1000, interval: 0 });
}
