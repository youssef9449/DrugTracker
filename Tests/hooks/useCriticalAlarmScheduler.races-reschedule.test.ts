/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { getTodayDateString, getCriticalAlarmDate } from '@/utils/dateCalculations';
import { useCriticalAlarmScheduler, type UseCriticalAlarmSchedulerOptions } from '@/hooks/useCriticalAlarmScheduler';

// Mutable platform mock so tests can switch between the web and the
// native (android) code paths.
const platformMock = vi.hoisted(() => vi.fn(() => 'web'));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: platformMock },
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

// Mutable mocks so tests can control Promise resolution for the
// stale-async race tests. vi.hoisted is required because vi.mock
// factories are hoisted above any const declarations.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  verify: vi.fn(),
  list: vi.fn(),
}));

// The hook imports the production source modules directly, so the mocks
// must be installed on those module ids (mocking the test facade would
// not intercept production calls).
vi.mock('@/utils/criticalAlarmScheduling', () => ({
  scheduleCriticalAlarm: mocks.schedule,
  cancelCriticalAlarm: mocks.cancel,
  verifyCriticalAlarmPending: mocks.verify,
}));
vi.mock('@/utils/criticalAlarmNative', () => ({
  listScheduledCriticalMedicationIdsNative: mocks.list,
}));

import { scheduleCriticalAlarm, cancelCriticalAlarm } from '@/utils/criticalAlarmScheduling';
import { readCriticalClaims as readClaims } from '../helpers/criticalStockClaims';

const scheduleMock = vi.mocked(scheduleCriticalAlarm);
const cancelMock = vi.mocked(cancelCriticalAlarm);
const verifyMock = mocks.verify;

function makeMed(overrides: Partial<Medication> = {}): Medication {
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
    autoDeductEnabled: true,
    // The unified critical-stock policy requires the per-medication flag
    // to be explicitly ON before any scheduling decision.
    criticalStockAlertsEnabled: true,
    // Explicit schedule required for getCriticalAlarmDate projection.
    doseSchedule: [{ id: 'd1', amount: dailyDose, time: '20:00' }],
    ...overrides,
  };
}

function defaultOpts(
  overrides: Partial<UseCriticalAlarmSchedulerOptions> = {}
): UseCriticalAlarmSchedulerOptions {
  return {
    medications: [],
    criticalStockAlertsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    exactAlarmPermission: 'unsupported',
    ...overrides,
  };
}

