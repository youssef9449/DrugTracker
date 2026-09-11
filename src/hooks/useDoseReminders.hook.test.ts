/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useDoseReminders } from './useDoseReminders';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';

// Mock the sound module — only stopAllSounds remains (used by dismiss/snooze).
vi.mock('../utils/sound', () => ({
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
    ...overrides,
  };
}

/** Default hook options for tests. */
function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    medications: [],
    ...overrides,
  };
}

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';

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

  describe('openAlarm', () => {
    it('opens the DoseAlarmModal for the given med (no JS sound)', () => {
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
    });

    it('does NOT re-open if already alarming the same med (dedup)', () => {
      const med = makeMed({ id: 'med-dup' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-dup');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-dup' })
      );

      // Second call while already alarming → no-op.
      act(() => {
        result.current.openAlarm('med-dup');
      });
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
    });

    it('does NOT open for a med id that no longer exists', () => {
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [] }))
      );

      act(() => {
        result.current.openAlarm('med-gone');
      });

      expect(result.current.alarmingMedication).toBeNull();
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

  describe('testAlarm', () => {
    it('opens the modal without writing FIRED_KEY', () => {
      const med = makeMed({ id: 'med-test' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.testAlarm(med);
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-test' })
      );

      act(() => {
        result.current.dismissAlarm();
      });

      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      // testAlarm must NOT write FIRED_KEY.
      expect(Object.keys(fired).length).toBe(0);
    });
  });

  describe('snooze', () => {
    it('snoozeAlarm clears the current alarm without marking it fired', () => {
      const med = makeMed({ id: 'med-snooze', reminderTime: '09:00' });
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
        15
      );
    });
  });
});
