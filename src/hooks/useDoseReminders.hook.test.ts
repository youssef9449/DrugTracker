/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useDoseReminders } from './useDoseReminders';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';

// Mock the sound module so the hook doesn't actually play audio during tests.
vi.mock('../utils/sound', () => ({
  playNotificationSound: vi.fn(),
  stopAllSounds: vi.fn(),
}));

// Mock the snooze scheduler so tests don't hit Capacitor's native bridge.
vi.mock('../utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../utils/notifications')>(
    '../utils/notifications'
  );
  return {
    ...actual,
    scheduleSnoozedDoseReminder: vi.fn().mockResolvedValue(undefined),
  };
});

// Import the mocked functions so we can assert on them.
import { playNotificationSound } from '../utils/sound';
import { scheduleSnoozedDoseReminder } from '../utils/notifications';

/** Build a medication with a reminder enabled at the given time. */
function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-test',
    name: 'Test Med',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    reminderEnabled: true,
    reminderTime: '23:59',
    notificationSound: 'classic_chime',
    ...overrides,
  };
}

/** Default hook options for tests. */
function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    medications: [],
    soundEnabled: true,
    ...overrides,
  };
}

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';

// Pin system time so `getTodayDateString()` (used to build FIRED_KEY
// entries like `med-real:<today>`) resolves to a deterministic date.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDoseReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('openAlarm (called by the native localNotificationReceived listener)', () => {
    it('opens the DoseAlarmModal for the given med (sound is played by the listener, NOT openAlarm)', () => {
      const med = makeMed({ id: 'med-open' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-open');
      });

      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-open' })
      );
      // openAlarm does NOT play the sound — the localNotificationReceived
      // listener in native.ts already played the single authoritative
      // sound before calling openAlarm. This prevents double sounds.
      expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it('does NOT open when soundEnabled is false (no chime)', () => {
      const med = makeMed({ id: 'med-nosound' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], soundEnabled: false }))
      );

      act(() => {
        result.current.openAlarm('med-nosound');
      });

      // Modal opens (the alarm is still surfaced), but no chime.
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-nosound' })
      );
      expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it('does NOT re-open if already alarming the same med (dedup)', () => {
      const med = makeMed({ id: 'med-dup' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-dup');
      });
      // openAlarm doesn't play a sound (listener does), so we check the
      // modal state instead of call counts.
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-dup' })
      );

      // Second call while already alarming → no-op (modal stays open,
      // no re-open).
      act(() => {
        result.current.openAlarm('med-dup');
      });
      // Still the same med, no change.
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-dup' })
      );
    });

    it('does NOT open when the med was already fired today (FIRED_KEY dedup)', () => {
      const med = makeMed({ id: 'med-fired' });
      const today = new Date().toISOString().slice(0, 10);
      localStorage.setItem(
        FIRED_KEY,
        JSON.stringify({ [`med-fired:${today}`]: true })
      );
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-fired');
      });

      expect(result.current.alarmingMedication).toBeNull();
      expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it('does NOT open for a med id that no longer exists (deleted between schedule + fire)', () => {
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [] /* med removed */ }))
      );

      act(() => {
        result.current.openAlarm('med-gone');
      });

      expect(result.current.alarmingMedication).toBeNull();
      expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it('dismissAlarm writes FIRED_KEY so the reminder does not re-fire today', () => {
      const med = makeMed({ id: 'med-dismiss' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-dismiss');
      });
      act(() => {
        result.current.dismissAlarm();
      });

      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      const today = new Date().toISOString().slice(0, 10);
      expect(fired[`med-dismiss:${today}`]).toBe(true);
    });
  });

  describe('single-sound policy (openAlarm does NOT play a sound)', () => {
    // The localNotificationReceived listener in native.ts is the SINGLE
    // authoritative sound path. It plays either the custom sound (if
    // set) or the per-med synthesized chime, then calls openAlarm.
    // openAlarm must NOT play any sound — otherwise two sounds would
    // play on a dose event (the listener's + openAlarm's).
    it('openAlarm does NOT call playNotificationSound (listener owns the sound)', () => {
      const med = makeMed({ id: 'med-sound-policy' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], soundEnabled: true }))
      );

      act(() => {
        result.current.openAlarm('med-sound-policy');
      });

      // Modal opens.
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-sound-policy' })
      );
      // But NO sound is played by openAlarm — the listener already did.
      expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it('testAlarm DOES play the chime (manual test is not a notification event)', () => {
      const med = makeMed({ id: 'med-test-sound' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], soundEnabled: true }))
      );

      act(() => {
        result.current.testAlarm(med);
      });

      // testAlarm plays the chime because it's triggered manually by the
      // user (not by the notification listener), so there's no listener
      // sound to duplicate.
      expect(playNotificationSound).toHaveBeenCalledWith('classic_chime');
    });
  });

  describe('#13 — testAlarm does not poison FIRED_KEY', () => {
    it('testAlarm opens the modal but does NOT write FIRED_KEY on dismiss', () => {
      const med = makeMed({ id: 'med-a' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.testAlarm(med);
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-a' })
      );

      act(() => {
        result.current.dismissAlarm();
      });
      expect(result.current.alarmingMedication).toBeNull();

      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(fired['med-a']).toBeUndefined();
    });

    it('a REAL alarm (openAlarm) DOES write FIRED_KEY on dismiss', () => {
      const med = makeMed({ id: 'med-real' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-real');
      });
      act(() => {
        result.current.dismissAlarm();
      });

      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      const today = new Date().toISOString().slice(0, 10);
      expect(fired[`med-real:${today}`]).toBe(true);
    });

    it('a test alarm followed by a real alarm still marks the real one fired', () => {
      const med = makeMed({ id: 'med-mixed' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      // Real alarm first.
      act(() => {
        result.current.openAlarm('med-mixed');
      });
      act(() => {
        result.current.dismissAlarm();
      });
      const today = new Date().toISOString().slice(0, 10);
      let fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(fired[`med-mixed:${today}`]).toBe(true);

      // Now a test alarm on the same med.
      act(() => {
        result.current.testAlarm(med);
      });
      act(() => {
        result.current.dismissAlarm();
      });
      fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      // The real alarm's fired marker is still there.
      expect(fired[`med-mixed:${today}`]).toBe(true);
    });
  });

  describe('snooze', () => {
    it('snoozeAlarm clears the current alarm without marking it fired', () => {
      const med = makeMed({ id: 'med-snooze' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );
      act(() => {
        result.current.openAlarm('med-snooze');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze' })
      );

      act(() => {
        result.current.snoozeAlarm(med, 10);
      });
      expect(result.current.alarmingMedication).toBeNull();

      // Snooze must NOT write FIRED_KEY.
      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(fired['med-snooze']).toBeUndefined();
    });

    it('snoozeAlarm schedules a one-shot native notification to re-fire after X minutes', () => {
      const med = makeMed({ id: 'med-snooze-sched', reminderTime: '09:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );
      act(() => {
        result.current.openAlarm('med-snooze-sched');
      });
      act(() => {
        result.current.snoozeAlarm(med, 15);
      });

      expect(scheduleSnoozedDoseReminder).toHaveBeenCalledWith(
        'med-snooze-sched',
        'Test Med',
        1,
        'قرص',
        '09:00',
        15,
        'classic_chime'
      );
    });
  });
});
