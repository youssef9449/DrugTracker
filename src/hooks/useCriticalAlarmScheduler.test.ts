/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  CRITICAL_TRANSITION_STORAGE_KEY,
  SCHEDULED_CRITICAL_STORAGE_KEY,
} from '../utils/criticalTransitions';
import { useCriticalAlarmScheduler } from './useCriticalAlarmScheduler';

// Mock @capacitor/core so isNativePlatform() returns false (web path),
// which makes cancelCriticalAlarm a no-op and scheduleCriticalAlarm
// fall through to the web fallback (also a no-op in tests). The mocks
// for the notification functions let us assert on call counts.
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    checkPermissions: vi.fn(),
  },
}));

// Mutable mocks so we can control Promise resolution per-test for the
// race-guard tests. vi.hoisted is required because vi.mock factories
// are hoisted to the top of the file (above any const declarations).
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
}));

// Override the scheduleCriticalAlarm + cancelCriticalAlarm exports
// with the hoisted mocks. The real functions wrap Capacitor's API;
// here we replace them with controllable vi.fn()s.
vi.mock('../utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../utils/notifications')>(
    '../utils/notifications'
  );
  return {
    ...actual,
    scheduleCriticalAlarm: mocks.schedule,
    cancelCriticalAlarm: mocks.cancel,
  };
});

import { scheduleCriticalAlarm, cancelCriticalAlarm } from '../utils/notifications';

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

function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    medications: [] as Medication[],
    notificationsEnabled: true,
    criticalStockAlertsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Isolate persisted scheduled-record state between tests.
  localStorage.clear();
  // Wave 13 #123: pin system time so getTodayDateString() (used by
  // makeMed's lastSyncDate default) resolves to a deterministic date.
  // Only Date is faked so the hook's `await Promise.resolve()` chains
  // (microtasks) and the race-guard serialization continue to work.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  mocks.schedule.mockReset();
  mocks.cancel.mockReset();
  // Default: cancel resolves immediately, schedule resolves immediately.
  mocks.cancel.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/**
 * Flush microtasks until a predicate returns true (or a max iteration
 * count is reached). Useful for waiting until the serialized
 * cancel/schedule chain has settled to a known state without manually
 * counting `await Promise.resolve()` calls.
 */
async function flushUntil(
  predicate: () => boolean,
  maxIterations = 20
): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  // Final check — if still false, the test will fail on the caller's
  // assertion, which is more informative than a timeout error here.
}

