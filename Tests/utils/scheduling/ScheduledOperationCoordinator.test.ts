import { describe, expect, it } from 'vitest';
import { ScheduledOperationCoordinator } from '@/utils/scheduling/ScheduledOperationCoordinator';

describe('ScheduledOperationCoordinator', () => {
  it('serializes operations for one identity while allowing different identities to proceed independently', async () => {
    const coordinator = new ScheduledOperationCoordinator<string>();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const generation = coordinator.bump('dose-1');
    const first = coordinator.enqueue('dose-1', generation, async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = coordinator.enqueue('dose-1', generation, async () => {
      events.push('second');
    });

    const otherGeneration = coordinator.bump('dose-2');
    const other = coordinator.enqueue('dose-2', otherGeneration, async () => {
      events.push('other');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start', 'other']);

    releaseFirst();
    await Promise.all([first, second, other]);

    expect(events).toEqual(['first:start', 'other', 'first:end', 'second']);
  });

  it('drops queued work from an older generation before execution', async () => {
    const coordinator = new ScheduledOperationCoordinator<string>();
    const events: string[] = [];

    const oldGeneration = coordinator.bump('dose-1');
    const oldWork = coordinator.enqueue('dose-1', oldGeneration, async () => {
      events.push('old');
    });

    coordinator.bump('dose-1');
    const newGeneration = coordinator.current('dose-1');
    const newWork = coordinator.enqueue('dose-1', newGeneration, async () => {
      events.push('new');
    });

    await Promise.all([oldWork, newWork]);

    expect(events).toEqual(['new']);
  });
});
