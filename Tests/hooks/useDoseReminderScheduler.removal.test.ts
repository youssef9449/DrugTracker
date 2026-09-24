/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushUntil } from '../helpers/asyncTestUtils';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
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




describe('Phase 4 — dose-scoped cancel on removal', () => {
  it('removing d2 cancels only d2 snooze notification and storage', async () => {
    const med = makeMed({
      id: 'med-rm-snooze',
      name: 'RmSnooze',
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    // Pending snooze for d2 only
    const { SNOOZE_KEY } = await import('@/utils/doseReminderStorage');
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({
        'med-rm-snooze::d1': Date.now() + 60_000,
        'med-rm-snooze::d2': Date.now() + 60_000,
      })
    );

    mocks.cancel.mockClear();
    mocks.cancelSnoozed.mockClear();

    const shrunk = {
      ...med,
      dosesPerDay: 1,
      doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    };
    rerender({ medications: [shrunk] });
    await flushUntil(() =>
      mocks.cancel.mock.calls.some((c) => c[0] === 'med-rm-snooze' && c[1] === 'd2')
    );

    expect(mocks.cancel).toHaveBeenCalledWith('med-rm-snooze', 'd2');
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-rm-snooze', 'd2');
    // d1 snooze storage must remain
    const snooze = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}');
    expect(snooze['med-rm-snooze::d1']).toBeDefined();
    expect(snooze['med-rm-snooze::d2']).toBeUndefined();
  });

  it('getDoseReminderSlots skips duplicate doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: 'd1', amount: 1, time: '08:00' },
        { id: 'd1', amount: 9, time: '09:00' }, // duplicate id ignored
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 3,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d1', 'd2']);
    expect(slots.find((s) => s.doseId === 'd1')?.amount).toBe(1);
  });

  it('skips empty doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: '', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d2']);
  });

  it('skips whitespace-only doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: '   ', amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d2']);
  });

  it('skips missing doseIds', () => {
    const med = makeMed({
      doseSchedule: [
        { id: undefined as unknown as string, amount: 1, time: '08:00' },
        { id: 'd2', amount: 1, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots.map((s) => s.doseId)).toEqual(['d2']);
  });

  it('two empty-id rows do not collapse into one legacy slot', () => {
    const med = makeMed({
      doseSchedule: [
        { id: '', amount: 1, time: '08:00' },
        { id: '', amount: 2, time: '14:00' },
      ],
      dosesPerDay: 2,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots).toEqual([]);
  });

  it('no-schedule med produces no reminder slots (no legacy sentinel)', () => {
    // Issue #268 / PR #271: the legacy single-dose reminder sentinel is gone.
    // A med without an explicit doseSchedule produces no reminder slots —
    // getDoseReminderSlots returns [] (no dailyDose/reminderTime synthetic
    // slot, no LEGACY_DOSE_ID).
    const med = makeMed({
      doseSchedule: undefined,
      dosesPerDay: undefined,
      reminderEnabled: true,
      reminderTime: '09:00',
      dailyDose: 1,
    });
    const slots = getDoseReminderSlots(med);
    expect(slots).toEqual([]);
  });
});
