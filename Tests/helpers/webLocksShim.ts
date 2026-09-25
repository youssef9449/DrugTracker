/**
 * Installable Web Locks test double (#484).
 *
 * Mirrors the real Web Locks contract the claim coordinator depends on:
 * `request(name, { mode }, callback)` serializes same-name requests via a
 * per-name promise chain, exactly like the browser's cross-document lock
 * manager serializes same-origin documents. Tests that exercise claim
 * ACQUISITION must install this shim — without a lock manager the
 * coordinator fails closed with `locks_unavailable` (#484 contract).
 */

type RequestCallback<T> = () => T | Promise<T>;

export interface WebLocksShimHandle {
  /** Number of times a lock request was made (any name). */
  readonly requestCount: number;
  uninstall(): void;
}

export function installWebLocksShim(): WebLocksShimHandle {
  const chains = new Map<string, Promise<unknown>>();
  let requestCount = 0;

  const locks = {
    request<T>(name: string, callback: RequestCallback<T>): Promise<T> {
      requestCount += 1;
      const prev = chains.get(name) ?? Promise.resolve();
      const acquired = prev.then(() =>
        Promise.resolve().then(callback)
      ) as Promise<T>;
      // Keep the chain alive even if this callback rejects, but propagate
      // the rejection to this caller.
      chains.set(name, acquired.catch(() => undefined));
      return acquired;
    },
  };

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    Navigator.prototype,
    'locks'
  );
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    get() {
      return locks;
    },
  });

  return {
    get requestCount() {
      return requestCount;
    },
    uninstall() {
      if (originalDescriptor) {
        Object.defineProperty(Navigator.prototype, 'locks', originalDescriptor);
      } else {
        // jsdom does not implement navigator.locks; just remove the stub.
        delete (navigator as unknown as { locks?: unknown }).locks;
      }
    },
  };
}

/** Ensure NO lock manager is visible to the code under test. */
export function removeWebLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: undefined,
    writable: true,
  });
  delete (navigator as unknown as { locks?: unknown }).locks;
}
