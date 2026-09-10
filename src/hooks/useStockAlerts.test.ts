/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../types';
import { useStockAlerts } from './useStockAlerts';
import { getTodayDateString } from '../utils/dateCalculations';

// Mock the notifications module so we can assert calls without triggering
// real Capacitor / Notification API calls.
vi.mock('../utils/notifications', () => ({
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(),
}));

import { sendMedicineAlert, sendCriticalStockAlert } from '../utils/notifications';

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
    // Default lastSyncDate to today so effectiveCurrentPills === currentPills
    // (no days-passed projection). Tests that exercise the dynamic balance
    // override lastSyncDate explicitly.
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Wave 13 #123: pin system time so getTodayDateString() (used by
  // makeMed's lastSyncDate default) resolves to a deterministic date.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
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
    expect(sendMedicineAlert).not.toHaveBeenCalled();
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire on first run (seed data)', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: true,
      })
    );
    expect(sendMedicineAlert).not.toHaveBeenCalled();
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
    expect(sendMedicineAlert).not.toHaveBeenCalled();
  });

  it('fires out_of_stock alerts when a med hits 0 pills (critical + general)', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    // Critical alert fired (criticalStockAlertsEnabled is true).
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    expect(sendCriticalStockAlert).toHaveBeenCalledWith('med-1', 'Test Med', 0, 0, 'قرص');
    // General low-stock alert also fired (separate drawer entry).
    expect(sendMedicineAlert).toHaveBeenCalledTimes(1);
    expect(sendMedicineAlert).toHaveBeenCalledWith('med-1', 'Test Med', 0, 0);
  });

  it('skips the critical alert when criticalStockAlertsEnabled is false (but still fires general)', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: false,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    expect(sendMedicineAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-fire for the same status (dedup via lastAlertedStatusRef)', () => {
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
    expect(sendMedicineAlert).toHaveBeenCalledTimes(1);

    // Re-render with the same medications — should NOT re-fire.
    rerender({ medications: [med] });
    expect(sendMedicineAlert).toHaveBeenCalledTimes(1);
  });

  it('clears the tracker when a med improves to sufficient, so a later worsening fires again', () => {
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
    expect(sendMedicineAlert).toHaveBeenCalledTimes(1);

    // Refill → sufficient.
    const sufficientMed = makeMed({ currentPills: 100, dailyDose: 1 });
    rerender({ medications: [sufficientMed] });
    expect(sendMedicineAlert).toHaveBeenCalledTimes(1); // no new alert on improvement

    // Drop back to critical → should fire again (tracker was cleared).
    const criticalAgain = makeMed({ currentPills: 1, dailyDose: 1 });
    rerender({ medications: [criticalAgain] });
    expect(sendMedicineAlert).toHaveBeenCalledTimes(2);
  });

  it('does NOT fire for a sufficient med', () => {
    renderHook(() =>
      useStockAlerts({
        medications: [makeMed({ currentPills: 100, dailyDose: 1 })],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendMedicineAlert).not.toHaveBeenCalled();
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });
});
