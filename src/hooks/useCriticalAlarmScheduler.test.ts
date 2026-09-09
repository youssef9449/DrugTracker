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
  mocks.schedule.mockReset();
  mocks.cancel.mockReset();
  // Default: cancel resolves immediately, schedule resolves immediately.
  mocks.cancel.mockResolvedValue(undefined);
  mocks.schedule.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('useCriticalAlarmScheduler — basic scheduling', () => {
  it('schedules a critical alarm for each medication on mount', () => {
    const med1 = makeMed({ id: 'med-a', name: 'A', currentPills: 30, dailyDose: 1 });
    const med2 = makeMed({ id: 'med-b', name: 'B', currentPills: 20, dailyDose: 2 });

    renderHook(() => useCriticalAlarmScheduler(defaultOpts({ medications: [med1, med2] })));

    // cancel is called first (synchronously) for each med, then
    // schedule fires asynchronously after the cancel Promise resolves.
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

    expect(mocks.cancel).toHaveBeenCalledWith('med-notoff');
  });
});

describe('useCriticalAlarmScheduler — race protection (generation guard)', () => {
  it('rapid medication state changes: only the LATEST state schedule fires (older schedules bail)', async () => {
    // Simulate a slow cancel() Promise: the first effect run's cancel
    // is pending when the second effect run starts.
    // med state 1: currentPills 30, dose 1 → D1 (28 days out).
    // med state 2: currentPills 60, dose 1 → D2 (58 days out).
    // The first run's .then() must bail (gen stale); only D2 schedule fires.

    const cancelResolvers: Array<() => void> = [];
    mocks.cancel.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        cancelResolvers.push(resolve);
      });
    });
    const scheduleSpy = vi.fn();
    mocks.schedule.mockImplementation(scheduleSpy);

    const medState1 = makeMed({ id: 'med-rapid', currentPills: 30, dailyDose: 1 });
    const medState2 = makeMed({ id: 'med-rapid', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) =>
        useCriticalAlarmScheduler(defaultOpts({ medications })),
      {
        initialProps: { medications: [medState1] as Medication[] },
      }
    );

    // Effect run #1 has called cancel (resolver 0 captured). schedule
    // has NOT been called yet (waiting on cancel to resolve).
    expect(cancelResolvers).toHaveLength(1);
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Trigger a rapid state change BEFORE the first cancel resolves.
    // This bumps the generation to 2 for med-rapid.
    rerender({ medications: [medState2] as Medication[] });

    // Effect run #2 also called cancel (resolver 1 captured). Gen is now 2.
    expect(cancelResolvers).toHaveLength(2);
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Resolve the first cancel (P1). Its .then() runs → checks gen
    // (1) vs current (2) → BAILS → does NOT call schedule.
    cancelResolvers[0]();
    await Promise.resolve();
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Resolve the second cancel (P2). Its .then() runs → checks gen
    // (2) vs current (2) → MATCHES → calls schedule with D2.
    cancelResolvers[1]();
    await Promise.resolve();
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(
      'med-rapid',
      'Test Med',
      expect.any(Number),
      'قرص'
    );

    // The scheduled date must match the LATEST state (D2, 58 days out),
    // NOT the stale state (D1, 28 days out). We assert it's > D1 by
    // comparing against a fresh getCriticalAlarmDate call for state1.
    const scheduledDate = scheduleSpy.mock.calls[0][2] as number;
    // For state 2 (60 pills, dose 1, threshold 5 → critical 2):
    // daysLeft 60 → daysUntilCritical 58 → scheduled ~58 days from now.
    // For state 1 (30 pills, dose 1, threshold 5 → critical 2):
    // daysLeft 30 → daysUntilCritical 28 → scheduled ~28 days from now.
    // The scheduled date should be > 40 days from now (well past D1).
    expect(scheduledDate - Date.now()).toBeGreaterThan(40 * 24 * 60 * 60 * 1000);
  });

  it('medication deletion while scheduling is in flight: no stale schedule fires for the deleted med', async () => {
    // med-X exists → effect run #1 schedules (cancel pending).
    // med-X is deleted → effect run #2 cancels + bumps generation.
    // Run #1's .then() bails (gen stale) → no stale schedule for med-X.

    const cancelResolvers: Array<() => void> = [];
    mocks.cancel.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        cancelResolvers.push(resolve);
      });
    });
    const scheduleSpy = vi.fn();
    mocks.schedule.mockImplementation(scheduleSpy);

    const medX = makeMed({ id: 'med-deleted', currentPills: 30, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) =>
        useCriticalAlarmScheduler(defaultOpts({ medications })),
      {
        initialProps: { medications: [medX] as Medication[] },
      }
    );

    // Effect run #1: cancel called for med-deleted (resolver 0).
    expect(cancelResolvers).toHaveLength(1);
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Delete med-X. Effect run #2 bumps gen + cancels (resolver 1).
    rerender({ medications: [] as Medication[] });
    expect(cancelResolvers).toHaveLength(2);

    // Resolve the FIRST cancel (run #1's cancel). Its .then() must
    // bail because gen was bumped by run #2. NO schedule for med-deleted.
    cancelResolvers[0]();
    await Promise.resolve();
    expect(scheduleSpy).not.toHaveBeenCalled();

    // Resolve the SECOND cancel (run #2's deletion-cancel). No schedule
    // either (no medications to schedule).
    cancelResolvers[1]();
    await Promise.resolve();
    expect(scheduleSpy).not.toHaveBeenCalled();

    // cancelCriticalAlarm must have been called for med-deleted (twice:
    // once by run #1, once by run #2's deletion path).
    expect(mocks.cancel).toHaveBeenCalledWith('med-deleted');
    expect(mocks.cancel.mock.calls.filter((c) => c[0] === 'med-deleted')).toHaveLength(2);
  });

  it('a successful first schedule followed by a state change schedules both (no false bail)', async () => {
    // Sanity: the generation guard must NOT bail when runs are
    // sequential (first run completes before the second starts). In
    // that case, both schedules fire — the final one is the latest.
    const medState1 = makeMed({ id: 'med-seq', currentPills: 30, dailyDose: 1 });
    const medState2 = makeMed({ id: 'med-seq', currentPills: 60, dailyDose: 1 });

    const { rerender } = renderHook(
      ({ medications }) =>
        useCriticalAlarmScheduler(defaultOpts({ medications })),
      {
        initialProps: { medications: [medState1] as Medication[] },
      }
    );

    // Run #1 completes fully (cancel + schedule both fire).
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const firstDate = mocks.schedule.mock.calls[0][2] as number;

    // Trigger a state change. Run #2 starts.
    rerender({ medications: [medState2] as Medication[] });

    // Run #2 completes fully (cancel + schedule both fire).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // schedule called twice — the latest call has the new date.
    expect(mocks.schedule.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = mocks.schedule.mock.calls[mocks.schedule.mock.calls.length - 1];
    const lastDate = lastCall[2] as number;
    // lastDate (D2, ~58 days out) > firstDate (D1, ~28 days out).
    expect(lastDate).toBeGreaterThan(firstDate);
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

// Re-import to suppress the unused-import lint warning on the
// notifications module symbols (the actual exports are replaced by
// the hoisted mocks above, but we still need the import for type
// inference on vi.mocked() assertions elsewhere in this file).
void scheduleCriticalAlarm;
void cancelCriticalAlarm;
