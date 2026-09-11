/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../types';
import { useStockAlerts } from './useStockAlerts';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  CRITICAL_TRANSITION_STORAGE_KEY,
  SCHEDULED_CRITICAL_STORAGE_KEY,
} from '../utils/criticalTransitions';

vi.mock('../utils/notifications', () => ({
  sendCriticalStockAlert: vi.fn(),
}));

import { sendCriticalStockAlert } from '../utils/notifications';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-state-1',
    name: 'State Test Med',
    currentPills: 4,
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

describe('useStockAlerts — Persistent Critical Transition State Machine', () => {
  let localStorageStore: Record<string, string> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
    localStorageStore = {};

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      return localStorageStore[key] ?? null;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      localStorageStore[key] = value;
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key: string) => {
      delete localStorageStore[key];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. Sends exactly ONE notification for a continuous critical episode despite pill reductions', () => {
    const med1 = makeMed({ currentPills: 4 }); // 4 pills, threshold 5 -> critical
    const { rerender } = renderHook(
      ({ medications }) =>
        useStockAlerts({
          medications,
          notificationsEnabled: true,
          criticalStockAlertsEnabled: true,
          hydrated: true,
          isFirstRun: false,
        }),
      { initialProps: { medications: [med1] } }
    );

    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Pill balance drops to 3 (still critical)
    const med2 = makeMed({ currentPills: 3 });
    rerender({ medications: [med2] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Pill balance drops to 1 (still critical)
    const med3 = makeMed({ currentPills: 1 });
    rerender({ medications: [med3] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Pill balance drops to 0 (out_of_stock, same episode)
    const med4 = makeMed({ currentPills: 0 });
    rerender({ medications: [med4] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('2. Preserves transition across app restart using android_med_tracker_critical_transition_v1', () => {
    // Pre-populate storage as if a previous session already notified this critical episode
    const transitionData = {
      'med-state-1': {
        transitionKey: 'crit_med-state-1_1725969600000',
        enteredAt: 1725969600000,
        notificationSent: true,
      },
    };
    localStorageStore[CRITICAL_TRANSITION_STORAGE_KEY] = JSON.stringify(transitionData);

    const med = makeMed({ currentPills: 2 }); // critical
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );

    // Should NOT fire because session recovered the active critical episode with notificationSent: true
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('3. Refilling to sufficient clears the episode; dropping to critical again starts a NEW episode and notifies', () => {
    const medCritical = makeMed({ currentPills: 4 });
    const { rerender } = renderHook(
      ({ medications }) =>
        useStockAlerts({
          medications,
          notificationsEnabled: true,
          criticalStockAlertsEnabled: true,
          hydrated: true,
          isFirstRun: false,
        }),
      { initialProps: { medications: [medCritical] } }
    );

    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Refill to 50 pills (healthy/sufficient)
    const medSufficient = makeMed({ currentPills: 50 });
    rerender({ medications: [medSufficient] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Verify storage cleared the episode
    const storedAfterRefill = JSON.parse(localStorageStore[CRITICAL_TRANSITION_STORAGE_KEY] || '{}');
    expect(storedAfterRefill['med-state-1']).toBeUndefined();

    // Weeks later, pills drop to critical again
    const medCriticalAgain = makeMed({ currentPills: 3 });
    rerender({ medications: [medCriticalAgain] });

    // New episode! Exactly ONE more notification fires
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(2);
  });

  it('4. Background alarm delivery claims transition and suppresses foreground duplicate', () => {
    const alarmTime = Date.now() - 3600000; // 1 hour ago
    const scheduledRecords = {
      'med-state-1': {
        transitionKey: 'crit_med-state-1_scheduled_99',
        alarmTime,
        status: 'SCHEDULED',
      },
    };
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify(scheduledRecords);

    // App opens; med is critical
    const med = makeMed({ currentPills: 2 });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );

    // The foreground hook respects the alarm's delivery claim
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();

    // And marked as DELIVERED in scheduled store
    const updatedScheduled = JSON.parse(localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] || '{}');
    expect(updatedScheduled['med-state-1'].status).toBe('DELIVERED');

    // And saved in transitions as notificationSent: true
    const updatedTransitions = JSON.parse(localStorageStore[CRITICAL_TRANSITION_STORAGE_KEY] || '{}');
    expect(updatedTransitions['med-state-1'].notificationSent).toBe(true);
  });

  it('5. Failed or non-delivered scheduling does NOT suppress foreground notification', () => {
    // Scheduling failed or alarm is in the future
    const scheduledRecords = {
      'med-state-1': {
        transitionKey: 'crit_med-state-1_scheduled_future',
        alarmTime: Date.now() + 86400000 * 5, // 5 days in future
        status: 'NOT_SCHEDULED', // failed
      },
    };
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify(scheduledRecords);

    // User took extra doses manually, entering critical state early in foreground
    const med = makeMed({ currentPills: 1 });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );

    // Foreground MUST fire and not be suppressed by stale/failed scheduling!
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});
