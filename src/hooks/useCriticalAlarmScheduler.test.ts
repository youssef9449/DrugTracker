/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '../types';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '../utils/criticalNotificationClaims';
import {
  useCriticalAlarmScheduler,
  type UseCriticalAlarmSchedulerOptions,
} from './useCriticalAlarmScheduler';

// Mutable platform mock so tests can switch between the web and the
// native (android) code paths.
const platformMock = vi.hoisted(() => vi.fn(() => 'web'));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: platformMock },
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

vi.mock('../utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../utils/notifications')>(
    '../utils/notifications'
  );
  return {
    ...actual,
    scheduleCriticalAlarm: mocks.schedule,
    cancelCriticalAlarm: mocks.cancel,
    verifyCriticalAlarmPending: mocks.verify,
  };
});

import { scheduleCriticalAlarm, cancelCriticalAlarm } from '../utils/notifications';

const scheduleMock = vi.mocked(scheduleCriticalAlarm);
const cancelMock = vi.mocked(cancelCriticalAlarm);
const verifyMock = mocks.verify;

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    ...overrides,
  };
}

function defaultOpts(
  overrides: Partial<UseCriticalAlarmSchedulerOptions> = {}
): UseCriticalAlarmSchedulerOptions {
  return {
    medications: [],
    notificationsEnabled: true,
    criticalStockAlertsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    ...overrides,
  };
}

function readClaims(): Record<string, { claimed: boolean; alarmTime: number | null }> {
  return JSON.parse(localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY) || '{}');
}

function writeClaims(claims: Record<string, { claimed: boolean; alarmTime: number | null }>) {
  localStorage.setItem(CRITICAL_CLAIMS_STORAGE_KEY, JSON.stringify(claims));
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
  scheduleMock.mockResolvedValue(true);
  cancelMock.mockReset();
  cancelMock.mockResolvedValue(undefined);
  // Default: verification finds nothing (web semantics — there is no
  // native alarm on web). Native tests override this per case.
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCriticalAlarmScheduler — scheduling and the persistent claim', () => {
  it('schedules one alarm for a sufficient med with a future crossing and persists the claim ONLY after success', async () => {
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString());
    expect(expectedT).not.toBeNull();

    const gate = deferred<boolean>();
    scheduleMock.mockReturnValueOnce(gate.promise);

    renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });

    // Not yet resolved → no claim persisted yet.
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', expectedT, 'قرص');
    expect(readClaims()['med-1']).toBeUndefined();

    gate.resolve(true);
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
    scheduleMock.mockResolvedValue(false);
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

describe('useCriticalAlarmScheduler — verified fast path (native alarm reconciliation)', () => {
  it('BLOCKER: matching claim + native alarm verified → keep as-is, no re-arm, no claim writes', async () => {
    // Case 2: { claimed: true, alarmTime: T } + the native pending alarm
    // actually exists at T → the claim is trusted WITHOUT re-arming.
    platformMock.mockReturnValue('android');
    verifyMock.mockResolvedValue(true);
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
    verifyMock.mockResolvedValue(false);
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
    verifyMock.mockResolvedValue(false);
    scheduleMock.mockResolvedValue(false);
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
    verifyMock.mockResolvedValue(false);
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
    scheduleMock.mockResolvedValue(false); // real web scheduleCriticalAlarm always fails

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
    verifyMock.mockResolvedValue(false);

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
    verifyMock.mockResolvedValue(true);
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

    const gate = deferred<boolean>();
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
    gate.resolve(false);
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t2 });
    // The newer run armed exactly one alarm at t2.
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledWith('med-1', 'Test Med', t2, 'قرص');
  });
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
  it('cancels alarms when notifications are disabled and leaves claims to the foreground hook', async () => {
    const med = makeMed();
    const expectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [med] }),
    });
    await flush();
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: expectedT });

    rerender(defaultOpts({ medications: [med], notificationsEnabled: false }));
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
      initialProps: defaultOpts({ medications: [makeMed()], notificationsEnabled: false }),
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
      initialProps: defaultOpts({ medications: [], notificationsEnabled: false }),
    });
    await flush();

    expect(cancelMock).toHaveBeenCalledWith('med-old');
    // The claim entry itself is the foreground hook's business (it
    // clears claims for deleted/sufficient meds synchronously); the
    // scheduler only cancels the native alarm.
    expect(readClaims()['med-old']).toEqual({ claimed: true, alarmTime: expect.any(Number) });
  });
});

describe('useCriticalAlarmScheduler — stale-async safety', () => {
  it('a newer run supersedes an in-flight schedule: the stale alarm is cancelled and only the newer claim survives', async () => {
    const medA = makeMed({ currentPills: 30 });

    // Gate the first schedule so it is still pending when the newer run starts.
    const gate = deferred<boolean>();
    scheduleMock.mockReturnValueOnce(gate.promise);
    scheduleMock.mockResolvedValueOnce(true);

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
    gate.resolve(true);
    await flush();

    // Run 1 compensated by cancelling the alarm it armed; run 2 re-armed
    // at the new projection and persisted the newer claim.
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: t2 });
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock).toHaveBeenLastCalledWith('med-1', 'Test Med', t2, 'قرص');
  });

  it('a medication that crosses while its schedule is in flight aborts the claim write and cancels the just-armed alarm', async () => {
    const medA = makeMed({ currentPills: 30 });

    const gate = deferred<boolean>();
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
    gate.resolve(true);
    await flush();

    // cancel called for the pre-schedule cancel AND the compensation.
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(readClaims()['med-1']).toBeUndefined();
    expect(scheduleMock).toHaveBeenCalledTimes(1);
  });

  it('a medication deleted while its schedule is in flight leaves no claim', async () => {
    const medA = makeMed({ currentPills: 30 });
    const gate = deferred<boolean>();
    scheduleMock.mockReturnValueOnce(gate.promise);

    const { rerender } = renderHook((props) => useCriticalAlarmScheduler(props), {
      initialProps: defaultOpts({ medications: [medA] }),
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    rerender(defaultOpts({ medications: [] }));
    gate.resolve(true);
    await flush();

    expect(readClaims()['med-1']).toBeUndefined();
  });
});
