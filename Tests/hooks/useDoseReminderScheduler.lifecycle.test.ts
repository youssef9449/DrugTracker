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


describe('useDoseReminderScheduler — consumption suppression (today\u2019s dose taken)', () => {
  const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

  it('Test 1 — consumed today BEFORE the reminder time: cold start suppresses today\u2019s reminder and re-arms from tomorrow', async () => {
    // reminder 20:00, now 12:00, dose already consumed today.
    const med = makeMed({
      id: 'med-consumed',
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() =>
      mocks.schedule.mock.calls.some((c) => c[0] === 'med-consumed')
    );

    // The recurring alarm was cancelled (today's occurrence suppressed)…
    expect(mocks.cancel).toHaveBeenCalledWith('med-consumed', 'd1');
    // …and re-armed as the SAME recurring daily schedule starting
    // TOMORROW (skipToday) — tomorrow's reminder remains scheduled.
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-consumed',
      'Test Med',
      '20:00',
      1,
      '\u0642\u0631\u0635',
      'd1',
      { skipToday: true }
    );
    // Any pending snoozed one-shot for the taken dose was cancelled.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-consumed', 'd1');
  });

  it('Test 1b — live manual consumption while the app is running: suppression fires on the consumedSignature change', async () => {
    // Dose NOT taken at mount — normal schedule.
    const med = makeMed({
      id: 'med-live',
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule.mock.calls[0][0]).toBe('med-live');
    expect(mocks.schedule.mock.calls[0].length).toBeGreaterThanOrEqual(6); // includes doseId
    const schedulesBefore = mocks.schedule.mock.calls.length;

    // User manually takes the dose at 12:00 (before the 20:00 reminder):
    // Per-dose consume marker → consumedSignature change.
    const medConsumed = {
      ...med,
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    };
    rerender({ medications: [medConsumed] });

    await flushUntil(() =>
      mocks.schedule.mock.calls.length > schedulesBefore ||
      mocks.cancel.mock.calls.some((c) => c[0] === 'med-live')
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.length > schedulesBefore
    );

    // Today's pending recurring occurrence was cancelled…
    expect(mocks.cancel).toHaveBeenCalledWith('med-live', 'd1');
    // …and the recurring alarm re-armed from tomorrow (skipToday).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-live',
      'Test Med',
      '20:00',
      1,
      'قرص',
      'd1',
      { skipToday: true }
    );
    // Pending snoozed reminder for the taken dose cancelled too.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-live', 'd1');
  });

  it('Test 2 — suppression re-arm is the recurring daily schedule (tomorrow covered at unit level)', async () => {
    // The hook passes { skipToday: true } to scheduleDoseReminder; the
    // notifications-level tests prove skipToday schedules the next fire
    // at TOMORROW HH:MM with repeats:true + every:'day' and the same
    // stable id (notifications.dose.test.ts). Here we assert the hook
    // really hands that option through for a consumed med.
    const med = makeMed({
      id: 'med-tomorrow',
      reminderTime: '20:00',
      doseSchedule: [{ id: 'd1', amount: 1, time: '20:00' }],
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-tomorrow' && c[6]?.skipToday === true
      )
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-tomorrow', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
  });

  it('Test 3 — consumed today AFTER the reminder already fired: no undo of the fired notification, snooze cleanup only', async () => {
    // now = 21:00, reminder 20:00 already fired, dose consumed at 21:00.
    vi.setSystemTime(new Date('2024-09-10T21:00:00Z'));
    const med = makeMed({
      id: 'med-after',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    // Let all chained ops settle.
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 20));

    // The fired reminder is NOT retracted and tomorrow is NOT touched:
    // no (re)schedule for this med at all.
    expect(mocks.schedule).not.toHaveBeenCalledWith(
      'med-after', 'Test Med', '20:00', 1, '\u0642\u0631\u0635'
    );
    expect(mocks.schedule).not.toHaveBeenCalledWith(
      'med-after', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
    // A pending snoozed one-shot (e.g. a 90-min snooze from the 20:00
    // fire) is still cancelled — a snoozed reminder for a taken dose
    // must never fire.
    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-after', 'd1');
  });

  it('Test 4/5 — app resume after a manual dose re-applies the suppression (reconciliation)', async () => {
    const med = makeMed({
      id: 'med-resume',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    const { rerender } = renderHook(
      ({ resumeTick }) =>
        useDoseReminderScheduler(defaultOpts({ medications: [med], resumeTick })),
      { initialProps: { resumeTick: 0 } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-resume' && c[6]?.skipToday === true
      )
    );
    const cancelsBefore = mocks.cancel.mock.calls.filter((c) => c[0] === 'med-resume').length;
    const schedulesBefore = mocks.schedule.mock.calls.length;

    // Resume (appStateChange) → resumeTick bump → suppression effect
    // re-runs and re-applies (idempotent): cancel + skipToday re-arm.
    rerender({ resumeTick: 1 });
    await flushUntil(() => mocks.schedule.mock.calls.length > schedulesBefore);

    expect(mocks.cancel).toHaveBeenCalledWith('med-resume', 'd1');
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-resume', 'Test Med', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
    expect(
      mocks.cancel.mock.calls.filter((c) => c[0] === 'med-resume').length
    ).toBeGreaterThan(cancelsBefore);
  });

  it('Test 6 — a live consumption clears the persisted snooze marker and cancels the pending snoozed one-shot', async () => {
    const med = makeMed({ id: 'med-snooze-consumed', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Simulate a pending snooze (marker + the native one-shot exists).
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({ 'med-snooze-consumed': Date.now() + 10 * 60_000 })
    );

    // User takes the dose manually → suppression must cancel/suppress
    // the pending snoozed reminder for today.
    rerender({ medications: [{ ...med, doseConsumptionHistory: { d1: [getTodayDateString()] } }] });
    await flushUntil(() => mocks.cancelSnoozed.mock.calls.length >= 1);

    expect(mocks.cancelSnoozed).toHaveBeenCalledWith('med-snooze-consumed', 'd1');
    const snooze = JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}') as Record<string, number>;
    expect(snooze['med-snooze-consumed']).toBeUndefined();
  });

  it('Test 7 — dose NOT taken: the reminder still fires normally (no suppression, 5-arg schedule)', async () => {
    const med = makeMed({ id: 'med-taken-no', reminderTime: '20:00' });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-taken-no', 'Test Med', '20:00', 1, '\u0642\u0631\u0635'
    );
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });

  it('Test 8 — YESTERDAY\u2019s lastConsumedDate: today\u2019s reminder still fires normally', async () => {
    const med = makeMed({
      id: 'med-yesterday',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: ['2024-09-09'] }, // yesterday (today = 2024-09-10)
    });
    renderHook(() => useDoseReminderScheduler(defaultOpts({ medications: [med] })));

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Normal schedule — today's occurrence NOT skipped (the logic is
    // based on the CURRENT calendar day, not on lastConsumedDate
    // merely having a value).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-yesterday', 'Test Med', '20:00', 1, '\u0642\u0631\u0635'
    );
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });

  it('Test 10 — a pure stock change (currentPills/elapsed-day settlement) without consumption does NOT suppress or reschedule', async () => {
    const med = makeMed({ id: 'med-stock2', reminderTime: '09:00', currentPills: 30 });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const schedulesBefore = mocks.schedule.mock.calls.length;

    rerender({ medications: [{ ...med, currentPills: 29}] });
    await new Promise((r) => setTimeout(r, 30));

    expect(mocks.schedule.mock.calls.length).toBe(schedulesBefore);
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });

  it('Test 11 — consumption while a config reschedule is in flight: ops serialize on the per-med chain, final state is skipToday (no duplicate/race)', async () => {
    const med = makeMed({ id: 'med-race', reminderTime: '20:00' });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    const schedulesBeforeRerenders = mocks.schedule.mock.calls.length;

    // Hold the chain: the FIRST cancel call gates the ops behind it.
    const gateHolder: { release: () => void } = { release: () => void 0 };
    const gate = new Promise<void>((resolve) => (gateHolder.release = resolve));
    mocks.cancel.mockImplementationOnce(() => gate);

    // Config change (main effect re-runs → cancel+schedule enqueued)…
    rerender({ medications: [{ ...med, name: 'Renamed Med' }] });
    // …immediately followed by the consumption (suppression effect).
    rerender({ medications: [{ ...med, name: 'Renamed Med', doseConsumptionHistory: { d1: [getTodayDateString()] } }] });

    // Release the gate; let everything settle.
    gateHolder.release();
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-race' && c[6]?.skipToday === true
      )
    );
    await new Promise((r) => setTimeout(r, 20));

    // After the rerenders, EXACTLY ONE schedule happened for this med —
    // the suppression's skipToday re-arm. The stale config-change op
    // (superseded by the suppression's generation bump) scheduled
    // nothing, and no un-suppressed follow-up exists.
    const postRerenderSchedules = mocks.schedule.mock.calls
      .slice(schedulesBeforeRerenders)
      .filter((c) => c[0] === 'med-race');
    expect(postRerenderSchedules).toHaveLength(1);
    expect(postRerenderSchedules[0][1]).toBe('Renamed Med');
    expect(postRerenderSchedules[0][6]).toEqual({ skipToday: true });
  });

  it('Test 11b — reminder-config change AFTER a consumption cannot resurrect today\u2019s reminder (skipToday baked into every reschedule)', async () => {
    // Consumed at 12:00 → suppressed. At 14:00 the user renames the med
    // → the main effect re-runs → its schedule MUST still skip today.
    const med = makeMed({
      id: 'med-rename',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    const { rerender } = renderHook(
      ({ medications }) => useDoseReminderScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med] } }
    );
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-rename' && c[6]?.skipToday === true
      )
    );

    rerender({ medications: [{ ...med, name: 'Renamed' }] });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) => c[0] === 'med-rename' && c[1] === 'Renamed'
      )
    );

    // The rename reschedule also skips today (consumed day).
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-rename', 'Renamed', '20:00', 1, '\u0642\u0631\u0635', 'd1', { skipToday: true }
    );
  });

  it('suppression is gated when notifications are disabled (the main cancel-all owns that path)', () => {
    const med = makeMed({
      id: 'med-gated',
      reminderTime: '20:00',
      doseConsumptionHistory: { d1: [getTodayDateString()] },
    });
    renderHook(() =>
      useDoseReminderScheduler(defaultOpts({ medications: [med], notificationsEnabled: false }))
    );

    // No suppression scheduling for the consumed med while disabled.
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancelSnoozed).not.toHaveBeenCalled();
  });
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

  it('Test E — second reconciliation after restore keeps one logical notification identity', async () => {
    // Lifecycle:
    //   consumed → skipToday suppression
    //   → restore while 20:00 still ahead → re-arm without skipToday
    //   → resumeTick 0→1 forces a second real reconciliation
    //
    // Observable contract at the scheduleDoseReminder / cancelDoseReminder
    // boundary (mocks do not hit Capacitor): every op for this dose uses
    // medId=med-idem + doseId=d2, which the production helper
    // doseReminderAlarmIdForDose maps to one stable numeric notification id.
    // Cancel→schedule pairs are reconciliation ops, not extra identities.
    vi.setSystemTime(new Date('2024-09-10T17:00:00'));
    const today = getTodayDateString();
    const medId = 'med-idem';
    const doseId = 'd2';
    const doseTime = '20:00';

    // Production identity: same medId+doseId → same notification id always.
    const logicalNotifId = doseReminderAlarmIdForDose(medId, doseId);
    expect(doseReminderAlarmIdForDose(medId, doseId)).toBe(logicalNotifId);
    // Distinct from a different dose slot on the same med (no identity leak).
    expect(doseReminderAlarmIdForDose(medId, 'd1')).not.toBe(logicalNotifId);

    const base = makeMed({
      id: medId,
      name: 'IdemMed',
      reminderEnabled: true,
      doseSchedule: [{ id: doseId, amount: 1, time: doseTime }],
      dosesPerDay: 1,
      doseConsumptionHistory: { [doseId]: [today] },
    });

    const { rerender } = renderHook(
      ({ medications, resumeTick }) =>
        useDoseReminderScheduler(defaultOpts({ medications, resumeTick })),
      { initialProps: { medications: [base], resumeTick: 0 } }
    );

    // 1) Consumed → skipToday suppression exists
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) =>
          c[0] === medId &&
          c[5]?.doseId === doseId &&
          c[6]?.skipToday === true
      )
    );
    const suppressCall = mocks.schedule.mock.calls.find(
      (c) =>
        c[0] === medId &&
        c[5]?.doseId === doseId &&
        c[6]?.skipToday === true
    );
    expect(suppressCall).toBeDefined();
    expect(suppressCall?.[2]).toBe(doseTime);
    // Suppress path targets the same logical id as any other d2 schedule.
    expect(doseReminderAlarmIdForDose(suppressCall![0], suppressCall![5].doseId)).toBe(
      logicalNotifId
    );

    // 2) Restore while future → re-arm without skipToday
    const restored = {
      ...base,
      doseConsumptionHistory: {},
    };
    rerender({ medications: [restored], resumeTick: 0 });
    await flushUntil(() =>
      mocks.schedule.mock.calls.some(
        (c) =>
          c[0] === medId &&
          c[5]?.doseId === doseId &&
          c[6]?.skipToday !== true
      )
    );

    const rearmCalls = mocks.schedule.mock.calls.filter(
      (c) =>
        c[0] === medId &&
        c[5]?.doseId === doseId &&
        c[6]?.skipToday !== true
    );
    expect(rearmCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of rearmCalls) {
      expect(c[2]).toBe(doseTime);
      expect(c[5]?.doseId).toBe(doseId);
      expect(c[6]?.skipToday).toBeUndefined();
      // Restore re-arm resolves to the SAME logical notification id as suppress.
      expect(doseReminderAlarmIdForDose(c[0], c[5].doseId)).toBe(logicalNotifId);
    }

    // Every cancel for this med in the lifecycle targets doseId d2 (same id).
    for (const c of mocks.cancel.mock.calls) {
      if (c[0] === medId) {
        expect(c[1]).toBe(doseId);
        expect(doseReminderAlarmIdForDose(c[0], c[1])).toBe(logicalNotifId);
      }
    }

    // No schedule ever used a different doseId for this med in this test.
    expect(
      mocks.schedule.mock.calls.some(
        (c) => c[0] === medId && c[5]?.doseId != null && c[5].doseId !== doseId
      )
    ).toBe(false);

    const schedulesAfterRestore = mocks.schedule.mock.calls.length;
    const cancelsAfterRestore = mocks.cancel.mock.calls.length;

    // 3) Second real reconciliation via resumeTick
    rerender({ medications: [restored], resumeTick: 1 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));

    const postSecondSchedules = mocks.schedule.mock.calls.slice(schedulesAfterRestore);
    const postSecondCancels = mocks.cancel.mock.calls.slice(cancelsAfterRestore);

    // No skipToday regression after second reconciliation.
    expect(
      postSecondSchedules.some(
        (c) =>
          c[0] === medId &&
          c[5]?.doseId === doseId &&
          c[6]?.skipToday === true
      )
    ).toBe(false);

    // Any further ops still use the same medId + doseId → same logical id.
    // (Extra cancel→schedule pairs would still be the same identity, not a
    // second notification id; we do not treat op count as notification count.)
    for (const c of postSecondSchedules) {
      if (c[0] === medId) {
        expect(c[5]?.doseId).toBe(doseId);
        expect(c[2]).toBe(doseTime);
        expect(c[6]?.skipToday).toBeUndefined();
        expect(doseReminderAlarmIdForDose(c[0], c[5].doseId)).toBe(logicalNotifId);
      }
    }
    for (const c of postSecondCancels) {
      if (c[0] === medId) {
        expect(c[1]).toBe(doseId);
        expect(doseReminderAlarmIdForDose(c[0], c[1])).toBe(logicalNotifId);
      }
    }

    // Final schedule for this dose: without skipToday, same identity.
    const lastD2 = [...mocks.schedule.mock.calls]
      .reverse()
      .find((c) => c[0] === medId && c[5]?.doseId === doseId);
    expect(lastD2).toBeDefined();
    expect(lastD2?.[6]?.skipToday).toBeUndefined();
    expect(lastD2?.[5]?.doseId).toBe(doseId);
    expect(lastD2?.[2]).toBe(doseTime);
    expect(doseReminderAlarmIdForDose(lastD2![0], lastD2![5].doseId)).toBe(
      logicalNotifId
    );
  });
});

describe('idempotent lifecycle reconciliation', () => {
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
    expect(mocks.schedule.mock.calls[0][6]?.doseDescription).toBe('بعد الإفطار');

    mocks.schedule.mockClear();
    mocks.cancel.mockClear();

    const updated = {
      ...med,
      doseSchedule: [
        {
          ...med.doseSchedule![0],
          description: 'قبل النوم',
        },
      ],
    };
    rerender({ medication: updated });

    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    const last = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    expect(last[6]?.doseDescription).toBe('قبل النوم');
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

    expect(mocks.schedule.mock.calls[0][6]?.doseDescription).toBeUndefined();
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
      (c) => c[5]?.allowManualTakeAction === false
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
      (c) => c[5]?.allowManualTakeAction === true
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
      (c) => c[5]?.allowManualTakeAction === true
    )).toBe(true);
  });
});
