/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../types';
import { useStockAlerts } from './useStockAlerts';
import { getTodayDateString } from '../utils/dateCalculations';

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
  // Default: no persisted notified state.
  vi.mocked(loadJson).mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStockAlerts', () => {
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

  it('fires ONE critical alert when med transitions to out_of_stock (no double)', () => {
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

  it('fires ONE critical alert when med transitions to critical (threshold = 5)', () => {
    // currentPills=5, dailyDose=1 → daysLeft=5 ≤ threshold 5 → critical
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 5, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when med is sufficient (daysLeft > threshold)', () => {
    // currentPills=30, dailyDose=1 → daysLeft=30 > threshold 5
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 30, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('does NOT re-fire for the same critical state (persistent dedup)', () => {
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

    // Re-render with the same medications — should NOT re-fire.
    rerender({ medications: [med] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('persists the notified state (survives app restart)', () => {
    // Simulate: notified state was persisted from a previous session.
    vi.mocked(loadJson).mockReturnValue({ 'med-1': true });

    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    // Already notified → no new alert.
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('clears notified state when med improves to sufficient, so later re-critical fires', () => {
    // Start with a critical med.
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

    // Refill → sufficient. saveJson should be called to clear the notified flag.
    const sufficientMed = makeMed({ currentPills: 100, dailyDose: 1 });
    rerender({ medications: [sufficientMed] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1); // no new alert on improvement

    // The saveJson call should have cleared med-1 from the notified map.
    // Simulate the next load reflecting the cleared state.
    vi.mocked(loadJson).mockReturnValue({});

    // Drop back to critical → should fire again.
    const criticalAgain = makeMed({ currentPills: 1, dailyDose: 1 });
    rerender({ medications: [criticalAgain] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(2);
  });

  it('threshold 7: 7 days is critical, 8 days is not', () => {
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

  it('threshold 7: 8 days does NOT fire (sufficient)', () => {
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
});
