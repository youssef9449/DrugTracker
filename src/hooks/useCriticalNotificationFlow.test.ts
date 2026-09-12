/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { Medication } from '../types';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '../utils/criticalNotificationClaims';
import { useStockAlerts } from './useStockAlerts';
import { useCriticalAlarmScheduler } from './useCriticalAlarmScheduler';

// Integration tests: both hooks mounted together, exactly like App.tsx
// wires them (useStockAlerts first, then useCriticalAlarmScheduler).
// These verify the END-TO-END business rule: at most ONE critical-stock
// notification per continuous Critical/Out-of-Stock episode, with no
// duplicates across restarts, early crossings, or refill cycles.

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

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../utils/notifications')>(
    '../utils/notifications'
  );
  return {
    ...actual,
    sendCriticalStockAlert: mocks.send,
    scheduleCriticalAlarm: mocks.schedule,
    cancelCriticalAlarm: mocks.cancel,
  };
});

import { sendCriticalStockAlert } from '../utils/notifications';

const sendMock = vi.mocked(sendCriticalStockAlert);
const scheduleMock = vi.mocked(mocks.schedule);
const cancelMock = vi.mocked(mocks.cancel);

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

function useBothHooks(props: {
  medications: Medication[];
  notificationsEnabled?: boolean;
  criticalStockAlertsEnabled?: boolean;
}) {
  useStockAlerts({
    medications: props.medications,
    notificationsEnabled: props.notificationsEnabled ?? true,
    criticalStockAlertsEnabled: props.criticalStockAlertsEnabled ?? true,
    hydrated: true,
    isFirstRun: false,
  });
  useCriticalAlarmScheduler({
    medications: props.medications,
    notificationsEnabled: props.notificationsEnabled ?? true,
    criticalStockAlertsEnabled: props.criticalStockAlertsEnabled ?? true,
    hydrated: true,
    isFirstRun: false,
  });
}

function readClaims(): Record<string, { claimed: boolean; alarmTime: number | null }> {
  return JSON.parse(localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY) || '{}');
}

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  sendMock.mockResolvedValue(true);
  scheduleMock.mockResolvedValue(true);
  cancelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('critical notification flow — both hooks integrated', () => {
  it('sufficient → alarm armed → early crossing → exactly ONE notification, no duplicates', async () => {
    const sufficient = makeMed({ currentPills: 30 });
    const projectedT = getCriticalAlarmDate(sufficient, getTodayDateString()) as number;

    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });
    await flush();

    // The scheduler armed the future alarm and claimed it; the
    // foreground sent nothing (med is sufficient).
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: projectedT });
    expect(sendMock).not.toHaveBeenCalled();

    // Early crossing (manual consumption) while the alarm is still
    // future: the foreground releases the stale alarm and sends exactly
    // one notification for this episode.
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    rerender({ medications: [critical] });
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Re-renders while still critical (same episode) never duplicate.
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('alarm fired while the app was closed → app restart → NO duplicate', async () => {
    // State as left by a previous session: the med crossed, the scheduled
    // alarm's window passed (fired while the app was closed or missed).
    localStorage.setItem(
      CRITICAL_CLAIMS_STORAGE_KEY,
      JSON.stringify({ 'med-1': { claimed: true, alarmTime: Date.now() - 3_600_000 } })
    );
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });

    // First launch after the restart.
    const first = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [critical] },
    });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    first.unmount();

    // Repeated restarts stay quiet too.
    const second = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [critical] },
    });
    await flush();
    expect(sendMock).not.toHaveBeenCalled();
    second.unmount();
  });

  it('critical → refill → critical again: exactly one NEW notification for the new episode', async () => {
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [critical] },
    });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1); // episode 1 notified
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Refill → sufficient. The scheduler re-arms the alarm for the next
    // projected crossing and the claim transfers to it.
    const refilled = makeMed({ currentPills: 40, warningThresholdDays: 5 });
    const nextT = getCriticalAlarmDate(refilled, getTodayDateString()) as number;
    rerender({ medications: [refilled] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1); // no duplicate on refill
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: nextT });

    // Stock drops into the critical zone again → new episode → the
    // still-future claimed alarm is released and exactly one new
    // notification fires.
    const criticalAgain = makeMed({ currentPills: 4, warningThresholdDays: 5 });
    rerender({ medications: [criticalAgain] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Still critical → quiet.
    rerender({ medications: [{ ...criticalAgain }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('scheduler/foreground race: a med that crosses while its schedule is in flight produces at most one notification', async () => {
    // Simulate the race window: the scheduler's schedule call resolves
    // AFTER the medications array already shows the med critical.
    let resolveSchedule: (v: boolean) => void = () => undefined;
    scheduleMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveSchedule = resolve;
        })
    );

    const sufficient = makeMed({ currentPills: 30 });
    const { rerender } = renderHook((props) => useBothHooks(props), {
      initialProps: { medications: [sufficient] },
    });
    await flush();
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    // The med crosses while the schedule is still pending. The
    // foreground hook runs on this render: claim not yet written → it
    // sends the one notification and claims the episode.
    const critical = makeMed({ currentPills: 3, warningThresholdDays: 5 });
    rerender({ medications: [critical] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // The in-flight schedule now resolves — stale. The scheduler must
    // not overwrite the foreground's claim.
    resolveSchedule(true);
    await flush();

    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
    // The scheduler compensated by cancelling the alarm it armed.
    expect(cancelMock).toHaveBeenCalledWith('med-1');
    // Still exactly one user-facing notification.
    rerender({ medications: [{ ...critical }] });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
