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
import { clearSnoozedDoseForMed } from '../utils/doseReminderStorage';

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

    it('does NOT open when today\u2019s dose was already consumed (manual or alarm-action consumption)', () => {
      const med = makeMed({
        id: 'med-consumed-today',
        lastConsumedDate: getTodayDateString(),
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-consumed-today');
      });

      // The alarm modal must never ask the user to take an
      // already-taken dose — even if the native alarm could not be
      // suppressed (foreground safety net behind the scheduler).
      expect(result.current.alarmingMedication).toBeNull();
    });

    it('still opens when the dose was consumed YESTERDAY (guard is current-calendar-day based)', () => {
      const med = makeMed({
        id: 'med-consumed-yesterday',
        lastConsumedDate: '2024-09-09', // yesterday (system time 2024-09-10)
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-consumed-yesterday');
      });

      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-consumed-yesterday' })
      );
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


    it('stores the notification doseId so Take Dose can consume that exact slot', () => {
      const med = makeMed({
        id: 'med-dose-id',
        doseSchedule: [
          { id: 'd1', amount: 2, time: '08:00' },
          { id: 'd2', amount: 1, time: '14:00' },
        ],
        dosesPerDay: 2,
        dailyDose: 3,
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );
      act(() => {
        result.current.openAlarm('med-dose-id', 'd2');
      });
      expect(result.current.alarmingMedication?.id).toBe('med-dose-id');
      expect(result.current.alarmingDoseId).toBe('d2');
    });

    it('legacy openAlarm without doseId leaves alarmingDoseId null', () => {
      const med = makeMed({ id: 'med-legacy-alarm' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );
      act(() => {
        result.current.openAlarm('med-legacy-alarm');
      });
      expect(result.current.alarmingMedication?.id).toBe('med-legacy-alarm');
      expect(result.current.alarmingDoseId).toBeNull();
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

    it('legitimate snooze flow is intact: fire → snooze → dose NOT taken → re-fire opens the modal again', () => {
      const med = makeMed({ id: 'med-snooze-legit', reminderTime: '09:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      // Reminder fires (foreground) → modal opens.
      act(() => {
        result.current.openAlarm('med-snooze-legit');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze-legit' })
      );

      // User snoozes.
      act(() => {
        result.current.snoozeAlarm(med, 10);
      });
      expect(result.current.alarmingMedication).toBeNull();

      // Snoozed one-shot fires 10 minutes later — dose still NOT taken
      // → the modal must open again (the consumed-today guard must not
      // interfere with legitimate snoozes).
      act(() => {
        vi.setSystemTime(new Date('2024-09-10T12:10:00Z'));
        result.current.openAlarm('med-snooze-legit');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze-legit' })
      );
    });

    it('snoozed reminder for an already-consumed dose does NOT reopen the modal (consumed-today guard)', () => {
      // The user snoozed, then took the dose manually before the snooze
      // fired; even if the native cancellation of the snoozed one-shot
      // failed, the modal must not ask for the dose again.
      const med = makeMed({
        id: 'med-snooze-taken',
        reminderTime: '09:00',
        lastConsumedDate: getTodayDateString(),
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        vi.setSystemTime(new Date('2024-09-10T12:10:00Z'));
        result.current.openAlarm('med-snooze-taken');
      });

      expect(result.current.alarmingMedication).toBeNull();
    });
  });

  describe('clearSnoozedDoseForMed', () => {
    it('removes the persisted snooze marker for the medication', () => {
      const SNOOZE_KEY = 'android_med_tracker_snooze_v1';
      localStorage.setItem(
        SNOOZE_KEY,
        JSON.stringify({
          'med-a': Date.now() + 60_000,
          'med-b': Date.now() + 60_000,
        })
      );

      clearSnoozedDoseForMed('med-a');

      const snooze = JSON.parse(
        localStorage.getItem(SNOOZE_KEY) || '{}'
      ) as Record<string, number>;
      expect(snooze['med-a']).toBeUndefined();
      expect(snooze['med-b']).toBeDefined();
    });

    it('is a no-op when no marker exists', () => {
      expect(() => clearSnoozedDoseForMed('med-none')).not.toThrow();
    });
  });
});