describe('useCriticalAlarmScheduler — basic scheduling', () => {
  it('schedules a critical alarm for each medication on mount', async () => {
    const med1 = makeMed({ id: 'med-a', name: 'A', currentPills: 30, dailyDose: 1 });
    const med2 = makeMed({ id: 'med-b', name: 'B', currentPills: 20, dailyDose: 2 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med1, med2] })));

    // cancel is enqueued per-med (runs on a microtask), then schedule
    // fires after the cancel Promise resolves. Flush the microtask
    // for the cancel to actually be called.
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith('med-a');
    expect(mocks.cancel).toHaveBeenCalledWith('med-b');
  });

  it('schedules for a med with sufficient supply (future crossing)', async () => {
    const med = makeMed({ id: 'med-future', currentPills: 30, dailyDose: 1, warningThresholdDays: 5 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));

    // Flush microtasks so the cancel().then(schedule()) chain runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule).toHaveBeenCalledWith(
      'med-future',
      'Test Med',
      expect.any(Number),
      'قرص'
    );
  });

  it('does NOT schedule for an already-critical med (returns null)', async () => {
    // daysLeft 1 <= critical threshold 2 → already critical → null.
    const med = makeMed({ id: 'med-crit', currentPills: 1, dailyDose: 1, warningThresholdDays: 5 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('does NOT schedule before hydration', async () => {
    const med = makeMed({ id: 'med-nohydr', currentPills: 30 });

    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [med], hydrated: false })
      )
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('does NOT schedule on first run (seed data)', async () => {
    const med = makeMed({ id: 'med-firstrun', currentPills: 30 });

    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [med], isFirstRun: true })
      )
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('cancels all previously-scheduled alarms when criticalStockAlertsEnabled flips off', async () => {
    const med = makeMed({ id: 'med-optout', currentPills: 30 });

    const { rerender } = renderHook(
      ({ medications, criticalStockAlertsEnabled }) =>
        useCriticalAlarmScheduler(
          defaultOpts({ medications, criticalStockAlertsEnabled })
        ),
      {
        initialProps: {
          medications: [med] as Medication[],
          criticalStockAlertsEnabled: true,
        },
      }
    );

    // Initial: schedule fires.
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    // Flip criticalStockAlertsEnabled off.
    mocks.cancel.mockClear();
    rerender({
      medications: [med],
      criticalStockAlertsEnabled: false,
    });

    // The opt-out cancel is enqueued (runs on a microtask).
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith('med-optout');
  });

  it('cancels all previously-scheduled alarms when notificationsEnabled flips off', async () => {
    const med = makeMed({ id: 'med-notoff', currentPills: 30 });

    const { rerender } = renderHook(
      ({ medications, notificationsEnabled }) =>
        useCriticalAlarmScheduler(
          defaultOpts({ medications, notificationsEnabled })
        ),
      {
        initialProps: {
          medications: [med] as Medication[],
          notificationsEnabled: true,
        },
      }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    mocks.cancel.mockClear();
    rerender({
      medications: [med],
      notificationsEnabled: false,
    });

    // The opt-out cancel is enqueued (runs on a microtask).
    await Promise.resolve();
    expect(mocks.cancel).toHaveBeenCalledWith('med-notoff');
  });
});

describe('useCriticalAlarmScheduler — race protection (generation guard + serialization)', () => {
  // With per-med serialization, all cancel/schedule operations for a
  // given med are chained onto a per-med Promise. Each effect run
  // APPENDS its operation to the chain, so they run strictly in order.
  // The tests below use controllable Promise resolvers + a
  // native-notification-store model to verify the FINAL alarm state.

  /** A minimal in-memory model of the native notification store. */
  function createNativeStore() {
    const store = new Map<number, { medId: string; fireAt: number }>();
    return {
      schedule: (id: number, medId: string, fireAt: number) => {
        store.set(id, { medId, fireAt });
      },
      cancel: (id: number) => { store.delete(id); },
      has: (id: number) => store.has(id),
      get: (id: number) => store.get(id),
      size: () => store.size,
    };
  }

  it('rapid medication state changes: only the LATEST state schedule fires (older schedules bail)', async () => {
    const cancelResolvers: Array<() => void> = [];
    mocks.cancel.mockImplementation(() => {
      return new Promise<void>((resolve) => { cancelResolvers.push(resolve); });
    });
    const scheduleSpy = vi.fn();
    mocks.schedule.mockImplementation(scheduleSpy);

    const medState1 = makeMed({ id: 'med-rapid', currentPills: 30, dailyDose: 1 });
    const medState2 = makeMed({ id: 'med-rapid', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [medState1] as Medication[] } }
    );

    // G1's op is enqueued. Flush until G1's cancel fires.
    await flushUntil(() => cancelResolvers.length >= 1);
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Trigger G2 BEFORE G1's cancel resolves. G2's op is queued.
    rerender({ medications: [medState2] as Medication[] });

    // Resolve G1's cancel → G1 bails (gen stale) → G1 chain completes
    // → G2's op runs → G2's cancel fires.
    cancelResolvers[0]();
    await flushUntil(() => cancelResolvers.length >= 2);
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Resolve G2's cancel → G2's pre-schedule check passes → schedule D2.
    cancelResolvers[1]();
    await flushUntil(() => scheduleSpy.mock.calls.length >= 1);

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith('med-rapid', 'Test Med', expect.any(Number), 'قرص');
    const scheduledDate = scheduleSpy.mock.calls[0][2] as number;
    expect(scheduledDate - Date.now()).toBeGreaterThan(40 * 24 * 60 * 60 * 1000);
  });

  it('medication deletion while scheduling is in flight: no stale schedule fires', async () => {
    const cancelResolvers: Array<() => void> = [];
    mocks.cancel.mockImplementation(() => {
      return new Promise<void>((resolve) => { cancelResolvers.push(resolve); });
    });
    const scheduleSpy = vi.fn();
    mocks.schedule.mockImplementation(scheduleSpy);

    const medX = makeMed({ id: 'med-deleted', currentPills: 30, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [medX] as Medication[] } }
    );

    await flushUntil(() => cancelResolvers.length >= 1);
    expect(scheduleSpy).not.toHaveBeenCalled();

    rerender({ medications: [] as Medication[] });

    cancelResolvers[0]();
    await flushUntil(() => cancelResolvers.length >= 2);
    expect(scheduleSpy).not.toHaveBeenCalled();

    cancelResolvers[1]();
    await flushUntil(() => true, 5);
    expect(scheduleSpy).not.toHaveBeenCalled();

    expect(mocks.cancel).toHaveBeenCalledWith('med-deleted');
    expect(mocks.cancel.mock.calls.filter((c) => c[0] === 'med-deleted')).toHaveLength(2);
  });

  it('a successful first schedule followed by a state change schedules both (no false bail)', async () => {
    const medState1 = makeMed({ id: 'med-seq', currentPills: 30, dailyDose: 1 });
    const medState2 = makeMed({ id: 'med-seq', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [medState1] as Medication[] } }
    );

    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const firstDate = mocks.schedule.mock.calls[0][2] as number;

    rerender({ medications: [medState2] as Medication[] });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);

    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    const lastDate = lastCall[2] as number;
    expect(lastDate).toBeGreaterThan(firstDate);
  });

  // ─── THE BLOCKER RACE: older schedule completes AFTER newer schedule ───
  //
  // Without serialization, G1's compensating cancel (same stable id)
  // would cancel G2's alarm. With serialization, G1's full chain
  // (including compensating cancel) runs BEFORE G2's schedule, so G1's
  // cancel only removes G1's OWN alarm. Tests assert the FINAL native
  // notification state (not just call counts).

  it('BLOCKER: G1 schedule in flight, G2 starts → only G2 alarm survives (native store)', async () => {
    const nativeStore = createNativeStore();
    const STABLE_ID = 12345;
    const cancelResolvers: Array<() => void> = [];
    const scheduleResolvers: Array<() => void> = [];

    mocks.cancel.mockImplementation((_medId: string) => {
      return new Promise<void>((resolve) => {
        nativeStore.cancel(STABLE_ID);
        cancelResolvers.push(resolve);
      });
    });
    mocks.schedule.mockImplementation((medId: string, _name: string, fireAt: number) => {
      return new Promise<void>((resolve) => {
        nativeStore.schedule(STABLE_ID, medId, fireAt);
        scheduleResolvers.push(resolve);
      });
    });

    const medG1 = makeMed({ id: 'med-blocker', currentPills: 30, dailyDose: 1 });
    const medG2 = makeMed({ id: 'med-blocker', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [medG1] as Medication[] } }
    );

    // G1's cancel fires.
    await flushUntil(() => cancelResolvers.length >= 1);

    // G2 starts BEFORE G1's cancel resolves. G2's op queued.
    rerender({ medications: [medG2] as Medication[] });

    // Resolve G1's cancel → G1 bails (gen 2) → G1 chain completes →
    // G2's cancel fires.
    cancelResolvers[0]();
    await flushUntil(() => cancelResolvers.length >= 2);

    // Resolve G2's cancel → G2's schedule fires.
    cancelResolvers[1]();
    await flushUntil(() => scheduleResolvers.length >= 1);

    // Resolve G2's schedule → G2's alarm placed → G2's post-schedule
    // check passes (gen 2 vs 2) → no undo.
    scheduleResolvers[0]();
    await flushUntil(() => true, 5);

    // FINAL: native store contains ONLY G2's alarm (fireAt = D2 ~58 days).
    expect(nativeStore.size()).toBe(1);
    expect(nativeStore.has(STABLE_ID)).toBe(true);
    const alarm = nativeStore.get(STABLE_ID);
    expect(alarm).toBeDefined();
    expect(alarm!.medId).toBe('med-blocker');
    expect(alarm!.fireAt - Date.now()).toBeGreaterThan(40 * 24 * 60 * 60 * 1000);
  });

  it('BLOCKER: G1 schedule completes, G2 starts → only G2 alarm survives (G1 compensating cancel removes only G1)', async () => {
    const nativeStore = createNativeStore();
    const STABLE_ID = 67890;
    const cancelResolvers: Array<() => void> = [];
    const scheduleResolvers: Array<() => void> = [];

    mocks.cancel.mockImplementation((_medId: string) => {
      return new Promise<void>((resolve) => {
        nativeStore.cancel(STABLE_ID);
        cancelResolvers.push(resolve);
      });
    });
    mocks.schedule.mockImplementation((medId: string, _name: string, fireAt: number) => {
      return new Promise<void>((resolve) => {
        nativeStore.schedule(STABLE_ID, medId, fireAt);
        scheduleResolvers.push(resolve);
      });
    });

    const medG1 = makeMed({ id: 'med-blocker2', currentPills: 30, dailyDose: 1 });
    const medG2 = makeMed({ id: 'med-blocker2', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [medG1] as Medication[] } }
    );

    // G1's cancel fires.
    await flushUntil(() => cancelResolvers.length >= 1);

    // Resolve G1's cancel → G1's pre-schedule check passes → G1's
    // schedule fires (places G1's alarm synchronously).
    cancelResolvers[0]();
    await flushUntil(() => scheduleResolvers.length >= 1);
    // G1's alarm is in the store (placed synchronously by schedule mock).
    expect(nativeStore.has(STABLE_ID)).toBe(true);

    // G2 starts WHILE G1's schedule is in flight. G2's op queued.
    rerender({ medications: [medG2] as Medication[] });

    // Resolve G1's schedule → G1's post-schedule check: gen 1 vs 2 →
    // STALE → compensating cancel fires (removes G1's alarm synchronously).
    scheduleResolvers[0]();
    await flushUntil(() => cancelResolvers.length >= 2);
    // G1's alarm was removed by its own compensating cancel.
    expect(nativeStore.has(STABLE_ID)).toBe(false);

    // Resolve G1's compensating cancel → G1's chain completes →
    // G2's op runs → G2's cancel fires.
    cancelResolvers[1]();
    await flushUntil(() => cancelResolvers.length >= 3);

    // Resolve G2's cancel → G2's schedule fires (places G2's alarm).
    cancelResolvers[2]();
    await flushUntil(() => scheduleResolvers.length >= 2);

    // Resolve G2's schedule → G2's post-schedule check passes → no undo.
    scheduleResolvers[1]();
    await flushUntil(() => true, 5);

    // FINAL: native store contains ONLY G2's alarm (fireAt = D2 ~58 days).
    // G1's alarm was placed then removed by its own compensating cancel.
    // G2's alarm is the only one that survives.
    expect(nativeStore.size()).toBe(1);
    expect(nativeStore.has(STABLE_ID)).toBe(true);
    const alarm = nativeStore.get(STABLE_ID);
    expect(alarm).toBeDefined();
    expect(alarm!.medId).toBe('med-blocker2');
    expect(alarm!.fireAt - Date.now()).toBeGreaterThan(40 * 24 * 60 * 60 * 1000);
  });

  it('opt-out while a schedule is in flight: no alarm survives (native store)', async () => {
    const nativeStore = createNativeStore();
    const STABLE_ID = 11111;
    const cancelResolvers: Array<() => void> = [];
    const scheduleResolvers: Array<() => void> = [];

    mocks.cancel.mockImplementation((_medId: string) => {
      return new Promise<void>((resolve) => {
        nativeStore.cancel(STABLE_ID);
        cancelResolvers.push(resolve);
      });
    });
    mocks.schedule.mockImplementation((medId: string, _name: string, fireAt: number) => {
      return new Promise<void>((resolve) => {
        nativeStore.schedule(STABLE_ID, medId, fireAt);
        scheduleResolvers.push(resolve);
      });
    });

    const med = makeMed({ id: 'med-optout-race', currentPills: 30, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ criticalStockAlertsEnabled, medications }) =>
        useCriticalAlarmScheduler(
          defaultOpts({ criticalStockAlertsEnabled, medications })
        ),
      {
        initialProps: {
          criticalStockAlertsEnabled: true,
          medications: [med] as Medication[],
        },
      }
    );

    // G1's cancel fires.
    await flushUntil(() => cancelResolvers.length >= 1);

    // Resolve G1's cancel → G1's schedule fires (places G1's alarm).
    cancelResolvers[0]();
    await flushUntil(() => scheduleResolvers.length >= 1);
    expect(nativeStore.has(STABLE_ID)).toBe(true);

    // Opt-out WHILE G1's schedule is in flight.
    rerender({ criticalStockAlertsEnabled: false, medications: [med] });

    // Resolve G1's schedule → post-schedule check: gen stale →
    // compensating cancel fires (removes G1's alarm synchronously).
    scheduleResolvers[0]();
    await flushUntil(() => cancelResolvers.length >= 2);
    expect(nativeStore.has(STABLE_ID)).toBe(false);

    // Resolve G1's compensating cancel → G1's chain completes →
    // opt-out cancel fires.
    cancelResolvers[1]();
    await flushUntil(() => cancelResolvers.length >= 3);

    // Resolve the opt-out cancel (no-op, alarm already removed).
    cancelResolvers[2]();
    await flushUntil(() => true, 5);

    // FINAL: NO alarm survives. The user's opt-out is honored.
    expect(nativeStore.size()).toBe(0);
    expect(nativeStore.has(STABLE_ID)).toBe(false);
  });
});

