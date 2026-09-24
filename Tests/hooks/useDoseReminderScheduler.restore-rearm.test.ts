/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushUntil } from '../helpers/asyncTestUtils';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';
import { useDoseReminderScheduler, getDoseReminderSlots } from '@/hooks/useDoseReminderScheduler';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { ExactAlarmPermission } from '@/utils/exactAlarm';

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: vi.fn(() => 'web') },
  registerPlugin: () => ({
    getNextOccurrence: () => Promise.resolve({ valid: false, nextOccurrenceMs: 0 }),
    clearReArm: () => Promise.resolve({ ok: true }),
  }),
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    checkPermissions: vi.fn(),
    checkExactNotificationSetting: vi.fn(),
    getPending: vi.fn(),
  },
}));

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  cancelSnoozed: vi.fn(),
  isPending: vi.fn(),
  isNativeReArmed: vi.fn(),
  cancelStale: vi.fn(),
}));

vi.mock('@/utils/doseReminderScheduling', async () => {
  const actual = await vi.importActual<typeof import('@/utils/doseReminderScheduling')>(
    '@/utils/doseReminderScheduling'
  );
  return {
    ...actual,
    scheduleDoseReminder: mocks.schedule,
    cancelDoseReminder: mocks.cancel,
    isDoseReminderPending: mocks.isPending,
    isNativeDoseReminderReArmed: mocks.isNativeReArmed,
    // cancelStaleDoseReminderAlarms: NOT mocked — real implementation runs
    // so the test can verify actual IDs sent to LocalNotifications.cancel.
  };
});

vi.mock('@/utils/notifications/doseReminderNotifications', async () => {
  const actual = await vi.importActual<
    typeof import('@/utils/notifications/doseReminderNotifications')
  >('@/utils/notifications/doseReminderNotifications');
  return {
    ...actual,
    cancelSnoozedDoseReminder: mocks.cancelSnoozed,
  };
});

function makeMed(overrides: Partial<Medication> = {}): Medication {
  const reminderTime = overrides.reminderTime ?? '09:00';
  const dailyDose = overrides.dailyDose ?? 1;
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    reminderEnabled: true,
    reminderTime,
    // Explicit single-slot schedule so reminder slots are defined by doseSchedule.
    doseSchedule: [{ id: 'd1', amount: dailyDose, time: reminderTime }],
    dosesPerDay: 1,
    ...overrides,
  };
}



function capabilityMap(medications: Medication[]): ReadonlyMap<string, boolean> {
  return new Map(medications.map((medication) => [
    medication.id,
    medication.autoDeductEnabled === false,
  ]));
}

function defaultOpts(overrides: Record<string, unknown> = {}) {
  const medications =
    (overrides.medications as Medication[] | undefined) ?? [];
  return {
    medications,
    allowManualTakeActionByMedicationId: capabilityMap(medications),
    notificationsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    exactAlarmPermission: 'granted' as ExactAlarmPermission | null,
    resumeTick: 0 as number | undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  mocks.schedule.mockReset();
  mocks.cancel.mockReset();
  mocks.cancelSnoozed.mockReset();
  mocks.isPending.mockReset();
  mocks.isNativeReArmed.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.cancelSnoozed.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
  mocks.isPending.mockResolvedValue({ ok: true, pending: false });
  mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
  // Default: no pending notifications (web platform / no stale alarms).
  vi.mocked(LocalNotifications.getPending).mockResolvedValue({ notifications: [] });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});




