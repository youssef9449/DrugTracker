import { requireDefined } from '../helpers/requireDefined';
/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushUntil } from '../helpers/asyncTestUtils';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { useDoseReminderScheduler } from '@/hooks/useDoseReminderScheduler';
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
    // Chronic meds are always treatment-active; temporary meds would need
    // explicit treatmentStartDate/durationDays to schedule at all.
    isChronic: true,
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




describe('useDoseReminderScheduler — per-dose instruction', () => {
  it('passes the dose-specific instruction to scheduling and reschedules when it changes', async () => {
    const med = makeMed({
      id: 'med-description',
      reminderTime: '20:00',
      doseSchedule: [
        {
          id: 'd1',
          amount: 1,
          time: '20:00',
          description: 'بعد الإفطار',
        },
      ],
    });

    const { rerender } = renderHook(
      ({ medication }: { medication: Medication }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [medication] })
        ),
      { initialProps: { medication: med } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(requireDefined(mocks.schedule.mock.calls[0], 'mocks.schedule.mock.calls[0]')[6]?.doseDescription).toBe('بعد الإفطار');

    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    const currentDose = requireDefined(med.doseSchedule?.[0], 'med.doseSchedule[0]');
    const updated = {
      ...med,
      doseSchedule: [
        {
          ...currentDose,
          description: 'قبل النوم',
        },
      ],
    };
    rerender({ medication: updated });

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const last = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(requireDefined(requireDefined(last, 'last')[6], 'last[6]')?.doseDescription).toBe('قبل النوم');
  });

  it('does not add an instruction option when the per-dose description is empty', async () => {
    const med = makeMed({
      id: 'med-empty-description',
      doseSchedule: [
        {
          id: 'd1',
          amount: 1,
          time: '20:00',
          description: '   ',
        },
      ],
    });

    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(requireDefined(mocks.schedule.mock.calls[0], 'mocks.schedule.mock.calls[0]')[6]?.doseDescription).toBeUndefined();
  });
});
describe('useDoseReminderScheduler — manual Take capability', () => {
  it('allowManualTakeAction=false schedules without a manual Take action', async () => {
    const med = makeMed({ id: 'med-no-manual', reminderTime: '20:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({
      medications: [med],
      allowManualTakeActionByMedicationId: new Map([['med-no-manual', false]]),
    })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls.some(
      (c) => c[6]?.allowManualTakeAction === false
    )).toBe(true);
  });

  it('allowManualTakeAction=true schedules a manually actionable reminder', async () => {
    const med = makeMed({ id: 'med-manual', reminderTime: '20:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({
      medications: [med],
      allowManualTakeActionByMedicationId: new Map([['med-manual', true]]),
    })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls.some(
      (c) => c[6]?.allowManualTakeAction === true
    )).toBe(true);
  });

  it('changing the neutral capability cancels and reschedules with the new capability', async () => {
    const med = makeMed({ id: 'med-flip', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ allowManualTakeAction }: { allowManualTakeAction: boolean }) =>
        useDoseReminderScheduler(defaultOpts({
          medications: [med],
          allowManualTakeActionByMedicationId: new Map([[med.id, allowManualTakeAction]]),
        })),
      { initialProps: { allowManualTakeAction: false } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();
    rerender({ allowManualTakeAction: true });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.cancel).toHaveBeenCalledWith('med-flip', 'd1');
    expect(mocks.schedule.mock.calls.some(
      (c) => c[6]?.allowManualTakeAction === true
    )).toBe(true);
  });
});
