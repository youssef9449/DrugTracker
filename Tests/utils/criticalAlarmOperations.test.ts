import { describe, expect, it } from 'vitest';
import {
  bumpCriticalAlarmGeneration,
  enqueueCriticalAlarmOp,
} from '@/utils/criticalAlarmOperations';

describe('criticalAlarmOperations', () => {
  it('serializes native alarm operations across all Critical Stock callers for one medication', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;

    const firstGeneration = bumpCriticalAlarmGeneration('med-1');
    const first = enqueueCriticalAlarmOp('med-1', firstGeneration, async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
        it('drops stale work when a newer generation supersedes it', async () => {
    const events: string[] = [];
    const firstGeneration = bumpCriticalAlarmGeneration('med-stale');
    const first = enqueueCriticalAlarmOp(
      'med-stale',
      firstGeneration,
      async () => {
        events.push('stale');
      }
    );

    bumpCriticalAlarmGeneration('med-stale');
    await first;

    expect(events).toEqual([]);
  });
});
      events.push('first:end');
    });

    const secondGeneration = bumpCriticalAlarmGeneration('med-1');
    const second = enqueueCriticalAlarmOp('med-1', secondGeneration, async () => {
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

    const firstGeneration = bumpCriticalAlarmGeneration('med-1');
    const first = enqueueCriticalAlarmOp('med-1', firstGeneration, async () => {
      events.push('med-1');
    });
    const secondGeneration = bumpCriticalAlarmGeneration('med-2');
    const second = enqueueCriticalAlarmOp('med-2', secondGeneration, async () => {
      events.push('med-2');
    });

    await Promise.all([first, second]);
    expect(events.sort()).toEqual(['med-1', 'med-2']);
  });
});
