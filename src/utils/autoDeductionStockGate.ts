/**
 * Shared serialization for stock-mutating auto paths:
 * - legacy syncAutoDailyDeductions
 * - exact native event reconciliation
 *
 * Prevents concurrent apply from the same startup/resume snapshot.
 * Not a distributed lock — process-local promise chain only.
 */

let chain: Promise<unknown> = Promise.resolve();

export function withAutoStockMutationGate<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = chain.then(
    () => fn(),
    () => fn()
  );
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
