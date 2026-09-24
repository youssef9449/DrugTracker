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

describe('useCriticalAlarmScheduler — verified fast path (native alarm reconciliation)', () => {
  it('BLOCKER: matching claim + native alarm verified → keep as-is, no re-arm, no claim writes', async () => {
    // Case 2: { claimed: true, alarmTime: T } + the native pending alarm
    // actually exists at T → the claim is trusted WITHOUT re-arming.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: true });
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;
    writeClaims({ 'med-1': { claimed: true, alarmTime: expectedT } });

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    // Verification ran…
    expect(verifyMock).toHaveBeenCalledWith('med-1', expectedT);
    // …but nothing was re-armed and nothing was written.
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('BLOCKER: matching claim + native alarm missing → repair re-arms and the claim matches the real schedule again', async () => {
    // Case 3: the claim says "armed at T" but verification cannot find
    // the native alarm (it was dropped by the OS) → cancel + re-schedule
    // at the SAME T; a successful repair keeps the claim armed at T.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: false });
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;
    writeClaims({ 'med-1': { claimed: true, alarmTime: expectedT } });

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(verifyMock).toHaveBeenCalledWith('med-1', expectedT);
    // The repair chain: cancel the (possibly stale) alarm, re-arm at T.
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', expectedT, 'قرص');
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('BLOCKER: repair fails → the claim opens so the foreground fallback stays available', async () => {
    // Case 3 (failure) / Case 5: a missing native alarm that cannot be
    // re-armed must NOT stay recorded as armed — the episode's
    // notification opportunity stays open for the foreground.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: false });
    scheduleMock.mockResolvedValue({ ok: false, error: 'schedule_failed', errorCode: 'platform_failure' });
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;
    writeClaims({ 'med-1': { claimed: true, alarmTime: expectedT } });

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
  });

  it('reconciliation never sends a user-facing notification for a sufficient med (repair is silent)', async () => {
    // The repair only touches native alarms + claim bookkeeping: no
    // notification is shown merely because reconciliation happened.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: false });
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;
    writeClaims({ 'med-1': { claimed: true, alarmTime: expectedT } });

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    // The scheduler hook has no send API at all; assert the repair did
    // not write a consumed claim (which would silently suppress the
    // episode's future notification).
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('web: a matching claim is never trusted — verification has no native pending list, so the repair chain runs', async () => {
    // On web there is no persistent native alarm at all: an armed claim
    // (e.g. a migration artifact) must not silently suppress the
    // episode. The repair runs; with the (web) schedule failing, the
    // claim opens and the foreground fallback takes over.
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;
    writeClaims({ 'med-1': { claimed: true, alarmTime: expectedT } });
    scheduleMock.mockResolvedValue({ ok: false, error: 'schedule_failed', errorCode: 'platform_failure' }); // real web scheduleCriticalAlarm always fails

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();

    expect(verifyMock).toHaveBeenCalledWith('med-1', expectedT);
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
  });

  it('app resume (resumeTick) re-runs reconciliation against the platform', async () => {
    // Simulate app resume after the alarm disappeared: the resume tick
    // re-runs the effect, which verifies the claim again and repairs.
    platformMock.mockReturnValue('android');
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med], resumeTick: 0 }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1); // cold start armed it
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });

    // The alarm disappeared while the app was backgrounded.
    verifyMock.mockResolvedValue({ ok: true, pending: false });

    // Resume: App.tsx bumps the tick → the effect re-runs → the claim
    // is verified (and fails) → repaired at the same T.
    rerender(defaultOpts({ medications: [med], resumeTick: 1 }));
    await flush();

    expect(verifyMock).toHaveBeenCalledWith('med-1', expectedT);
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock).toHaveBeenLastCalledWith('med-1', 'Test Med', expectedT, 'قرص');
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('app resume with the alarm still verified present does NOT re-arm (no duplicate alarm, no churn)', async () => {
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue({ ok: true, pending: true });
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med], resumeTick: 0 }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });

    scheduleMock.mockClear();
    cancelMock.mockClear();

    rerender(defaultOpts({ medications: [med], resumeTick: 1 }));
    await flush();

    expect(verifyMock).toHaveBeenCalledWith('med-1', expectedT);
    expect(scheduleMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });
  });

  it('stale reconciliation cannot overwrite newer business state (gated verify + newer run wins)', async () => {
    // While a reconciliation verify is in flight, the projection moves;
    // the newer run re-arms at T2. The stale verify's repair must write
    // nothing (generation guard).
    platformMock.mockReturnValue('android');
    const medA = makeMed({ currentPills: 30 });
    const t1 = getCriticalAlarmDate(medA, getTodayDateString()) as number;
    writeClaims({ 'med-1': { claimed: true, alarmTime: t1 } });

    const gate = deferred<Awaited<ReturnType<typeof verifyCriticalAlarmPending>>>();
    verifyMock.mockReturnValueOnce(gate.promise); // reconciliation verify is gated

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(scheduleMock).not.toHaveBeenCalled(); // still awaiting verification

    // The projection moves while the verify is in flight.
    const medB = makeMed({ currentPills: 60 });
    const t2 = getCriticalAlarmDate(medB, getTodayDateString()) as number;
    rerender(defaultOpts({ medications: [medB] }));

    // The stale verify resolves "missing" → its repair runs — but it is
    // superseded: it must not arm anything or write any claim.
    gate.resolve({ ok: true, pending: false });
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t2 });
    // The newer run armed exactly one alarm at t2.
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', t2, 'قرص');
  });
});
