/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { makeDoseReminderMedication as makeMed, makeDoseReminderCapabilityMap as capabilityMap, makeDoseReminderOptions as defaultOpts, flushTestMicrotasks as flushUntil } from '../fixtures/testFixtures';
import { getTodayDateString } from '@/utils/dateCalculations';
import { useDoseReminderScheduler, getDoseReminderSlots } from '@/hooks/useDoseReminderScheduler';
import {
  doseReminderAlarmIdForDose } from '@/utils/notifications';
import { Capacitor } from '@capacitor/core';
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

vi.mock('@/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/utils/notifications')>(
    '@/utils/notifications'
  );
  return {
    ...actual,
    scheduleDoseReminder: mocks.schedule,
    cancelDoseReminder: mocks.cancel,
    cancelSnoozedDoseReminder: mocks.cancelSnoozed,
    isDoseReminderPending: mocks.isPending,
    isNativeDoseReminderReArmed: mocks.isNativeReArmed,
    // cancelStaleDoseReminderAlarms: NOT mocked — real implementation runs
    // so the test can verify actual IDs sent to LocalNotifications.cancel.
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

async function flushUntil(predicate: () => boolean, maxIterations = 20): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
}


describe('useDoseReminderScheduler — native state lookup failures', () => {
  it('retries a pending-state lookup failure without scheduling before the retry', async () => {
    const med = makeMed({ id: 'med-pending-failure', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ lifecycleTick }: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], lifecycleTick })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    mocks.schedule.mockClear();
    mocks.isPending.mockResolvedValueOnce({
      ok: false,
      error: 'pending_lookup_failed',
      errorCode: 'platform_failure',
    });
    mocks.isPending.mockResolvedValue({
      ok: true,
      pending: true,
    });

    rerender({ lifecycleTick: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('retries a re-arm lookup failure without requiring a medication edit', async () => {
    const med = makeMed({ id: 'med-rearm-failure', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ lifecycleTick }: { lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med], lifecycleTick })
        ),
      { initialProps: { lifecycleTick: 0 } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();

    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValueOnce({
      ok: false,
      error: 'rearm_lookup_failed',
      errorCode: 'platform_failure',
    });
    mocks.isNativeReArmed.mockResolvedValue({
      ok: true,
      scheduled: true,
    });

    rerender({ lifecycleTick: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

describe('useDoseReminderScheduler — cancellation', () => {
  it('cancels the alarm when a med is removed from the list', async () => {
    const med = makeMed({ id: 'med-del', reminderTime: '09:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    rerender({ medications: [] });
    await flushUntil(() => mocks.cancel.mock.calls.some((c) => c[0] === 'med-del'));

    expect(mocks.cancel).toHaveBeenCalledWith('med-del', 'd1');
  });

  it('cancels all alarms when notificationsEnabled is turned off', async () => {
    const med1 = makeMed({ id: 'med-off1', reminderTime: '09:00' });
    const med2 = makeMed({ id: 'med-off2', reminderTime: '10:00' });
    const { rerender } = renderHook(
      ({ notificationsEnabled }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [med1, med2], notificationsEnabled })
        ),
      { initialProps: { notificationsEnabled: true } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    rerender({ notificationsEnabled: false });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);

    expect(mocks.cancel).toHaveBeenCalledWith('med-off1', 'd1');
    expect(mocks.cancel).toHaveBeenCalledWith('med-off2', 'd1');
  });
});

describe('useDoseReminderScheduler — operation retries', () => {
  it('retries a transient schedule failure without a medication edit', async () => {
    const initial = makeMed({
      id: 'med-schedule-retry',
      reminderTime: '20:00',
    });
    const { rerender } = renderHook(
      ({ medication }: { medication: Medication }) =>
        useDoseReminderScheduler(
          defaultOpts({ medications: [medication] })
        ),
      { initialProps: { medication: initial } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    mocks.schedule.mockClear();

    mocks.schedule.mockRejectedValueOnce(new Error('transient schedule failure'));
    mocks.schedule.mockResolvedValue(undefined);
    const replacement = {
      ...initial,
      reminderTime: '21:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '21:00' }],
    };
    rerender({ medication: replacement });

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
  });

  it('retries a transient cancellation failure and keeps the removal discoverable', async () => {
    const med = makeMed({ id: 'med-cancel-retry', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }: { medications: Medication[] }) =>
        useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    mocks.cancel.mockClear();
    mocks.cancel.mockRejectedValueOnce(new Error('transient cancel failure'));
    mocks.cancel.mockResolvedValue(undefined);

    rerender({ medications: [] });
    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
  });
});

describe('stale native pending cleanup', () => {
  it('cancels stale dose alarms from native pending on reconcile', async () => {
    // Use native platform so cancelStaleDoseReminderAlarms exercises the
    // real getPending + cancel path (not just a spy).
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android');

    const med = makeMed({
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
      dosesPerDay: 1,
    });

    const currentId = doseReminderAlarmIdForDose(med.id, 'd1');
    const staleDoseId = doseReminderAlarmIdForDose('med-stale', 'd-old');
    if (currentId === null || staleDoseId === null) {
      throw new Error('Expected valid notification ids for non-empty dose ids');
    }
    const nonDoseAlarmId = 999_999_999; // outside doseAlarm band

    // Mock getPending to contain current + stale dose-specific + non-doseAlarm IDs.
    // (title/body are required by PendingLocalNotificationSchema but unused by
    // the stale-cleanup logic which only inspects `id`.)
    vi.mocked(LocalNotifications.getPending).mockResolvedValue({
      notifications: [
        { id: currentId, title: '', body: '' },
        { id: staleDoseId, title: '', body: '' },
        { id: nonDoseAlarmId, title: '', body: '' },
      ],
    });

    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med] }))
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    // Verify actual IDs sent to cancel: stale cancelled,
    // current + non-doseAlarm NOT cancelled.
    expect(LocalNotifications.cancel).toHaveBeenCalled();
    const cancelledIds = vi.mocked(LocalNotifications.cancel).mock.calls.flatMap(
      (call: unknown[]) =>
        (call[0] as { notifications: { id: number }[] }).notifications.map(
          (n) => n.id
        )
    );
    expect(cancelledIds).toContain(staleDoseId);
    expect(cancelledIds).not.toContain(currentId);
    expect(cancelledIds).not.toContain(nonDoseAlarmId);
  });
});

describe('delivery/reconciliation race', () => {
  it('repairs when pending=false and no native re-arm evidence (case C)', async () => {
    // Truly missing alarm: neither getPending nor shared ExactAlarmRuntime.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

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
    expect(mocks.schedule).toHaveBeenCalled();
    const firstCalls = mocks.schedule.mock.calls.length;
    mocks.schedule.mockClear();

    // Still missing — repair again on lifecycle (same signature path).
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(firstCalls).toBeGreaterThanOrEqual(1);
  });


  it('post-delivery, no-open/no-action state (observable equivalent of shade dismiss): pending=false + D+1 evidence → zero schedule for D', async () => {
    // State transition (not a literal shade swipe):
    //   D delivered by DoseReminderAlarmReceiver.onReceive
    //   → native arms exactly one successor D+1 for same medicationId+doseId+reminderTime
    //   → localNotificationActionPerformed / Take / Snooze / open never ran
    //   → tray entry may leave getPending(); pending becomes false for "current" view
    //   → shared ExactAlarmRuntime still reports valid re-arm for this occurrence identity
    // Reconciliation must not scheduleDoseReminder for same-day D.
    const medicationId = 'med-1';
    const doseId = 'd1';
    const reminderTime = '09:00';
    // Occurrence identity used by isNativeDoseReminderReArmed (must match slot).
    const successorEvidence = {
      medicationId,
      doseId,
      reminderTime,
      // D+1 future successor — not same calendar day as delivered D.
      nextOccurrenceKind: 'D+1' as const,
    };

    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockImplementation(
      async (medId: string, dId: string, time?: string) => {
        // Only valid when identity matches the delivered dose's successor evidence.
        return (
          medId === successorEvidence.medicationId &&
          dId === successorEvidence.doseId &&
          time === successorEvidence.reminderTime &&
          successorEvidence.nextOccurrenceKind === 'D+1'
        );
      }
    );

    const med = makeMed({
      id: medicationId,
      reminderTime,
      doseSchedule: [{ id: doseId, amount: 1, time: reminderTime }],
    });

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
    mocks.isPending.mockClear();
    mocks.isNativeReArmed.mockClear();

    // Post-delivery reconciliation: signature unchanged, pending false, D+1 evidence valid.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.isPending).toHaveBeenCalledWith(medicationId, doseId);
    expect(mocks.isNativeReArmed).toHaveBeenCalledWith(
      medicationId,
      doseId,
      reminderTime
    );
    // Zero new schedule for occurrence D (and no cancel of D+1 successor).
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('no-op when pending=false but native re-arm state is valid (case B — real delivery race)', async () => {
    // Delivery transition: getPending may still report false while
    // DoseReminderAlarmReceiver has already written shared ExactAlarmRuntime
    // after successful AlarmManager next-day arm. JS must not schedule a second path.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

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
    expect(mocks.schedule).toHaveBeenCalled();
    mocks.schedule.mockClear();

    // pending still false, but native re-arm evidence present → no-op.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: true });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('no-op when pending=true (case A)', async () => {
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

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

    mocks.isPending.mockResolvedValue({ ok: true, pending: true });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('repairs when native re-arm state is expired/invalid (case D)', async () => {
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '23:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '23:00' }],
    });

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

    // isNativeDoseReminderReArmed already encodes validity (expired/config mismatch → false).
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('repairs when evidence is stale for a different schedule identity (config mismatch)', async () => {
    // Store may still hold a future nextOccurrenceMs from an old reminderTime;
    // isNativeDoseReminderReArmed(med, dose, currentTime) must return false.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med = makeMed({
      reminderTime: '10:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '10:00' }],
    });

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

    // Signature unchanged but native evidence invalid for current config → repair.
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    rerender({ lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(1);
    // isNativeDoseReminderReArmed must be consulted with current slot time.
    expect(mocks.isNativeReArmed).toHaveBeenCalledWith('med-1', 'd1', '10:00');
  });

  it('time/signature change cancels (clears re-arm evidence) then schedules replacement', async () => {
    mocks.isPending.mockResolvedValue({ ok: true, pending: false });
    mocks.isNativeReArmed.mockResolvedValue({ ok: true, scheduled: false });
    const med1 = makeMed({
      reminderTime: '09:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '09:00' }],
    });

    const { rerender } = renderHook(
      (props: { med: ReturnType<typeof makeMed>; lifecycleTick: number }) =>
        useDoseReminderScheduler(
          defaultOpts({
            medications: [props.med],
            lifecycleTick: props.lifecycleTick,
          })
        ),
      { initialProps: { med: med1, lifecycleTick: 0 } }
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalled();
    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    const med2 = makeMed({
      reminderTime: '11:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '11:00' }],
    });
    // Signature change path: cancel first (clears native evidence) then one schedule.
    rerender({ med: med2, lifecycleTick: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith('med-1', 'd1');
    expect(mocks.schedule).toHaveBeenCalled();
  });
});
