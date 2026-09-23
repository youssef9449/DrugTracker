import { describe, expect, it } from 'vitest';
import {
  bumpDoseReminderSnoozeGeneration,
  enqueueDoseReminderSnoozeOpGuarded,
  isCurrentDoseReminderSnoozeGeneration,
  doseReminderSnoozeKey,
} from '@/utils/doseReminderOperations';

describe('doseReminderOperations', () => {
  it('invalidates a queued snooze schedule when cancellation publishes a newer generation', async () => {
    const key = doseReminderSnoozeKey('med-1', 'd1');
    const events: string[] = [];

    const oldGeneration = bumpDoseReminderSnoozeGeneration(key);
    const oldWork = enqueueDoseReminderSnoozeOpGuarded(
      key,
      oldGeneration,
      async () => {
        events.push('old');
      }
    );

    bumpDoseReminderSnoozeGeneration(key);
    await oldWork;

    expect(isCurrentDoseReminderSnoozeGeneration(key, oldGeneration)).toBe(false);
    expect(events).toEqual([]);
  });
});
