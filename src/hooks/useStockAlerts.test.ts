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
  getDeliveredNotificationIds: vi.fn(() => Promise.resolve(new Set<number>())),
  criticalAlarmId: vi.fn((id: string) => id.length),
}));

vi.mock('../utils/storage', () => ({
  loadJson: vi.fn(<T,>(_key: string, fallback: T): T => fallback),
  saveJson: vi.fn(),
  loadString: vi.fn((_key: string, fallback: string): string => fallback),
}));

import { sendCriticalStockAlert } from '../utils/notifications';
import { loadJson, saveJson } from '../utils/storage';

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

  it('does NOT re-fire after app restart (persistent v2 transition with SENT state)', () => {
    // Simulate: a previous session persisted the active episode as SENT.
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === CRITICAL_TRANSITION_STORAGE_KEY) {
        return {
          'med-1': {
            transitionKey: 'crit_med-1_1725969600000_abc123',
            enteredAt: 1725969600000,
            notificationState: 'SENT',
          },
        };
      }
      return fallback;
    });

    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-10' });
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

  it('does NOT re-fire after app restart with legacy notified map (migration keeps dedup)', () => {
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === 'android_med_tracker_critical_notified_v2') {
        return { 'med-1': 'crit_med-1_legacy_key' };
      }
      return fallback;
    });

    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-10' });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('fires again after critical → sufficient → critical (new episode)', () => {
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

    // Refill → sufficient.
    const sufficientMed = makeMed({ currentPills: 100, dailyDose: 1, lastSyncDate: '2024-09-11' });
    rerender({ medications: [sufficientMed] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Drop back to critical → new episode → fire again.
    const criticalAgain = makeMed({ currentPills: 1, dailyDose: 1, lastSyncDate: '2024-09-11' });
    rerender({ medications: [criticalAgain] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(2);
  });
});

describe('useStockAlerts — criticalStockAlertsEnabled behavior', () => {
  it('does NOT mark transition as SENT when criticalStockAlertsEnabled is false', () => {
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

    // Enable critical alerts — now the episode should fire exactly once.
    rerender({ criticalStockAlertsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Re-render — should NOT fire again.
    rerender({ criticalStockAlertsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});

describe('useStockAlerts — scheduled alarm claim (strict delivery semantics)', () => {
  it('does NOT fire foreground notification when an elapsed scheduled claim exists', () => {
    // A scheduled alarm was registered for med-1 and its alarm time has
    // passed. The alarm is the authoritative notification path for the
    // episode → foreground must stay quiet.
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === SCHEDULED_CRITICAL_STORAGE_KEY) {
        return {
          'med-1': {
            transitionKey: '',
            alarmTime: Date.now() - 86400000, // elapsed
            status: 'SCHEDULED',
          },
        };
      }
      return fallback;
    });

    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-09' });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('elapsed alarmTime does NOT prove delivery: record stays SCHEDULED, episode is adopted as SCHEDULED (never SENT/DELIVERED)', () => {
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === SCHEDULED_CRITICAL_STORAGE_KEY) {
        return {
          'med-1': {
            transitionKey: '',
            alarmTime: Date.now() - 86400000,
            status: 'SCHEDULED',
          },
        };
      }
      return fallback;
    });

    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-09' });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );

    expect(sendCriticalStockAlert).not.toHaveBeenCalled();

    // The adopted episode must be SCHEDULED — NOT 'SENT' — because a
    // passed timestamp is not proof that Android displayed anything.
    const transitionsWrite = vi
      .mocked(saveJson)
      .mock.calls.find((c) => c[0] === CRITICAL_TRANSITION_STORAGE_KEY);
    expect(transitionsWrite).toBeDefined();
    const persisted = transitionsWrite![1] as Record<string, { notificationState: string }>;
    expect(persisted['med-1'].notificationState).toBe('SCHEDULED');

    // The scheduled record itself must NOT be flipped to DELIVERED.
    const scheduledWrite = vi
      .mocked(saveJson)
      .mock.calls.find((c) => c[0] === SCHEDULED_CRITICAL_STORAGE_KEY);
    expect(scheduledWrite).toBeDefined();
    const persistedRec = scheduledWrite![1] as Record<string, { status: string }>;
    expect(persistedRec['med-1'].status).toBe('SCHEDULED');
  });

  it('a future scheduled alarm does NOT suppress the foreground notification', () => {
    // The crossing happened EARLIER than projected (user consumed more
    // than planned). The pending alarm is stale — the user must be
    // notified NOW, not when the stale alarm fires.
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === SCHEDULED_CRITICAL_STORAGE_KEY) {
        return {
          'med-1': {
            transitionKey: '',
            alarmTime: Date.now() + 5 * 86400000, // future
            status: 'SCHEDULED',
          },
        };
      }
      return fallback;
    });

    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-10' });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('a failed scheduling attempt (NOT_SCHEDULED) does NOT suppress the foreground notification', () => {
    vi.mocked(loadJson).mockImplementation((key: string, fallback: unknown) => {
      if (key === SCHEDULED_CRITICAL_STORAGE_KEY) {
        return {
          'med-1': {
            transitionKey: '',
            alarmTime: Date.now() - 86400000,
            status: 'NOT_SCHEDULED',
          },
        };
      }
      return fallback;
    });

    const med = makeMed({ currentPills: 0, dailyDose: 1, lastSyncDate: '2024-09-10' });
    renderHook(() =>
      useStockAlerts({
        medications: [med],
        notificationsEnabled: true,
        criticalStockAlertsEnabled: true,
        hydrated: true,
        isFirstRun: false,
      })
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
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

    // Advance to 6 days — same episode, no new notification.
    const med2 = makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 7, lastSyncDate: '2024-09-11' });
    vi.setSystemTime(new Date('2024-09-11T12:00:00Z'));
    rerender({ medications: [med2] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});
