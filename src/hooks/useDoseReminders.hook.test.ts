/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useDoseReminders } from './useDoseReminders';
import type { Medication } from '../types';

// Mock the sound + notifications modules so the hook doesn't actually
// play audio or schedule OS notifications during tests.
vi.mock('../utils/sound', () => ({
  playNotificationSound: vi.fn(),
}));
vi.mock('../utils/notifications', () => ({
  sendMedicationDoseReminder: vi.fn(),
}));

// Import the mocked functions so we can assert on them.
import { playNotificationSound } from '../utils/sound';
import { sendMedicationDoseReminder } from '../utils/notifications';

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
    lastSyncDate: '2024-01-01',
    reminderEnabled: true,
    reminderTime: '23:59', // far-future so the polling effect won't fire
    notificationSound: 'classic_chime',
    ...overrides,
  };
}

/** Default hook options for tests. */
function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    medications: [],
    soundEnabled: true,
    notificationsEnabled: false,
    hydrated: true,
    globalCustomSound: null,
    ...overrides,
  };
}

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';

describe('useDoseReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('#24 — hydrated gate', () => {
    it('does NOT fire an alarm before hydration (hydrated: false) even if a med is due', () => {
      // Med is due now (reminderTime "00:00" and current time is later).
      const med = makeMed({ reminderTime: '00:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], hydrated: false }))
      );
      // No alarm should have fired.
      expect(result.current.alarmingMedication).toBeNull();
      expect(playNotificationSound).not.toHaveBeenCalled();
    });

    it('fires an alarm after hydration (hydrated: true) when a med is due', () => {
      // Use a reminderTime in the past so the polling check fires
      // immediately on the first checkDue() call.
      const med = makeMed({ id: 'med-due', reminderTime: '00:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], hydrated: true }))
      );
      // The polling effect calls checkDue() immediately on mount.
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-due' })
      );
    });
  });

  describe('#13 — testAlarm does not poison FIRED_KEY', () => {
    it('testAlarm opens the modal but does NOT write FIRED_KEY on dismiss', () => {
      const med = makeMed({ id: 'med-a', reminderTime: '23:59' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], hydrated: true }))
      );

      // No alarm initially (reminderTime 23:59 is in the future during
      // most of the day; if it happens to be 23:59, the polling effect
      // may fire — but we call testAlarm explicitly which always fires).
      expect(result.current.alarmingMedication).toBeNull();

      // Trigger a test alarm.
      act(() => {
        result.current.testAlarm(med);
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-a' })
      );

      // Dismiss the test alarm.
      act(() => {
        result.current.dismissAlarm();
      });
      expect(result.current.alarmingMedication).toBeNull();

      // FIRED_KEY must NOT contain the med — a test alarm must not block
      // the real reminder later today.
      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(fired['med-a']).toBeUndefined();
    });

    it('a REAL alarm (from the polling effect) DOES write FIRED_KEY on dismiss', () => {
      // ReminderTime "00:00" with hydrated:true → the polling effect
      // fires immediately (current time >= 00:00).
      const med = makeMed({ id: 'med-real', reminderTime: '00:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], hydrated: true }))
      );
      // The real alarm fired.
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-real' })
      );

      act(() => {
        result.current.dismissAlarm();
      });

      // FIRED_KEY MUST contain the med — a real alarm marks itself fired.
      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      // The key is "<medId>:<today's date>".
      const today = new Date().toISOString().slice(0, 10);
      expect(fired[`med-real:${today}`]).toBe(true);
    });

    it('a test alarm followed by a real alarm still marks the real one fired', () => {
      const med = makeMed({ id: 'med-mixed', reminderTime: '00:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], hydrated: true }))
      );

      // First: the real polling alarm fires (reminderTime 00:00).
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-mixed' })
      );
      // Dismiss the real alarm.
      act(() => {
        result.current.dismissAlarm();
      });
      // FIRED_KEY now has the real alarm marked.
      const fired1 = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      const today = new Date().toISOString().slice(0, 10);
      expect(fired1[`med-mixed:${today}`]).toBe(true);

      // Now trigger a test alarm on the same med (already fired today).
      act(() => {
        result.current.testAlarm(med);
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-mixed' })
      );
      // Dismiss the test alarm — it must NOT clear or re-write FIRED_KEY
      // in a way that un-marks the real one.
      act(() => {
        result.current.dismissAlarm();
      });
      const fired2 = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      // The real alarm's fired marker is still there (test alarm doesn't
      // clear it — it just doesn't ADD a new one).
      expect(fired2[`med-mixed:${today}`]).toBe(true);
    });
  });

  describe('snooze', () => {
    it('snoozeAlarm clears the current alarm without marking it fired', () => {
      const med = makeMed({ id: 'med-snooze', reminderTime: '00:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med], hydrated: true }))
      );
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze' })
      );

      act(() => {
        result.current.snoozeAlarm(10);
      });
      expect(result.current.alarmingMedication).toBeNull();

      // Snooze must NOT write FIRED_KEY (the reminder should re-fire
      // after the snooze window, not be blocked for the day).
      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(fired['med-snooze']).toBeUndefined();
    });
  });

  describe('notifications', () => {
    it('triggerAlarm sends a dose reminder notification when notificationsEnabled', () => {
      const med = makeMed({ id: 'med-notify', reminderTime: '00:00' });
      renderHook(() =>
        useDoseReminders(
          defaultOpts({
            medications: [med],
            hydrated: true,
            notificationsEnabled: true,
          })
        )
      );
      expect(sendMedicationDoseReminder).toHaveBeenCalledWith(
        'med-notify',
        'Test Med',
        1,
        'قرص',
        10,
        '00:00',
        null
      );
    });

    it('triggerAlarm does NOT send a notification when notificationsEnabled is false', () => {
      const med = makeMed({ id: 'med-no-notify', reminderTime: '00:00' });
      renderHook(() =>
        useDoseReminders(
          defaultOpts({
            medications: [med],
            hydrated: true,
            notificationsEnabled: false,
          })
        )
      );
      expect(sendMedicationDoseReminder).not.toHaveBeenCalled();
    });

    it('triggerAlarm plays the in-app chime when soundEnabled is true', () => {
      const med = makeMed({ id: 'med-sound', reminderTime: '00:00' });
      renderHook(() =>
        useDoseReminders(
          defaultOpts({
            medications: [med],
            hydrated: true,
            soundEnabled: true,
          })
        )
      );
      expect(playNotificationSound).toHaveBeenCalledWith('classic_chime');
    });

    it('triggerAlarm does NOT play the chime when soundEnabled is false (#19)', () => {
      const med = makeMed({ id: 'med-no-sound', reminderTime: '00:00' });
      renderHook(() =>
        useDoseReminders(
          defaultOpts({
            medications: [med],
            hydrated: true,
            soundEnabled: false,
          })
        )
      );
      // The polling-effect-triggered alarm must respect soundEnabled.
      // (#19 was about the DoseAlarmModal useEffect ignoring soundEnabled;
      // that useEffect is now removed, and triggerAlarm already gated on
      // soundEnabledRef — this test pins that behavior.)
      expect(playNotificationSound).not.toHaveBeenCalled();
    });
  });
});
