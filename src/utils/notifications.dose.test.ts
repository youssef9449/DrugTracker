import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so the mocks are available inside vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  checkPermissions: vi.fn(),
  checkExactNotificationSetting: vi.fn(),
  platform: vi.fn(() => 'android'),
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
    checkExactNotificationSetting: mocks.checkExactNotificationSetting,
  },
}));

import {
  scheduleDoseReminder,
  doseReminderAlarmId,
  isDoseReminderTimeStillAhead,
} from './notifications';

/**
 * Extract the scheduled payload (id + schedule) of the LAST
 * LocalNotifications.schedule() call for the recurring dose alarm.
 */
function lastDoseSchedulePayload(): {
  id: number;
  at: Date;
  repeats: boolean;
  every: string;
} {
  expect(mocks.schedule).toHaveBeenCalled();
  const call = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
  const n = call[0].notifications[0];
  return {
    id: n.id,
    at: n.schedule.at as Date,
    repeats: n.schedule.repeats as boolean,
    every: n.schedule.every as string,
  };
}

/** Local-time Y/M/D of a Date, zero-padded — for assertions. */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0)); // 2024-09-10 12:00 local
  mocks.platform.mockReturnValue('android');
  mocks.checkPermissions.mockResolvedValue({ display: 'granted' });
  mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: 'granted' });
  mocks.schedule.mockResolvedValue({ notifications: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleDoseReminder — skipToday (consumed-day suppression)', () => {
  it('baseline: without options, a still-future reminder time fires TODAY', async () => {
    // now = 12:00, reminder 20:00 → today at 20:00.
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص');

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const payload = lastDoseSchedulePayload();
    expect(payload.at.getFullYear()).toBe(2024);
    expect(payload.at.getMonth()).toBe(8);
    expect(payload.at.getDate()).toBe(10);
    expect(payload.at.getHours()).toBe(20);
    expect(payload.at.getMinutes()).toBe(0);
    expect(payload.repeats).toBe(true);
    expect(payload.every).toBe('day');
  });

  it('skipToday: an already-consumed day re-arms the recurring alarm from TOMORROW (same HH:MM, still repeats daily)', async () => {
    // now = 12:00, reminder 20:00 still ahead — but today's dose was
    // consumed, so the first occurrence must be tomorrow 20:00.
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', { skipToday: true });

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const payload = lastDoseSchedulePayload();
    expect(ymd(payload.at)).toBe('2024-09-11'); // tomorrow
    expect(payload.at.getHours()).toBe(20);
    expect(payload.at.getMinutes()).toBe(0);
    // Tomorrow's (and every later day's) reminder must still recur.
    expect(payload.repeats).toBe(true);
    expect(payload.every).toBe('day');
    // Same stable medication-specific id band as the normal schedule.
    expect(payload.id).toBe(doseReminderAlarmId('med-1'));
  });

  it('skipToday after the reminder time already passed: exactly ONE day increment (tomorrow, never the day after)', async () => {
    // now = 21:00, reminder 20:00 already passed → normal logic gives
    // tomorrow; skipToday must NOT add a second increment.
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0));
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', { skipToday: true });

    const payload = lastDoseSchedulePayload();
    expect(ymd(payload.at)).toBe('2024-09-11'); // tomorrow — not 2024-09-12
    expect(payload.at.getHours()).toBe(20);
  });

  it('without options after the reminder time passed: tomorrow as before (existing behavior unchanged)', async () => {
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0));
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص');

    const payload = lastDoseSchedulePayload();
    expect(ymd(payload.at)).toBe('2024-09-11');
  });

  it('skipToday on web: no immediate web fallback fires for a consumed day', async () => {
    mocks.platform.mockReturnValue('web');
    await scheduleDoseReminder('med-1', 'Test', '20:00', 1, 'قرص', { skipToday: true });

    // Neither the native bridge nor the web immediate fallback fired —
    // the day's reminder is consumed.
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('skipToday keeps the exact same stable notification id as a normal schedule', async () => {
    await scheduleDoseReminder('med-1', 'Test', '09:00', 1, 'قرص');
    const normalId = lastDoseSchedulePayload().id;
    await scheduleDoseReminder('med-1', 'Test', '09:00', 1, 'قرص', { skipToday: true });
    const skippedId = lastDoseSchedulePayload().id;

    expect(skippedId).toBe(normalId);
    expect(skippedId).toBe(doseReminderAlarmId('med-1'));
  });
});

describe('isDoseReminderTimeStillAhead — suppression boundary', () => {
  it('returns true when today\u2019s HH:MM is still in the future', () => {
    // now = 12:00, reminder 20:00.
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(true);
  });

  it('returns false when today\u2019s HH:MM has already passed', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 21, 0, 0));
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(false);
  });

  it('returns false exactly AT the reminder time (same boundary as scheduleDoseReminder)', () => {
    // At exactly HH:MM:00.000 scheduleDoseReminder would push to
    // tomorrow (fireToday <= now) — "still ahead" must agree.
    vi.setSystemTime(new Date(2024, 8, 10, 20, 0, 0));
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(false);
  });

  it('returns true one minute before the boundary', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 19, 59, 0));
    expect(isDoseReminderTimeStillAhead('20:00')).toBe(true);
  });

  it('handles minutes and rejects invalid times', () => {
    vi.setSystemTime(new Date(2024, 8, 10, 12, 0, 0));
    expect(isDoseReminderTimeStillAhead('12:01')).toBe(true);
    expect(isDoseReminderTimeStillAhead('11:59')).toBe(false);
    expect(isDoseReminderTimeStillAhead('')).toBe(false);
    expect(isDoseReminderTimeStillAhead('99:99')).toBe(false);
    expect(isDoseReminderTimeStillAhead('ab:cd')).toBe(false);
  });
});
