import { beforeEach, describe, expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  scheduleSnooze: vi.fn(),
  cancelSnooze: vi.fn(),
  isScheduled: vi.fn(),
  listScheduled: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: vi.fn(() => 'android'),
  },
  registerPlugin: () => plugin,
}));

import {
  isDoseReminderScheduledNative,
  listDoseReminderScheduledKeysNative,
} from '@/utils/doseReminderNative';

describe('doseReminderNative failure-aware state boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('distinguishes a real absent pending alarm from a native pending-state failure', async () => {
    plugin.isScheduled.mockResolvedValueOnce({ scheduled: false });
    const absent = await isDoseReminderScheduledNative('med-1', 'd1');
    expect(absent).toEqual({
      ok: true,
      scheduled: false,
      triggerAtEpochMs: undefined,
    });

    plugin.isScheduled.mockRejectedValueOnce(
      new Error('AlarmManager query failed')
    );
    const failed = await isDoseReminderScheduledNative('med-1', 'd1');
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.errorCode).toBe('platform_failure');
    }
  });

  it('distinguishes a real empty schedule list from a native list failure', async () => {
    plugin.listScheduled.mockResolvedValueOnce({ keys: [] });
    await expect(
      listDoseReminderScheduledKeysNative()
    ).resolves.toEqual({ ok: true, keys: [] });

    plugin.listScheduled.mockRejectedValueOnce(
      new Error('schedule listing unavailable')
    );
    const failed = await listDoseReminderScheduledKeysNative();
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.errorCode).toBe('platform_failure');
    }
  });
});