/** A deferred promise the test resolves manually. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain pending microtasks (the per-med operation queue). */
const flush = async (): Promise<void> => {
  // Only Date is faked — setTimeout is real, and one macrotask turn
  // drains every pending microtask in the chain.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // Wave 13 #123: pin system time so getTodayDateString() resolves to a
  // deterministic date. Only Date is faked so microtask chains and the
  // per-med operation queue keep working.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  platformMock.mockReturnValue('web');
  scheduleMock.mockReset();
  scheduleMock.mockResolvedValue({ ok: true });
  cancelMock.mockReset();
  cancelMock.mockResolvedValue({ ok: true });
  // Default: verification finds nothing (web semantics — there is no
  // native alarm on web). Native tests override this per case.
  verifyMock.mockReset();
  verifyMock.mockResolvedValue({ ok: true, pending: false });
  // Native durable schedule listing: nothing armed in a fresh test run.
  mocks.list.mockReset();
  mocks.list.mockResolvedValue({ ok: true, ids: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCriticalAlarmScheduler — stale-async safety', () => {
  it('a newer run supersedes an in-flight schedule: the stale alarm is cancelled and only the newer claim survives', async () => {
    const medA = makeMed({ currentPills: 30 });

    // Gate the first schedule so it is still pending when the newer run starts.
    const gate = deferred<Awaited<ReturnType<typeof scheduleCriticalAlarm>>>();
    scheduleMock.mockReturnValueOnce(gate.promise);
    scheduleMock.mockResolvedValueOnce({ ok: true });

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    // Newer run with a changed projection, while run 1's schedule is pending.
    const medB = makeMed({ currentPills: 40 });
    const t2 = getCriticalAlarmDate(medB, getTodayDateString()) as number;
    rerender(defaultOpts({ medications: [medB] }));

    // Run 1's schedule now resolves successfully — but it is stale.
    gate.resolve({ ok: true });
    await flush();

    // Run 1 compensated by cancelling the alarm it armed; run 2 re-armed
    // at the new projection and persisted the newer claim.
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t2 });
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock).toHaveBeenLastCalledWith('med-1', 'Test Med', t2, 'قرص');
  });

  it('a medication that crosses while its schedule is in flight aborts the claim write and cancels the just-armed alarm', async () => {
    const medA = makeMed({ currentPills: 30 });

    const gate = deferred<Awaited<ReturnType<typeof scheduleCriticalAlarm>>>();
    scheduleMock.mockReturnValueOnce(gate.promise);

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    // The med crosses (manual consumption) while the schedule is pending.
    rerender(
      defaultOpts({
        medications: [makeMed({ currentPills: 3, warningThresholdDays: 5 })],
      })
    );

    // The in-flight schedule resolves now — stale: the foreground owns
    // the active episode, so the scheduler must cancel its own alarm
    // and write nothing.
    gate.resolve({ ok: true });
    await flush();

    // cancel called for the pre-schedule cancel AND the compensation.
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(readClaims()['med-1']).toBeUndefined();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it('a medication deleted while its schedule is in flight leaves no claim', async () => {
    const medA = makeMed({ currentPills: 30 });
    const gate = deferred<Awaited<ReturnType<typeof scheduleCriticalAlarm>>>();
    scheduleMock.mockReturnValueOnce(gate.promise);

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    rerender(defaultOpts({ medications: [] }));
    gate.resolve({ ok: true });
    await flush();

    expect(readClaims()['med-1']).toBeUndefined();
  });
});
describe('useCriticalAlarmScheduler — exact-time input reschedule', () => {
  it('reschedules when only dose time changes', async () => {
    const medT1 = makeMed({
      currentPills: 100,
      dailyDose: 10,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    const t1 = getCriticalAlarmDate(medT1, getTodayDateString());
    expect(t1).not.toBeNull();

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medT1] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', t1, 'قرص');
    scheduleMock.mockClear();
    cancelMock.mockClear();

    const medT2 = makeMed({
      currentPills: 100,
      dailyDose: 10,
      doseSchedule: [{ id: 'd1', amount: 10, time: '21:30' }],
    });
    const t2 = getCriticalAlarmDate(medT2, getTodayDateString());
    expect(t2).not.toBeNull();
    expect(t2).not.toBe(t1);

    rerender(defaultOpts({ medications: [medT2] }));
    await flush();
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', t2, 'قرص');
  });

  it('reschedules when dose amounts are redistributed (same daily total)', async () => {
    const medA = makeMed({
      currentPills: 40,
      dailyDose: 15,
      warningThresholdDays: 1,
      doseSchedule: [
        { id: 'd1', amount: 10, time: '18:00' },
        { id: 'd2', amount: 5, time: '22:00' },
      ],
    });
    const tA = getCriticalAlarmDate(medA, getTodayDateString());
    expect(tA).not.toBeNull();

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    scheduleMock.mockClear();
    cancelMock.mockClear();

    // Swap amounts so the crossing slot moves earlier in the day (still
    // daily 15): the evening-heavy schedule first crosses at 22:00, the
    // morning-heavy one already at 18:00.
    const medB = makeMed({
      currentPills: 40,
      dailyDose: 15,
      warningThresholdDays: 1,
      doseSchedule: [
        { id: 'd1', amount: 14, time: '18:00' },
        { id: 'd2', amount: 1, time: '22:00' },
      ],
    });
    const tB = getCriticalAlarmDate(medB, getTodayDateString());
    expect(tB).not.toBeNull();
    expect(tB).not.toBe(tA);

    rerender(defaultOpts({ medications: [medB] }));
    await flush();
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', tB, 'قرص');
  });

  it('reschedules when dose consumption history changes the crossing', async () => {
    const base = makeMed({
      currentPills: 65,
      dailyDose: 10,
      warningThresholdDays: 5,
      doseSchedule: [{ id: 'd1', amount: 10, time: '20:00' }],
    });
    // Without history, today 20:00 crosses (65→55, daysLeft floor 5).
    const t0 = getCriticalAlarmDate(base, getTodayDateString());
    expect(t0).not.toBeNull();

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [base] }),
    });
    await flush();
    scheduleMock.mockClear();
    cancelMock.mockClear();

    // Mark today consumed: projection skips that occurrence → later day.
    const withConsumed = {
      ...base,
      doseConsumptionHistory: { d1: ['2024-09-10'] },
    };
    const t1 = getCriticalAlarmDate(withConsumed, getTodayDateString());
    expect(t1).not.toBeNull();
    expect(t1).not.toBe(t0);

    rerender(defaultOpts({ medications: [withConsumed] }));
    await flush();
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', t1, 'قرص');
  });

  it('does not churn alarms when only medication array order changes', async () => {
    const a = makeMed({ id: 'med-a', currentPills: 100, dailyDose: 10 });
    const b = makeMed({ id: 'med-b', currentPills: 80, dailyDose: 10 });
    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [a, b] }),
    });
    await flush();
    const scheduleCount = scheduleMock.mock.calls.length;
    scheduleMock.mockClear();
    cancelMock.mockClear();

    rerender(defaultOpts({ medications: [b, a] }));
    await flush();
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    // claims unchanged
    expect(Object.keys(readClaims()).sort()).toEqual(['med-a', 'med-b']);
    void scheduleCount;
  });
});
