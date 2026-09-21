import { describe, expect, it } from 'vitest';
import { enqueueCriticalAlarmOp } from '@/utils/criticalAlarmOperations';

describe('criticalAlarmOperations', () => {
  it('serializes native alarm operations across all Critical Stock callers for one medication', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = enqueueCriticalAlarmOp('med-1', async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });

    const second = enqueueCriticalAlarmOp('med-1', async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('keeps different medication keys independent', async () => {
    const events: string[] = [];

    const first = enqueueCriticalAlarmOp('med-1', async () => {
      events.push('med-1');
    });
    const second = enqueueCriticalAlarmOp('med-2', async () => {
      events.push('med-2');
    });

    await Promise.all([first, second]);
    expect(events.sort()).toEqual(['med-1', 'med-2']);
  });
});
