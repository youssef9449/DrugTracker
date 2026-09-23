import { describe, expect, it, vi } from 'vitest';
import { withAutoStockMutationGate } from '../../src/utils/autoDeductionStockGate';

describe('withAutoStockMutationGate cross-document locking', () => {
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

  it('fails closed in a browser context when cross-tab locking is unavailable', async () => {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });

    await expect(
      withAutoStockMutationGate(async () => 'must-not-run')
    ).rejects.toThrow('cross_tab_stock_lock_unavailable');
  });
});
