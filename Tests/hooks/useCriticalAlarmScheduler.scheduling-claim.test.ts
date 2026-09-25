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

describe('useCriticalAlarmScheduler — shared exact-alarm permission gate', () => {
  it('does not create a future Critical alarm while exact permission is denied', async () => {
    platformMock.mockReturnValue('android');
    const med = makeMed();

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({
        medications: [med],
        exactAlarmPermission: 'denied',
      }),
    });
    await flush();

    expect(scheduleMock).not.toHaveBeenCalled();
  });
});
describe('useCriticalAlarmScheduler — scheduling and the persistent claim', () => {
  it('schedules one alarm for a sufficient med with a future crossing and persists the claim ONLY after success', async () => {
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString());
    expect(expectedT).not.toBeNull();

    const gate = deferred<Awaited<ReturnType<typeof scheduleCriticalAlarm>>>();
    scheduleMock.mockReturnValueOnce(gate.promise);

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });

    // Not yet resolved → no claim persisted yet.
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', expectedT, 'قرص');
    expect(readClaims()['med-1']).toBeUndefined();

    gate.resolve({ ok: true });
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('re-arms (and updates the claim) when the projected date moves', async () => {
    const medA = makeMed({ currentPills: 30 });
    const t1 = getCriticalAlarmDate(medA, getTodayDateString()) as number;
    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t1 });

    // Refill moves the projection.
    const medB = makeMed({ currentPills: 60 });
    const t2 = getCriticalAlarmDate(medB, getTodayDateString()) as number;
    expect(t2).not.toBe(t1);
    rerender(defaultOpts({ medications: [medB] }));
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock).toHaveBeenLastCalledWith('med-1', 'Test Med', t2, 'قرص');
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t2 });
  });

  it('failed scheduling leaves the claim open (foreground fallback stays available)', async () => {
    scheduleMock.mockResolvedValue({ ok: false, error: 'schedule_failed', errorCode: 'platform_failure' });
    const med = makeMed();

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
  });

  it('failed scheduling (rejected promise) also leaves the claim open', async () => {
    scheduleMock.mockRejectedValueOnce(new Error('bridge down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const med = makeMed();

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    warnSpy.mockRestore();
  });
});