describe('useDoseReminderScheduler — restore re-arms future dose notification', () => {
  /**
   * Regression: consume → suppress notification → restore while time still
   * ahead → reminder must be re-armed for today (no skipToday).
   */

  it('Test A/D — future restored multi-dose slot is re-armed without skipToday', async () => {
    // now = 17:00, d2 at 20:00 still ahead. Consume then restore d2.
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const base = makeMed({
      id: 'med-restore',
      name: 'RestoreMed',
      reminderEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
    });

    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [base] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[5]?.doseId === 'd2')
    );
    const schedulesAfterMount = mocks.schedule.mock.calls.length;

    // Consume d2 → suppression with skipToday
    const consumed = {
      ...base,
      doseConsumptionHistory: { d2: [today] },
    };
    rerender({ medications: [consumed] });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) =>
          c[0] === 'med-restore' &&
          c[5]?.doseId === 'd2' &&
          c[6]?.skipToday === true
      )
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-restore',
      'RestoreMed',
      '20:00',
      1,
      'قرص',
      'd2', { skipToday: true }
    );

    // Restore d2 (clear consumption) while 20:00 still ahead
    const restored = {
      ...base,
      doseConsumptionHistory: {},
    };
    const schedulesBeforeRestore = mocks.schedule.mock.calls.length;
    rerender({ medications: [restored] });

    await flushUntil(() =>
      mocks.schedule.mock.calls
        .slice(schedulesBeforeRestore)
        .some(
          (c) =>
            c[0] === 'med-restore' &&
            c[2] === '20:00' &&
            c[5]?.doseId === 'd2' &&
            !c[6]?.skipToday
        )
    );

    const postRestore = mocks.schedule.mock.calls.slice(schedulesBeforeRestore);
    const d2Rearm = postRestore.find(
      (c) => c[0] === 'med-restore' && c[5]?.doseId === 'd2' && !c[6]?.skipToday
    );
    expect(d2Rearm).toBeDefined();
    expect(d2Rearm).toEqual([
      'med-restore',
      'RestoreMed',
      '20:00',
      1,
      'قرص',
      { doseId: 'd2' },
    ]);
    // Must not leave a skipToday schedule as the final action for d2
    const lastD2 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === 'med-restore' && c[5]?.doseId === 'd2');
    expect(lastD2?.[6]?.skipToday).toBeUndefined();
    void schedulesAfterMount;
  });

  it('Test B — past restored dose is not scheduled for the past occurrence', async () => {
    // now = 17:00, d2 at 14:00 already passed. Restore must not create a
    // past-due reminder (no scheduleDoseReminder for 14:00 without skipToday
    // that would fire today — scheduleDoseReminder itself advances past times
    // to tomorrow, but the scheduler must not invent a past occurrence).
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const base = makeMed({
      id: 'med-past',
      name: 'PastMed',
      reminderEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
      doseConsumptionHistory: { d2: [today] },
    });

    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [base] } }
    );
    // Let consumption path settle (d2 time already past → no skipToday re-arm)
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    const schedulesBefore = mocks.schedule.mock.calls.length;

    // Restore d2 (clear consumption)
    const restored = {
      ...base,
      doseConsumptionHistory: {},
    };
    rerender({ medications: [restored] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    // No new schedule for the already-passed 14:00 occurrence as a
    // "today without skipToday" arm. (Recurring tomorrow may still exist
    // from the main config effect at mount — that is fine.)
    const post = mocks.schedule.mock.calls.slice(schedulesBefore);
    const pastTodayArm = post.find(
      (c) =>
        c[0] === 'med-past' &&
        c[2] === '14:00' &&
        c[5]?.doseId === 'd2' &&
        !c[6]?.skipToday
    );
    // After restore of a past slot, the consumption effect must not schedule
    // for the past occurrence (isDoseReminderTimeStillAhead is false).
    expect(pastTodayArm).toBeUndefined();
  });

  it('Test C — restoring d2 does not run restore re-arm for still-consumed sibling d1', async () => {
    // Both d1 (18:00) and d2 (20:00) are still ahead at 17:00.
    // Both start consumed; restore ONLY d2. Sibling d1 must stay suppressed
    // and must not receive a restore-path re-arm (schedule without skipToday).
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const base = makeMed({
      id: 'med-sib',
      name: 'SibMed',
      reminderEnabled: true,
      doseSchedule: [
        { id: 'd1', amount: 1, time: '18:00' },
        { id: 'd2', amount: 1, time: '20:00' },
      ],
      dosesPerDay: 2,
      doseConsumptionHistory: { d1: [today], d2: [today] },
    });

    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [base] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-sib' && c[5]?.doseId === 'd1' && c[6]?.skipToday === true
      ) &&
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-sib' && c[5]?.doseId === 'd2' && c[6]?.skipToday === true
      )
    );

    const schedulesBeforeRestore = mocks.schedule.mock.calls.length;
    const cancelsBeforeRestore = mocks.cancel.mock.calls.length;

    // Restore ONLY d2 (d1 remains consumed)
    const restoredD2 = {
      ...base,
      doseConsumptionHistory: { d1: [today] },
    };
    rerender({ medications: [restoredD2] });
    await flushUntil(() =>
      mocks.schedule.mock.calls
        .slice(schedulesBeforeRestore)
        .some(
          (c) =>
            c[0] === 'med-sib' &&
            c[5]?.doseId === 'd2' &&
            !c[6]?.skipToday
        )
    );
    await Promise.resolve();
    await Promise.resolve();

    const postRestoreSchedules = mocks.schedule.mock.calls.slice(schedulesBeforeRestore);
    const postRestoreCancels = mocks.cancel.mock.calls.slice(cancelsBeforeRestore);

    // d2: restore re-arm without skipToday
    expect(
      postRestoreSchedules.some(
        (c) =>
          c[0] === 'med-sib' &&
          c[2] === '20:00' &&
          c[5]?.doseId === 'd2' &&
          c[6]?.skipToday !== true
      )
    ).toBe(true);
    expect(postRestoreCancels.some((c) => c[0] === 'med-sib' && c[1] === 'd2')).toBe(
      true
    );

    // d1: must NOT receive restore-path re-arm (schedule without skipToday).
    // Still-consumed sibling may only keep prior skipToday suppression;
    // signature-only restore of d2 must not cancel/reschedule d1.
    expect(
      postRestoreSchedules.some(
        (c) =>
          c[0] === 'med-sib' &&
          c[5]?.doseId === 'd1' &&
          c[6]?.skipToday !== true
      )
    ).toBe(false);
    expect(
      postRestoreSchedules.some((c) => c[0] === 'med-sib' && c[5]?.doseId === 'd1')
    ).toBe(false);
    expect(
      postRestoreCancels.some((c) => c[0] === 'med-sib' && c[1] === 'd1')
    ).toBe(false);

    // Final logical state: d2 armed today, d1 last schedule still skipToday
    const lastD2 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === 'med-sib' && c[5]?.doseId === 'd2');
    expect(lastD2?.[6]?.skipToday).toBeUndefined();
    expect(lastD2?.[2]).toBe('20:00');

    const lastD1 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === 'med-sib' && c[5]?.doseId === 'd1');
    expect(lastD1?.[5]?.skipToday).toBe(true);
    expect(lastD1?.[2]).toBe('18:00');
  });


  it('second effect run with same signature does not cancel+reschedule when pending', async () => {
    const med = makeMed({ reminderTime: '09:00' });
    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    const schedulesAfterFirst = mocks.schedule.mock.calls.length;
    expect(schedulesAfterFirst).toBeGreaterThanOrEqual(1);

    // Next lifecycle: pretend native still has the pending id.
    mocks.isPending.mockResolvedValue({ ok: true, pending: true });
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('repairs missing pending without changing signature', async () => {
    const med = makeMed({ reminderTime: '09:00' });
    const { rerender } = renderHook(
      (props: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });

    rerender({ lifecycleTick: 2 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Repair schedules without cancel when signature unchanged and pending missing.
    expect(mocks.schedule).toHaveBeenCalled();
  });

});
