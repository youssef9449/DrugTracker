import { describe, it, expect } from 'vitest';
import { OperationQueue } from '@/utils/async/OperationQueue';

describe('OperationQueue', () => {
  it('serializes operations for the same key', async () => {
    const queue = new OperationQueue<string>();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.enqueue('med-1', async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });

    const second = queue.enqueue('med-1', async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('runs different keys independently', async () => {
    const queue = new OperationQueue<string>();
    const events: string[] = [];

    const a = queue.enqueue('a', async () => {
      events.push('a');
    });
    const b = queue.enqueue('b', async () => {
      events.push('b');
    });

    await Promise.all([a, b]);
    expect(events.sort()).toEqual(['a', 'b']);
  });

  it('continues after a rejected operation', async () => {
    const queue = new OperationQueue<string>();
    const failed = queue.enqueue('x', async () => {
      throw new Error('expected');
    });
    const next = queue.enqueue('x', async () => undefined);

    await expect(failed).rejects.toThrow('expected');
    await next;
  });
});
