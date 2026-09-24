/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '@/types';
import { getTodayDateString, getCriticalAlarmDate } from '@/utils/dateCalculations';
import {
  useCriticalAlarmScheduler,
  type UseCriticalAlarmSchedulerOptions } from '@/hooks/useCriticalAlarmScheduler';

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
}));

vi.mock('../utils/notificationTestFacade', async () => {
  const actual = await vi.importActual<typeof import('../utils/notificationTestFacade')>(
    '../utils/notificationTestFacade'
  );
  return {
    ...actual,
    scheduleCriticalAlarm: mocks.schedule,
    cancelCriticalAlarm: mocks.cancel,
    verifyCriticalAlarmPending: mocks.verify,
  };
});

import { scheduleCriticalAlarm, cancelCriticalAlarm, verifyCriticalAlarmPending } from '../utils/notificationTestFacade';
import { readCriticalClaims as readClaims, writeCriticalClaims as writeClaims } from '../helpers/criticalStockClaims';

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
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCriticalAlarmScheduler — never schedules for critical or frozen meds', () => {
  it('does not schedule for an already-critical med (the foreground owns the episode)', async () => {
    const med = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toBeUndefined();
  });

  it('keeps a critical med\u2019s consumed claim (it is what suppresses duplicates)', async () => {
    writeClaims({ 'med-1': { claimed: true, alarmTime: Date.now() - 1000 } });
    const med = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expect.any(Number) });
  });

  it('cancels an alarm it armed earlier in the session once the med becomes critical', async () => {
    const medA = makeMed({ currentPills: 30 });
    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    // Med crosses (manual consumption) → the alarm this session armed is stale.
    const medB = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    rerender(defaultOpts({ medications: [medB] }));
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledTimes(1); // no re-arm for critical meds
  });

  it('cancels the alarm it armed when a sufficient med becomes frozen, but leaves the claim to the foreground hook', async () => {
    const medA = makeMed({ currentPills: 30 });
    const t1 = getCriticalAlarmDate(medA, getTodayDateString()) as number;
    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t1 });

    // Med becomes frozen (auto-deduct off): nothing will cross without
    // user action. The scheduler cancels the alarm it armed — and ONLY
    // that: ending the episode (clearing the claim) is useStockAlerts'
    // synchronous job, and an async clear here is exactly the race that
    // silenced new episodes.
    const medB = makeMed({ currentPills: 30, autoDeductEnabled: false });
    rerender(defaultOpts({ medications: [medB] }));
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t1 });
  });

  it('a frozen sufficient med whose alarm was not armed this session is left entirely to the foreground hook', async () => {
    // Cross-session state: an old claim exists, but this session never
    // armed anything — the scheduler has no alarm business here, and the
    // claim lifecycle belongs to useStockAlerts.
    const med = makeMed({ autoDeductEnabled: false, currentPills: 30 });
    writeClaims({ 'med-1': { claimed: true, alarmTime: Date.now() - 86_400_000 } });

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(scheduleMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expect.any(Number) });
  });
});
describe('useCriticalAlarmScheduler — opt-out and cleanup', () => {
  it('cancels alarms when critical-stock alerts are disabled and leaves claims to the foreground hook', async () => {
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });

    rerender(defaultOpts({ medications: [med], criticalStockAlertsEnabled: false }));
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-1');
    // The scheduler only cancels native alarms. Clearing a Sufficient
    // med's claim is useStockAlerts' synchronous job — an async clear
    // here raced with new episodes (the blocker this ownership fixes).
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('keeps consumed claims (foreground send / past alarm) on opt-out', async () => {
    writeClaims({ 'med-1': { claimed: true, alarmTime: null } });
    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [makeMed()], criticalStockAlertsEnabled: false }),
    });
    await flush();

    // Claim with no armed alarm: nothing to cancel, nothing to restore.
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('cancels the alarm when a medication is deleted (claim entry removed by the foreground hook)', async () => {
    const med = makeMed();
    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    rerender(defaultOpts({ medications: [] }));
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-1');
  });

  it('cancels cross-session armed alarms for meds that still have a claim when opted out', async () => {
    // The alarm was armed in a previous session; this session starts with
    // notifications disabled — the claim map still names the med.
    writeClaims({ 'med-old': { claimed: true, alarmTime: Date.now() + 86_400_000 } });
    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [], criticalStockAlertsEnabled: false }),
    });
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-old');
    // The claim entry itself is the foreground hook's business (it
    // clears claims for deleted/sufficient meds synchronously); the
    // scheduler only cancels the native alarm.
    expect(readClaims()['med-old']).toEqual({ claimed: true, alarmTime: expect.any(Number) });
  });
});