describe('useCriticalAlarmScheduler — reboot fallback (app-launch re-arm)', () => {
  it('re-arms all alarms from the current medication state on mount (post-reboot re-launch)', async () => {
    // After a device reboot, the Capacitor plugin's BootReceiver
    // re-arms already-scheduled notifications from its persisted
    // store. But if the boot receiver doesn't fire (force-stopped
    // before reboot), opening the app triggers the reschedule
    // effect to re-arm all alarms from current state.
    const meds = [
      makeMed({ id: 'med-rb-1', currentPills: 30, dailyDose: 1 }),
      makeMed({ id: 'med-rb-2', currentPills: 20, dailyDose: 2 }),
      makeMed({ id: 'med-rb-3', currentPills: 14, dailyDose: 1, warningThresholdDays: 7 }),
    ];

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: meds })));

    await Promise.resolve();
    await Promise.resolve();

    // All three meds got a schedule call.
    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    expect(mocks.schedule).toHaveBeenCalledWith('med-rb-1', 'Test Med', expect.any(Number), 'قرص');
    expect(mocks.schedule).toHaveBeenCalledWith('med-rb-2', 'Test Med', expect.any(Number), 'قرص');
    expect(mocks.schedule).toHaveBeenCalledWith('med-rb-3', 'Test Med', expect.any(Number), 'قرص');
  });
});

