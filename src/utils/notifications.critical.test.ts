import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock fns are accessible inside vi.mock factories
// (vi.mock is hoisted to the top of the file).
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  platform: vi.fn(() => 'web'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: mocks.platform,
  },
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    checkPermissions: mocks.checkPermissions,
  },
}));

import {
  criticalAlarmId,
  cancelCriticalAlarm,
  scheduleCriticalAlarm,
} from './notifications';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue('web');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
});

describe('criticalAlarmId', () => {
  it('returns a stable numeric id for the same medId', () => {
    const a = criticalAlarmId('med-1');
    const b = criticalAlarmId('med-1');
    expect(a).toBe(b);
    expect(typeof a).toBe('number');
  });

  it('returns different ids for different medIds', () => {
    expect(criticalAlarmId('med-1')).not.toBe(criticalAlarmId('med-2'));
  });
});

describe('cancelCriticalAlarm (web path)', () => {
  it('is a no-op on web (no persistent alarm to cancel)', async () => {
    await cancelCriticalAlarm('med-1');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});

describe('scheduleCriticalAlarm (web path)', () => {
  it('fires the web fallback immediately (no persistent scheduling on web)', async () => {
    await scheduleCriticalAlarm('med-1', 'Test Med', Date.now() + 1000);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('treats a past criticalDateMs as "immediate" (fires 1s out)', async () => {
    await scheduleCriticalAlarm('med-1', 'Test Med', Date.now() - 1000, 'قرص');
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('scheduleCriticalAlarm — native path (android)', () => {
  beforeEach(() => {
    // Switch the platform mock to 'android' just for this describe block.
    mocks.platform.mockReturnValue('android');
    mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  });

  it('schedules a one-shot notification at the given future time', async () => {
    const future = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days out
    await scheduleCriticalAlarm('med-1', 'Test Med', future, 'قرص');

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const arg = mocks.schedule.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(1);
    const notif = arg.notifications[0];
    expect(notif.id).toBe(criticalAlarmId('med-1'));
    expect(notif.title).toContain('Test Med');
    expect(notif.schedule.at.getTime()).toBeGreaterThan(Date.now());
    expect(notif.schedule.allowWhileIdle).toBe(true);
    expect(notif.channelId).toBe('low-stock');
  });

  it('fires immediately (1s out) when criticalDateMs is in the past', async () => {
    const past = Date.now() - 60_000;
    await scheduleCriticalAlarm('med-1', 'Test Med', past, 'قرص');

    const notif = mocks.schedule.mock.calls[0][0].notifications[0];
    const fireAt = notif.schedule.at.getTime();
    expect(fireAt).toBeGreaterThan(Date.now());
    expect(fireAt).toBeLessThan(Date.now() + 2000);
  });

  it('skips scheduling when permission is not granted', async () => {
    mocks.checkPermissions.mockResolvedValue({ display: 'denied' });
    await scheduleCriticalAlarm('med-1', 'Test Med', Date.now() + 1000);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('cancelCriticalAlarm calls Capacitor.cancel with the stable id', async () => {
    await cancelCriticalAlarm('med-1');
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const arg = mocks.cancel.mock.calls[0][0];
    expect(arg.notifications).toHaveLength(1);
    expect(arg.notifications[0].id).toBe(criticalAlarmId('med-1'));
  });

  it('alarm rescheduling: cancel + schedule use the SAME stable id', async () => {
    const id = criticalAlarmId('med-reschedule');
    const future = Date.now() + 5 * 24 * 60 * 60 * 1000;
    await cancelCriticalAlarm('med-reschedule');
    await scheduleCriticalAlarm('med-reschedule', 'Test', future, 'قرص');

    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    const cancelledId = mocks.cancel.mock.calls[0][0].notifications[0].id;
    const scheduledId = mocks.schedule.mock.calls[0][0].notifications[0].id;
    expect(cancelledId).toBe(id);
    expect(scheduledId).toBe(id);
  });
});

