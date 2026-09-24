import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAutoStockMutationGate } from '../../src/utils/autoDeductionStockGate';
import { readJsonOutcome } from '../../src/utils/storage';
import { STORAGE_MEDS_KEY } from '../../src/utils/autoDeductionStockGate';

describe('withAutoStockMutationGate cross-document locking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('requests the shared exclusive Web Lock around the durable mutation', async () => {
    const request = vi.fn(async (_name: string, options: { mode: string }, callback: () => Promise<string>) => {
      expect(options.mode).toBe('exclusive');
      return callback();
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    const result = await withAutoStockMutationGate(async () => 'committed');

    expect(result).toBe('committed');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('drugtracker:durable-stock-mutation');
  });

  it('fails closed in a secure browser context when cross-tab locking is unavailable', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });

    await expect(
      withAutoStockMutationGate(async () => 'must-not-run')
    ).rejects.toThrow('cross_tab_stock_lock_unavailable');
  });
});

describe('cross-tab stale-snapshot protection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('serializes independently loaded tab instances so the second reads the first commit', async () => {
    vi.resetModules();

    let locked = false;
    const waiters: Array<() => void> = [];
    const request = vi.fn(async (_name: string, options: { mode: string }, callback: () => Promise<unknown>) => {
      expect(options.mode).toBe('exclusive');
      if (locked) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      locked = true;
      try {
        return await callback();
      } finally {
        locked = false;
        waiters.shift()?.();
      }
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([{ id: 'm1', currentPills: 10 }])
    );

    const tabA = await import('../../src/utils/autoDeductionStockGate');
    vi.resetModules();
    const tabB = await import('../../src/utils/autoDeductionStockGate');

    const mutate = (gate: typeof tabA.withAutoStockMutationGate) =>
      gate(async (fresh) => {
        const current = Number(fresh.medications[0]?.currentPills ?? 0);
        await Promise.resolve();
        const next = current + 1;
        localStorage.setItem(
          STORAGE_MEDS_KEY,
          JSON.stringify([{ id: 'm1', currentPills: next }])
        );
      });

    await Promise.all([
      mutate(tabA.withAutoStockMutationGate),
      mutate(tabB.withAutoStockMutationGate),
    ]);

    const medsOutcome = readJsonOutcome(STORAGE_MEDS_KEY, (raw) => raw);
    expect(medsOutcome).toEqual({ status: 'ok', value: [{ id: 'm1', currentPills: 12 }] });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