describe('useCriticalAlarmScheduler — scheduled record persistence (identity separation)', () => {
  const TRANSITION_KEY_STORE = 'android_med_tracker_critical_transition_v2';
  const SCHEDULED_STORE = 'android_med_tracker_scheduled_critical_v2';

  function readScheduledRecord(
    medId: string
  ): { transitionKey: string; alarmTime: number; status: string; generation?: number } | undefined {
    const raw = localStorage.getItem(SCHEDULED_STORE);
    if (!raw) return undefined;
    return JSON.parse(raw)[medId];
  }

  it('persists the scheduled record with an EMPTY transitionKey only after schedule success', async () => {
    const med = makeMed({ id: 'med-persist', currentPills: 30, dailyDose: 1 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    // Let the post-schedule persistence microtasks settle.
    await flushUntil(() => readScheduledRecord('med-persist') !== undefined);

    const rec = readScheduledRecord('med-persist');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('SCHEDULED');
    // The scheduler NEVER writes an episode identity — the claim is
    // unbound ('') until the episode owner binds/adopts it.
    expect(rec!.transitionKey).toBe('');
    expect(rec!.alarmTime).toBeGreaterThan(Date.now());
  });

  it('NEVER writes the critical transition store (no identity creation)', async () => {
    const med = makeMed({ id: 'med-noidentity', currentPills: 30, dailyDose: 1 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    await flushUntil(() => readScheduledRecord('med-noidentity') !== undefined);

    expect(localStorage.getItem(TRANSITION_KEY_STORE)).toBeNull();
  });

  it('rescheduling with a changed projected date keeps the claim unbound and does not create an identity', async () => {
    const med1 = makeMed({ id: 'med-resched', currentPills: 30, dailyDose: 1 });
    const med2 = makeMed({ id: 'med-resched', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med1] as Medication[] } }
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    await flushUntil(() => readScheduledRecord('med-resched') !== undefined);
    const firstAlarmTime = readScheduledRecord('med-resched')!.alarmTime;

    rerender({ medications: [med2] as Medication[] });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    await flushUntil(() => readScheduledRecord('med-resched')!.alarmTime !== firstAlarmTime);

    const rec = readScheduledRecord('med-resched');
    expect(rec!.status).toBe('SCHEDULED');
    expect(rec!.transitionKey).toBe('');
    expect(rec!.alarmTime).toBeGreaterThan(firstAlarmTime);
    expect(localStorage.getItem(TRANSITION_KEY_STORE)).toBeNull();
  });

  it('scheduling failure neutralizes a prior SCHEDULED claim — no valid SCHEDULED claim survives', async () => {
    // A previous generation scheduled successfully; a reschedule now
    // FAILS. The stale SCHEDULED claim must be neutralized so it can
    // never suppress the foreground notification later.
    localStorage.setItem(
      SCHEDULED_STORE,
      JSON.stringify({ 'med-fail': { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED' } })
    );
    mocks.schedule.mockResolvedValue(false); // simulate failed native schedule
    const med = makeMed({ id: 'med-fail', currentPills: 30, dailyDose: 1 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    await flushUntil(() => readScheduledRecord('med-fail')?.status === 'NOT_SCHEDULED');

    const rec = readScheduledRecord('med-fail');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('NOT_SCHEDULED');
  });

  it('scheduling failure with no prior record persists nothing (no claim exists)', async () => {
    mocks.schedule.mockResolvedValue(false); // simulate failed native schedule
    const med = makeMed({ id: 'med-fail-fresh', currentPills: 30, dailyDose: 1 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    await flushUntil(() => true, 10);

    // No prior claim → nothing to neutralize → no record written. The
    // foreground path stays fully available for useStockAlerts.
    expect(readScheduledRecord('med-fail-fresh')).toBeUndefined();
    expect(localStorage.getItem(TRANSITION_KEY_STORE)).toBeNull();
  });

  it('scheduleCriticalAlarm is called WITHOUT a transition-key argument (4 args)', async () => {
    const med = makeMed({ id: 'med-arity', currentPills: 30, dailyDose: 1 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    expect(mocks.schedule.mock.calls[0]).toHaveLength(4);
  });

  it('TEST H: schedule success stamps the record SCHEDULED with a bumped generation', async () => {
    const med = makeMed({ id: 'med-genstamp', currentPills: 30, dailyDose: 1 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    await flushUntil(() => readScheduledRecord('med-genstamp') !== undefined);

    const rec = readScheduledRecord('med-genstamp')!;
    expect(rec.status).toBe('SCHEDULED');
    expect(rec.transitionKey).toBe('');
    expect(rec.generation).toBe(1); // first accepted scheduler write
  });
});

describe('useCriticalAlarmScheduler — scheduled-record ownership & generation (race safety)', () => {
  const TRANSITION_KEY_STORE = 'android_med_tracker_critical_transition_v2';
  const SCHEDULED_STORE = 'android_med_tracker_scheduled_critical_v2';

  type StoredRecord = {
    transitionKey: string;
    alarmTime: number;
    status: string;
    generation?: number;
  };

  function readRecord(medId: string): StoredRecord | undefined {
    const raw = localStorage.getItem(SCHEDULED_STORE);
    if (!raw) return undefined;
    return JSON.parse(raw)[medId];
  }

  function writeScheduledStore(records: Record<string, StoredRecord>): void {
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify(records));
  }

  it('TEST A/B: owner binds the claim to episode A → reschedule keeps binding A, only alarmTime changes', async () => {
    const med1 = makeMed({ id: 'med-bind', currentPills: 30, dailyDose: 1 });
    const med2 = makeMed({ id: 'med-bind', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med1] as Medication[] } }
    );
    await flushUntil(() => readRecord('med-bind') !== undefined);
    const first = readRecord('med-bind')!;
    expect(first.transitionKey).toBe(''); // unbound claim
    expect(first.generation).toBe(1);

    // The episode owner binds the claim (exactly what
    // reconcileCriticalEpisode does at the actual crossing): transition A
    // becomes active and the claim is bound to it. notificationState
    // 'SCHEDULED' = the registered alarm owns the episode's single
    // notification (a SENT episode would refuse scheduler writes —
    // covered by a dedicated BLOCKER test below).
    localStorage.setItem(
      TRANSITION_KEY_STORE,
      JSON.stringify({
        'med-bind': { transitionKey: 'crit_med-bind_A', enteredAt: Date.now(), notificationState: 'SCHEDULED' },
      })
    );
    const bound = JSON.parse(localStorage.getItem(SCHEDULED_STORE)!);
    bound['med-bind'].transitionKey = 'crit_med-bind_A';
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify(bound));

    // Stock change → new scheduler generation → reschedule (new projected date).
    rerender({ medications: [med2] as Medication[] });
    await flushUntil(() => mocks.schedule.mock.calls.length >= 2);
    await flushUntil(() => readRecord('med-bind')!.alarmTime !== first.alarmTime);

    const rec = readRecord('med-bind')!;
    // The binding to A survived the reschedule — the scheduler must never
    // replace it with an unbound claim.
    expect(rec.transitionKey).toBe('crit_med-bind_A');
    expect(rec.status).toBe('SCHEDULED');
    expect(rec.alarmTime).toBeGreaterThan(first.alarmTime); // only scheduling data changed
    expect(rec.generation).toBe(2);
    // The scheduler did not touch the transition store.
    const transitions = JSON.parse(localStorage.getItem(TRANSITION_KEY_STORE)!);
    expect(transitions['med-bind'].transitionKey).toBe('crit_med-bind_A');
  });

  it('TEST C: G1 schedule in flight, G2 starts → G1 bails + compensates; the persisted record is G2\u2019s', async () => {
    let releaseG1!: (value: boolean) => void;
    const g1Gate = new Promise<boolean>((resolve) => { releaseG1 = resolve; });
    // G1's schedule call hangs on the gate.
    mocks.schedule.mockImplementationOnce(() => g1Gate);

    const med1 = makeMed({ id: 'med-gen', currentPills: 30, dailyDose: 1 });
    const med2 = makeMed({ id: 'med-gen', currentPills: 70, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [med1] as Medication[] } }
    );
    // G1's op: cancel resolves → schedule is now gated and in flight.
    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    expect(readRecord('med-gen')).toBeUndefined(); // nothing persisted while gated

    // G2's effect run bumps the generation and enqueues op2 (serialized
    // behind op1's gate).
    rerender({ medications: [med2] as Medication[] });

    // Release G1: schedule resolves → G1's post-schedule gen check fails
    // → compensating cancel + neutralize. Then G2's op runs and persists.
    releaseG1(true);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 3);
    await flushUntil(() => readRecord('med-gen') !== undefined);

    const rec = readRecord('med-gen')!;
    // The persistent record belongs to G2 — the latest generation.
    expect(rec.status).toBe('SCHEDULED');
    expect(rec.transitionKey).toBe('');
    const g2Date = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1][2] as number;
    expect(rec.alarmTime).toBe(g2Date);
    expect(rec.generation).toBe(1);
  });

  it('TEST D: after episode A ends, a reschedule writes an UNBOUND claim (never resurrects A)', async () => {
    // Episode A ended: the owner deleted the transition and neutralized
    // its bound claim (the binding remains only as inert information).
    writeScheduledStore({
      'med-end': { transitionKey: 'crit_med-end_A', alarmTime: Date.now() + 86400000, status: 'NOT_SCHEDULED' },
    });
    // No active transition exists anymore.

    const med = makeMed({ id: 'med-end', currentPills: 90, dailyDose: 1 });
    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);
    await flushUntil(() => readRecord('med-end')?.status === 'SCHEDULED');

    const rec = readRecord('med-end')!;
    expect(rec.transitionKey).toBe('');     // A was NOT resurrected
    expect(rec.status).toBe('SCHEDULED');   // fresh valid claim for the future crossing
    expect(rec.generation).toBeGreaterThanOrEqual(1);
    // The scheduler never wrote the transition store (no identity creation).
    expect(localStorage.getItem(TRANSITION_KEY_STORE)).toBeNull();
  });

  it('TEST G: alarm date changes 3+ times ⇒ claim stays unbound, only alarmTime changes, generation advances', async () => {
    const meds = [30, 60, 90, 120].map((pills) =>
      makeMed({ id: 'med-g', currentPills: pills, dailyDose: 1 })
    );
    const { rerender } = renderHook(
      ({ medications }) => useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [meds[0]] as Medication[] } }
    );
    await flushUntil(() => readRecord('med-g') !== undefined);

    const alarmTimes: number[] = [readRecord('med-g')!.alarmTime];
    const keys = new Set<string>([readRecord('med-g')!.transitionKey]);

    for (let i = 1; i < meds.length; i++) {
      rerender({ medications: [meds[i]] as Medication[] });
      await flushUntil(() => mocks.schedule.mock.calls.length >= i + 1);
      await flushUntil(() => readRecord('med-g')!.alarmTime !== alarmTimes[i - 1]);
      alarmTimes.push(readRecord('med-g')!.alarmTime);
      keys.add(readRecord('med-g')!.transitionKey);
    }

    // No identity was ever created; every projected date landed.
    expect(keys).toEqual(new Set(['']));
    expect(new Set(alarmTimes).size).toBe(alarmTimes.length);
    const finalRec = readRecord('med-g')!;
    expect(finalRec.status).toBe('SCHEDULED');
    // One accepted write per distinct projected date.
    expect(finalRec.generation).toBe(alarmTimes.length);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Episode-vs-scheduler ownership races (BLOCKER 1 & BLOCKER 2).
//
// The owner's lifecycle writes (episode end / new episode / foreground
// send / med deletion) do NOT bump the record's scheduler generation,
// so an operation that checked only the generation could resurrect a
// dead claim or restore notification ownership after it was consumed.
// These tests simulate the owner's exact persistent writes WHILE a
// scheduler operation is gated inside its async native work, then let
// the operation finish and assert on the FINAL PERSISTENT STATE.
// ─────────────────────────────────────────────────────────────────────
describe('useCriticalAlarmScheduler — episode-vs-scheduler ownership races', () => {
  const TRANSITION_KEY_STORE = 'android_med_tracker_critical_transition_v2';
  const SCHEDULED_STORE = 'android_med_tracker_scheduled_critical_v2';
  const OWNERSHIP_STORE = 'android_med_tracker_critical_ownership_v2';

  type StoredRecord = {
    transitionKey: string;
    alarmTime: number;
    status: string;
    generation?: number;
  };

  function readRecord(medId: string): StoredRecord | undefined {
    const raw = localStorage.getItem(SCHEDULED_STORE);
    if (!raw) return undefined;
    return JSON.parse(raw)[medId];
  }

  function readTransitions(): Record<string, { transitionKey: string; notificationState: string }> {
    return JSON.parse(localStorage.getItem(TRANSITION_KEY_STORE) || '{}');
  }

  function readOwnership(): Record<string, number> {
    return JSON.parse(localStorage.getItem(OWNERSHIP_STORE) || '{}');
  }

  /** Seed the persistent stores exactly as previous writes left them. */
  function seedRecord(medId: string, record: StoredRecord): void {
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify({ [medId]: record }));
  }

  /**
   * Simulate the episode owner ENDING episode A (exactly the persistent
   * writes reconcileCriticalEpisode performs): transition deleted, the
   * claim bound to A neutralized, ownership revision bumped.
   */
  function ownerEndsEpisode(medId: string, keyA: string, revision: number): void {
    localStorage.setItem(TRANSITION_KEY_STORE, JSON.stringify({}));
    const sched = JSON.parse(localStorage.getItem(SCHEDULED_STORE)!);
    if (sched[medId] && sched[medId].transitionKey === keyA) {
      sched[medId].status = 'NOT_SCHEDULED';
    }
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify(sched));
    localStorage.setItem(OWNERSHIP_STORE, JSON.stringify({ [medId]: revision }));
  }

  it('BLOCKER 1 / Test A: a stale scheduler operation cannot resurrect the claim of an ended episode', async () => {
    // A previous scheduler write left an unbound SCHEDULED claim; no
    // episode is active yet.
    seedRecord('med-a', { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED', generation: 1 });

    let releaseG1!: (value: boolean) => void;
    const g1Gate = new Promise<boolean>((resolve) => { releaseG1 = resolve; });
    mocks.schedule.mockImplementationOnce(() => g1Gate);

    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [makeMed({ id: 'med-a', currentPills: 30, dailyDose: 1 })] })
      )
    );
    // G1 captured its context (unbound claim, gen 1, revision 0) and is
    // now gated inside scheduleCriticalAlarm.
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // The episode began AND ended while G1 awaited the bridge:
    // the owner bound the claim to A, then A became sufficient again —
    // transition deleted, claim neutralized, ownership revision bumped.
    const sched = JSON.parse(localStorage.getItem(SCHEDULED_STORE)!);
    sched['med-a'].transitionKey = 'crit_med-a_A';
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify(sched));
    ownerEndsEpisode('med-a', 'crit_med-a_A', 2);

    releaseG1(true);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2); // initial + compensating

    // The dead episode's claim was NOT resurrected: still neutralized,
    // still bound to A (inert), generation untouched by G1.
    const rec = readRecord('med-a')!;
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(rec.transitionKey).toBe('crit_med-a_A');
    expect(rec.generation).toBe(1);
    // No transition was created (the scheduler never creates identity).
    expect(readTransitions()['med-a']).toBeUndefined();
    // G1 cancelled the alarm it armed (compensating cancel).
    expect(mocks.cancel.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('BLOCKER 1 / Test B+G: a stale operation from episode A cannot write episode B or an unbound claim', async () => {
    seedRecord('med-b', { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED', generation: 1 });

    let releaseG1!: (value: boolean) => void;
    const g1Gate = new Promise<boolean>((resolve) => { releaseG1 = resolve; });
    mocks.schedule.mockImplementationOnce(() => g1Gate);

    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [makeMed({ id: 'med-b', currentPills: 30, dailyDose: 1 })] })
      )
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // A ended and B began while G1 awaited: B is active (NONE), the
    // leftover claim of A sits neutralized, the ownership revision moved.
    localStorage.setItem(
      TRANSITION_KEY_STORE,
      JSON.stringify({ 'med-b': { transitionKey: 'crit_med-b_B', enteredAt: Date.now(), notificationState: 'NONE' } })
    );
    const sched = JSON.parse(localStorage.getItem(SCHEDULED_STORE)!);
    sched['med-b'].transitionKey = 'crit_med-b_A'; // dead binding, neutralized
    sched['med-b'].status = 'NOT_SCHEDULED';
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify(sched));
    localStorage.setItem(OWNERSHIP_STORE, JSON.stringify({ 'med-b': 3 }));

    releaseG1(true);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);

    // G1 cannot restore A, cannot create an unbound claim, and cannot
    // overwrite B: the persistent state is exactly the owner's.
    const rec = readRecord('med-b')!;
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(rec.transitionKey).toBe('crit_med-b_A');
    expect(rec.generation).toBe(1);
    const transitions = readTransitions();
    expect(transitions['med-b'].transitionKey).toBe('crit_med-b_B');
    expect(transitions['med-b'].notificationState).toBe('NONE');
  });

  it('BLOCKER 2 / Test C: the scheduler never arms an alarm for a SENT episode', async () => {
    // Episode A is active and its single notification was already sent.
    localStorage.setItem(
      TRANSITION_KEY_STORE,
      JSON.stringify({ 'med-c': { transitionKey: 'crit_med-c_A', enteredAt: Date.now(), notificationState: 'SENT' } })
    );
    seedRecord('med-c', { transitionKey: 'crit_med-c_A', alarmTime: Date.now() + 86400000, status: 'NOT_SCHEDULED', generation: 1 });

    // The med projects a future crossing (sufficient), so the scheduler
    // effect WOULD schedule — but the active episode is SENT.
    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [makeMed({ id: 'med-c', currentPills: 30, dailyDose: 1 })] })
      )
    );
    await flushUntil(() => mocks.cancel.mock.calls.length >= 1);

    // The pre-arm relevance check refused: no alarm was scheduled and
    // no SCHEDULED ownership was (re)created for the SENT episode.
    expect(mocks.schedule).not.toHaveBeenCalled();
    const rec = readRecord('med-c')!;
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(readTransitions()['med-c'].notificationState).toBe('SENT');
  });

  it('Test I: foreground send during a schedule operation → compensating cancel, no SCHEDULED claim', async () => {
    seedRecord('med-i', { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'SCHEDULED', generation: 1 });

    let releaseG1!: (value: boolean) => void;
    const g1Gate = new Promise<boolean>((resolve) => { releaseG1 = resolve; });
    mocks.schedule.mockImplementationOnce(() => g1Gate);

    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [makeMed({ id: 'med-i', currentPills: 30, dailyDose: 1 })] })
      )
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // The med crossed while G1 awaited: episode A began, the pending
    // claim was bound to it, the FOREGROUND sent (future claim does not
    // suppress) → SENT. The owner bumped the ownership revision.
    localStorage.setItem(
      TRANSITION_KEY_STORE,
      JSON.stringify({ 'med-i': { transitionKey: 'crit_med-i_A', enteredAt: Date.now(), notificationState: 'SENT' } })
    );
    const sched = JSON.parse(localStorage.getItem(SCHEDULED_STORE)!);
    sched['med-i'].transitionKey = 'crit_med-i_A';
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify(sched));
    localStorage.setItem(OWNERSHIP_STORE, JSON.stringify({ 'med-i': 2 }));

    releaseG1(true);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 2);

    // Still SENT, no new SCHEDULED ownership, record untouched by G1 —
    // the alarm G1 armed was compensated (no duplicate notification).
    const rec = readRecord('med-i')!;
    expect(rec.status).toBe('SCHEDULED'); // the owner's bound claim, not G1's write
    expect(rec.transitionKey).toBe('crit_med-i_A');
    expect(rec.generation).toBe(1); // G1's write was abandoned
    expect(readTransitions()['med-i'].notificationState).toBe('SENT');
    expect(mocks.cancel.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('Test H: deleting a medication invalidates ownership synchronously and no stale operation resurrects the record', async () => {
    let releaseG1!: (value: boolean) => void;
    const g1Gate = new Promise<boolean>((resolve) => { releaseG1 = resolve; });
    mocks.schedule.mockImplementationOnce(() => g1Gate);

    const { rerender } = renderHook(
      ({ medications }) =>
        useCriticalAlarmScheduler(defaultOpts({ medications })),
      { initialProps: { medications: [makeMed({ id: 'med-h', currentPills: 30, dailyDose: 1 })] as Medication[] } }
    );
    // G1 is gated inside its schedule call.
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // The medication is deleted → the effect bumps the in-memory
    // generation AND the persistent ownership revision synchronously,
    // then enqueues the cleanup (cancel + clear).
    rerender({ medications: [] as Medication[] });
    expect(readOwnership()['med-h']).toBe(1); // bumped synchronously

    releaseG1(true);
    await flushUntil(() => mocks.cancel.mock.calls.length >= 3); // G1 initial + G1 compensating + cleanup

    // No scheduled record exists for the deleted medication and none
    // can be resurrected by the stale operation.
    expect(readRecord('med-h')).toBeUndefined();
    expect(readTransitions()['med-h']).toBeUndefined();
  });

  it('scenario 31: a schedule FAILURE after the episode ownership changed cannot invalidate the new episode', async () => {
    // G1 starts scheduling for the (then) sufficient med (a dead
    // episode A's consumed claim is still on the record). While the
    // native schedule is in flight, the owner ends A and begins
    // episode B (NONE, foreground-eligible, no claim yet). The schedule
    // then FAILS (resolves false). G1's failure path detects the stale
    // ownership context and must return WITHOUT touching persistent
    // state — in particular it must NOT neutralize/erase anything the
    // new owner left behind, and B's foreground eligibility (no valid
    // claim) must remain exactly as the owner wrote it.
    seedRecord('med-n', {
      transitionKey: 'crit_med-n_A',
      alarmTime: Date.now() - 7200000,
      status: 'FIRED_OR_DUE',
      generation: 2,
    });

    let releaseG1!: (value: boolean) => void;
    const g1Gate = new Promise<boolean>((resolve) => { releaseG1 = resolve; });
    mocks.schedule.mockImplementationOnce(() => g1Gate);

    renderHook(() =>
      useCriticalAlarmScheduler(
        defaultOpts({ medications: [makeMed({ id: 'med-n', currentPills: 30, dailyDose: 1 })] })
      )
    );
    await flushUntil(() => mocks.schedule.mock.calls.length >= 1);

    // Owner lifecycle while G1 awaited: A ended, B began (NONE), the
    // dead claim was dropped by the owner, revision bumped.
    localStorage.setItem(
      TRANSITION_KEY_STORE,
      JSON.stringify({
        'med-n': { transitionKey: 'crit_med-n_B', enteredAt: Date.now(), notificationState: 'NONE' },
      })
    );
    localStorage.setItem(SCHEDULED_STORE, JSON.stringify({
      'med-n': { transitionKey: '', alarmTime: 0, status: 'NOT_SCHEDULED', generation: 2 },
    }));
    localStorage.setItem(OWNERSHIP_STORE, JSON.stringify({ 'med-n': 5 }));

    releaseG1(false); // native scheduling FAILED
    // Drain the serialized chain (no observable side effect is expected
    // — that is the point — so flush a fixed, deterministic number of
    // microtask ticks; no timers are involved).
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // G1's stale failure wrote NOTHING: B's episode and the owner's
    // record state are exactly as the owner left them.
    const rec = readRecord('med-n')!;
    expect(rec.status).toBe('NOT_SCHEDULED');
    expect(rec.transitionKey).toBe('');
    expect(rec.generation).toBe(2); // no scheduler write landed
    const transitions = readTransitions();
    expect(transitions['med-n'].transitionKey).toBe('crit_med-n_B');
    expect(transitions['med-n'].notificationState).toBe('NONE');
    expect(readOwnership()['med-n']).toBe(5);
  });
});

