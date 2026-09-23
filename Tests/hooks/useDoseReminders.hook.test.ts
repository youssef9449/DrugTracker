/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useDoseReminders } from '@/hooks/useDoseReminders';
import type { Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';

// Mock the sound module — only stopAllSounds remains (used by dismiss/snooze).
vi.mock('@/utils/sound', () => ({
  stopAllSounds: vi.fn(),
}));

// Mock the snooze scheduler so tests don't hit Capacitor's native bridge.
vi.mock('@/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/utils/notifications')>(
    '@/utils/notifications'
  );
  return {
    ...actual,
    scheduleSnoozedDoseReminder: vi.fn().mockResolvedValue(undefined),
  };
});

import { scheduleSnoozedDoseReminder } from '@/utils/notifications';

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
    reminderEnabled: true,
    reminderTime: '23:59',
    doseSchedule: [{ id: 'd1', amount: 1, time: '23:59' }],
    dosesPerDay: 1,
    // Suite default: Auto OFF so openAlarm opens the manual modal.
    autoDeductEnabled: false,
    ...overrides,
  };
}

/** Default hook options for tests.
 * Manual-alarm suite default: medications have Auto OFF (or empty list) so
 * openAlarm() is allowed. Opt into Auto ON via medication.autoDeductEnabled.
 */
function capabilityMap(medications: Medication[]): ReadonlyMap<string, boolean> {
  return new Map(
    medications.map((med) => [med.id, med.autoDeductEnabled === false])
  );
}

function defaultOpts(overrides: Record<string, unknown> = {}) {
  const medications =
    (overrides.medications as Medication[] | undefined) ?? [];
  return {
    medications,
    allowManualTakeActionByMedicationId: capabilityMap(medications),
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
        result.current.openAlarm('med-open', 'd1');
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
        result.current.openAlarm('med-dup', 'd1');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-dup' })
      );

      // Second call while already alarming → no-op.
      act(() => {
        result.current.openAlarm('med-dup', 'd1');
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
        JSON.stringify({ [`med-fired:d1:${today}`]: true })
      );
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-fired', 'd1');
      });

      expect(result.current.alarmingMedication).toBeNull();
    });

    it('does NOT open for a med id that no longer exists', () => {
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [] }))
      );

      act(() => {
        result.current.openAlarm('med-gone', 'd1');
      });

      expect(result.current.alarmingMedication).toBeNull();
    });

    it('does NOT open when today’s dose was already consumed (manual or alarm-action consumption)', () => {
      const med = makeMed({
        id: 'med-consumed-today',
        doseConsumptionHistory: { d1: [getTodayDateString()] },
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-consumed-today', 'd1');
      });

      expect(result.current.alarmingMedication).toBeNull();
    });

    it('still opens when the dose was consumed YESTERDAY (guard is current-calendar-day based)', () => {
      const med = makeMed({
        id: 'med-consumed-yesterday',
        doseConsumptionHistory: { d1: ['2024-09-09'] },
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-consumed-yesterday', 'd1');
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
        result.current.openAlarm('med-dismiss', 'd1');
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
      expect(result.current.alarmingDoseId).toBe('d1');

      act(() => {
        result.current.dismissAlarm();
      });

      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(Object.keys(fired).length).toBe(0);
    });
  });

  describe('snooze', () => {
    it('snoozeAlarm clears the current alarm without marking it fired', async () => {
      const med = makeMed({ id: 'med-snooze', reminderTime: '09:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );
      act(() => {
        result.current.openAlarm('med-snooze', 'd1');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze' })
      );

      await act(async () => {
        result.current.snoozeAlarm(10);
      });
      expect(result.current.alarmingMedication).toBeNull();

      const fired = JSON.parse(
        localStorage.getItem(FIRED_KEY) || '{}'
      ) as Record<string, boolean>;
      expect(fired['med-snooze']).toBeUndefined();
    });

    it('snoozeAlarm schedules a one-shot native notification to re-fire after X minutes', async () => {
      const med = makeMed({ id: 'med-snooze-sched', reminderTime: '09:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );
      act(() => {
        result.current.openAlarm('med-snooze-sched', 'd1');
      });
      await act(async () => {
        result.current.snoozeAlarm(15);
      });

      expect(scheduleSnoozedDoseReminder).toHaveBeenCalledWith(
        'med-snooze-sched',
        'Test Med',
        1,
        'قرص',
        '09:00',
        15,
        'd1',
        false,
        undefined
      );
    });

    it('keeps the alarm open and does not persist a snooze marker when native snooze scheduling fails', async () => {
      const med = makeMed({ id: 'med-snooze-failure' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-snooze-failure', 'd1');
      });

      vi.mocked(scheduleSnoozedDoseReminder).mockRejectedValueOnce(
        new Error('native snooze schedule failed')
      );

      await act(async () => {
        result.current.snoozeAlarm(10);
      });

      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze-failure' })
      );
      const snoozeState = JSON.parse(
        localStorage.getItem('android_med_tracker_snooze_v1') || '{}'
      ) as Record<string, number>;
      expect(snoozeState['med-snooze-failure::d1']).toBeUndefined();
    });

    it('legitimate snooze flow is intact: fire → snooze → dose NOT taken → re-fire opens the modal again', async () => {
      const med = makeMed({ id: 'med-snooze-legit', reminderTime: '09:00' });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        result.current.openAlarm('med-snooze-legit', 'd1');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze-legit' })
      );

      await act(async () => {
        result.current.snoozeAlarm(10);
      });
      expect(result.current.alarmingMedication).toBeNull();

      act(() => {
        vi.setSystemTime(new Date('2024-09-10T12:10:00Z'));
        result.current.openAlarm('med-snooze-legit', 'd1');
      });
      expect(result.current.alarmingMedication).toEqual(
        expect.objectContaining({ id: 'med-snooze-legit' })
      );
    });

    it('snoozed reminder for an already-consumed dose does NOT reopen the modal (consumed-today guard)', () => {
      const med = makeMed({
        id: 'med-snooze-taken',
        reminderTime: '09:00',
        doseConsumptionHistory: { d1: [getTodayDateString()] },
      });
      const { result } = renderHook(() =>
        useDoseReminders(defaultOpts({ medications: [med] }))
      );

      act(() => {
        vi.setSystemTime(new Date('2024-09-10T12:10:00Z'));
        result.current.openAlarm('med-snooze-taken', 'd1');
      });

      expect(result.current.alarmingMedication).toBeNull();
    });
  });

});

describe('useDoseReminders — manual Take capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('allowManualTakeAction=false: openAlarm does not open the manual modal', () => {
    const med = makeMed({ id: 'med-no-manual' });
    const { result } = renderHook(() => useDoseReminders({
      medications: [med],
      allowManualTakeActionByMedicationId: new Map([['med-no-manual', false]]),
    }));
    act(() => result.current.openAlarm('med-no-manual', 'd1'));
    expect(result.current.alarmingMedication).toBeNull();
  });

  it('allowManualTakeAction=true: openAlarm opens the manual modal', () => {
    const med = makeMed({ id: 'med-manual' });
    const { result } = renderHook(() => useDoseReminders({
      medications: [med],
      allowManualTakeActionByMedicationId: new Map([['med-manual', true]]),
    }));
    act(() => result.current.openAlarm('med-manual', 'd1'));
    expect(result.current.alarmingMedication?.id).toBe('med-manual');
  });
});
