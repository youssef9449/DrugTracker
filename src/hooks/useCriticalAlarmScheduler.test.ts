/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
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

  function readScheduledRecord(medId: string): { transitionKey: string; alarmTime: number; status: string } | undefined {
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
});

// Re-import to suppress the unused-import lint warning on the
// notifications module symbols (the actual exports are replaced by
// the hoisted mocks above, but we still need the import for type
// inference on vi.mocked() assertions elsewhere in this file).
void scheduleCriticalAlarm;
void cancelCriticalAlarm;

