/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../types';
import { useStockAlerts } from './useStockAlerts';
import { getTodayDateString, getCriticalTransitionKey } from '../utils/dateCalculations';

vi.mock('../utils/notifications', () => ({
  sendCriticalStockAlert: vi.fn(),
}));

vi.mock('../utils/storage', () => ({
  loadJson: vi.fn(<T,>(_key: string, fallback: T): T => fallback),
  saveJson: vi.fn(),
}));

import { sendCriticalStockAlert } from '../utils/notifications';
import { loadJson } from '../utils/storage';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 30,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  vi.mocked(loadJson).mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStockAlerts — basic', () => {
  it('does NOT fire when hydrated is false', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: false,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire on first run', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: true,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire when notifications are disabled', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: false,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire when med is sufficient (8 days > threshold 7)', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 8, dailyDose: 1, warningThresholdDays: 7 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('fires ONE critical alert when med transitions to critical (7 days ≤ threshold 7)', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('fires ONE critical alert when med transitions to out_of_stock', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});

describe('useStockAlerts — dedup (no duplicate notifications)', () => {
  it('does NOT re-fire on re-render for the same critical transition', () => {
    const med = makeMed({ currentPills: 0, dailyDose: 1 });
    const { rerender } = renderHook(
      ({ medications }) =>
        useStockAlerts({
          medications,
          notificationsEnabled: true,
          criticalStockAlertsEnabled: true,
          hydrated: true,
          isFirstRun: false,
        }),
      { initialProps: { medications: [med] } }
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    rerender({ medications: [med] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire after app restart (persistent dedup via transition key)', () => {
    // Simulate: a previous session persisted the notified transition key.
    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-10' });
    // Compute what the transition key would be and persist it.
    const transitionKey = getCriticalTransitionKey(med, '2024-09-10');
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'android_med_tracker_critical_notified_v2') {
        return { 'med-1': transitionKey };
      }
      return fallback;
    });

    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    // Already notified for this exact transition → no new alert.
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('fires again after critical → sufficient → critical (new transition key)', () => {
    const criticalMed = makeMed({ currentPills: 1, dailyDose: 1 });
    const { rerender } = renderHook(
      ({ medications }) =>
        useStockAlerts({
          medications,
          notificationsEnabled: true,
          criticalStockAlertsEnabled: true,
          hydrated: true,
          isFirstRun: false,
        }),
      { initialProps: { medications: [criticalMed] } }
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Refill → sufficient (different lastSyncDate → different transition key).
    const sufficientMed = makeMed({ currentPills: 100, dailyDose: 1, lastSyncDate: '2024-09-11' });
    rerender({ medications: [sufficientMed] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Drop back to critical → new transition → fire again.
    const criticalAgain = makeMed({ currentPills: 1, dailyDose: 1, lastSyncDate: '2024-09-11' });
    rerender({ medications: [criticalAgain] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(2);
  });
});

describe('useStockAlerts — criticalStockAlertsEnabled behavior', () => {
  it('does NOT mark transition as notified when criticalStockAlertsEnabled is false', () => {
    const med = makeMed({ currentPills: 0, dailyDose: 1 });
    const { rerender } = renderHook(
      ({ criticalStockAlertsEnabled }) =>
        useStockAlerts({
          medications: [med],
          notificationsEnabled: true,
          criticalStockAlertsEnabled,
          hydrated: true,
          isFirstRun: false,
        }),
      { initialProps: { criticalStockAlertsEnabled: false } }
    );
    // No notification sent (critical alerts disabled).
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();

    // Enable critical alerts — now the transition should fire.
    rerender({ criticalStockAlertsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Re-render — should NOT fire again.
    rerender({ criticalStockAlertsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});

describe('useStockAlerts — scheduled alarm reconciliation', () => {
  it('does NOT fire foreground notification when scheduled alarm already delivered', () => {
    // Simulate: a scheduled alarm was set for med-1, and the alarm date
    // has passed. The scheduler persisted the transition key + alarmTime.
    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-09' });
    const transitionKey = getCriticalTransitionKey(med, '2024-09-10');

    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'android_med_tracker_scheduled_critical_v1') {
        // Return the NEW format: { transitionKey, alarmTime }
        // alarmTime is in the past (1 day before the pinned test time).
        return { 'med-1': { transitionKey, alarmTime: Date.now() - 86400000 } };
      }
      return fallback;
    });

    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    // The scheduled alarm already fired → reconciliation marks as notified
    // → foreground does NOT fire.
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });
});

describe('useStockAlerts — threshold semantics', () => {
  it('threshold 7: 7 days is critical, 8 days is sufficient', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('threshold 7: 8 days does NOT fire', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 8, dailyDose: 1, warningThresholdDays: 7 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('threshold 7: 6 days is still critical (no additional notification)', () => {
    const med = makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 });
    const { rerender } = renderHook(
      ({ medications }) =>
        useStockAlerts({
          medications,
          notificationsEnabled: true,
          criticalStockAlertsEnabled: true,
          hydrated: true,
          isFirstRun: false,
        }),
      { initialProps: { medications: [med] } }
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Advance to 6 days — same transition, no new notification.
    const med2 = makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 7, lastSyncDate: '2024-09-11' });
    vi.setSystemTime(new Date('2024-09-11T12:00:00Z'));
    rerender({ medications: [med2] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});