// Re-import to suppress the unused-import lint warning on the
// notifications module symbols (the actual exports are replaced by
// the hoisted mocks above, but we still need the import for type
// inference on vi.mocked() assertions elsewhere in this file).
void scheduleCriticalAlarm;
void cancelCriticalAlarm;


// ─────────────────────────────────────────────────────────────────────
// FIRED_OR_DUE / consumed-claim decision table (scheduler never re-arms
// a claim whose firing window passed, and cancels stale armed alarms
// for episodes whose notification the foreground already consumed)
// ─────────────────────────────────────────────────────────────────────

describe('useCriticalAlarmScheduler — due/past claim terminality (no duplicate on reopen)', () => {
  it('a critical med with an adopted FIRED_OR_DUE claim is NEVER re-armed (no schedule call at all)', async () => {
    // The alarm fired while the app was dead and the user dismissed it.
    // The episode owner adopted the claim (FIRED_OR_DUE, bound record).
    localStorage.setItem(
      CRITICAL_TRANSITION_STORAGE_KEY,
      JSON.stringify({
        'med-crit': { transitionKey: 'crit_med-crit_A', enteredAt: Date.now() - 7200000, notificationState: 'FIRED_OR_DUE' },
      })
    );
    localStorage.setItem(
      SCHEDULED_CRITICAL_STORAGE_KEY,
      JSON.stringify({
        'med-crit': { transitionKey: 'crit_med-crit_A', alarmTime: Date.now() - 7200000, status: 'FIRED_OR_DUE' },
      })
    );
    const med = makeMed({ id: 'med-crit', currentPills: 1, dailyDose: 1, warningThresholdDays: 5 });

    const { rerender } = renderHook(
      (opts) => useCriticalAlarmScheduler(defaultOpts(opts)),
      { initialProps: defaultOpts({ medications: [med] }) }
    );
    await Promise.resolve();
    await Promise.resolve();
    await flushUntil(() => mocks.cancel.mock.calls.length >= 0);

    // No re-arm for the consumed claim — and no re-arm after re-runs.
    expect(mocks.schedule).not.toHaveBeenCalled();
    rerender(defaultOpts({ medications: [makeMed({ id: 'med-crit', currentPills: 1, dailyDose: 1, warningThresholdDays: 5 })] }));
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).not.toHaveBeenCalled();

    // The consumed record stays terminal; the transition is untouched.
    const rec = JSON.parse(localStorage.getItem(SCHEDULED_CRITICAL_STORAGE_KEY)!)['med-crit'];
    expect(rec.status).toBe('FIRED_OR_DUE');
    expect(rec.transitionKey).toBe('crit_med-crit_A');
  });

  it('a critical med with a bound due claim (pre-consumption SCHEDULED) is never re-armed either', async () => {
    // The scheduler may run BEFORE the episode owner consumes the claim:
    // it must not re-arm regardless (the owner consumes it instead).
    localStorage.setItem(
      CRITICAL_TRANSITION_STORAGE_KEY,
      JSON.stringify({
        'med-crit2': { transitionKey: 'crit_med-crit2_B', enteredAt: 1, notificationState: 'SCHEDULED' },
      })
    );
    localStorage.setItem(
      SCHEDULED_CRITICAL_STORAGE_KEY,
      JSON.stringify({
        'med-crit2': { transitionKey: 'crit_med-crit2_B', alarmTime: Date.now() - 1000, status: 'SCHEDULED' },
      })
    );
    const med = makeMed({ id: 'med-crit2', currentPills: 1, dailyDose: 1, warningThresholdDays: 5 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('cross-session staleness: an armed alarm for a SENT episode (foreground claimed it) is cancelled', async () => {
    // Episode was claimed by the foreground in a PREVIOUS session; the
    // alarm armed back then is still pending. A fresh app open must
    // cancel it — it could only ever fire a SECOND notification for the
    // same episode.
    localStorage.setItem(
      CRITICAL_TRANSITION_STORAGE_KEY,
      JSON.stringify({
        'med-sent': { transitionKey: 'crit_med-sent_C', enteredAt: 1, notificationState: 'SENT' },
      })
    );
    localStorage.setItem(
      SCHEDULED_CRITICAL_STORAGE_KEY,
      JSON.stringify({
        'med-sent': { transitionKey: 'crit_med-sent_C', alarmTime: Date.now() + 86400000, status: 'SCHEDULED' },
      })
    );
    const med = makeMed({ id: 'med-sent', currentPills: 1, dailyDose: 1, warningThresholdDays: 5 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    // Flush until the serialized chain (SENT-cancel op) has run.
    await flushUntil(() => mocks.cancel.mock.calls.some(([id]) => id === 'med-sent'));

    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledWith('med-sent');
  });

  it('cross-session: a FIRED_OR_DUE episode keeps its armed alarm (it is the episode\u2019s single remaining opportunity)', async () => {
    localStorage.setItem(
      CRITICAL_TRANSITION_STORAGE_KEY,
      JSON.stringify({
        'med-due': { transitionKey: 'crit_med-due_D', enteredAt: 1, notificationState: 'FIRED_OR_DUE' },
      })
    );
    localStorage.setItem(
      SCHEDULED_CRITICAL_STORAGE_KEY,
      JSON.stringify({
        'med-due': { transitionKey: 'crit_med-due_D', alarmTime: Date.now() - 1000, status: 'FIRED_OR_DUE' },
      })
    );
    const med = makeMed({ id: 'med-due', currentPills: 1, dailyDose: 1, warningThresholdDays: 5 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.cancel.mock.calls.length >= 0);

    // Never re-armed, and not cancelled either (the one-shot alarm fires
    // at most once — it IS the episode's own notification opportunity).
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('a sufficient med with a consumed claim left over from a DEAD episode re-arms a genuinely NEW unbound opportunity', async () => {
    // The old claim (FIRED_OR_DUE, bound to the dead episode A) is dead
    // state; the med is sufficient again and the projected crossing is
    // future. The new alarm is a new opportunity for a not-yet-begun
    // episode — allowed, and persisted UNBOUND (never resurrects A).
    localStorage.setItem(
      SCHEDULED_CRITICAL_STORAGE_KEY,
      JSON.stringify({
        'med-suff': { transitionKey: 'crit_med-suff_DEAD', alarmTime: Date.now() - 7200000, status: 'FIRED_OR_DUE', generation: 2 },
      })
    );
    const med = makeMed({ id: 'med-suff', currentPills: 30, dailyDose: 1, warningThresholdDays: 5 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med] })));
    await flushUntil(() => mocks.schedule.mock.calls.length > 0);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(localStorage.getItem(SCHEDULED_CRITICAL_STORAGE_KEY)!)['med-suff'];
    expect(rec.status).toBe('SCHEDULED');
    expect(rec.transitionKey).toBe(''); // unbound — dead binding dropped, A never resurrected
    expect(rec.generation).toBe(3);
    expect(rec.alarmTime).toBeGreaterThan(Date.now());
  });
});
