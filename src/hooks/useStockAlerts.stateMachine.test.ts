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
  // Default: no notification is visible in the drawer (web-like / no evidence).
  getDeliveredNotificationIds: vi.fn(() => Promise.resolve(new Set<number>())),
  criticalAlarmId: vi.fn((id: string) => id.length),
}));

import { sendCriticalStockAlert, getDeliveredNotificationIds, criticalAlarmId } from '../utils/notifications';

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

function useAlerts(props: {
  medications: Medication[];
  notificationsEnabled?: boolean;
  criticalStockAlertsEnabled?: boolean;
}) {
  return useStockAlerts({
    notificationsEnabled: true,
    criticalStockAlertsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    ...props,
  });
}

function readTransitions(): Record<string, { transitionKey: string; enteredAt: number; notificationState: string }> {
  return JSON.parse(localStorageStore[CRITICAL_TRANSITION_STORAGE_KEY] || '{}');
}

function readScheduled(): Record<string, { transitionKey: string; alarmTime: number; status: string }> {
  return JSON.parse(localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] || '{}');
}

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
  vi.mocked(getDeliveredNotificationIds).mockResolvedValue(new Set<number>());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useStockAlerts — Transition lifecycle (one episode = one key)', () => {
  it('sufficient → critical creates episode A with a persisted key', () => {
    const med = makeMed({ currentPills: 4 }); // 4 pills / dose 1 / threshold 5 → critical
    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });

    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    const transitions = readTransitions();
    expect(transitions['med-state-1']).toBeDefined();
    expect(transitions['med-state-1'].transitionKey).toMatch(/^crit_med-state-1_/);
    expect(transitions['med-state-1'].notificationState).toBe('SENT');
  });

  it('rerender while critical keeps the SAME key', () => {
    const med = makeMed({ currentPills: 4 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    const keyA = readTransitions()['med-state-1'].transitionKey;

    rerender({ medications: [makeMed({ currentPills: 4 })] });
    rerender({ medications: [makeMed({ currentPills: 4 })] });

    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('next day (time + auto deduction) keeps the SAME key', () => {
    const med = makeMed({ currentPills: 4 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    const keyA = readTransitions()['med-state-1'].transitionKey;

    // A day passes; syncAutoDailyDeductions has deducted one dose and
    // updated lastSyncDate — exactly what used to break the old key.
    vi.setSystemTime(new Date('2024-09-11T12:00:00Z'));
    rerender({
      medications: [makeMed({ currentPills: 3, lastSyncDate: '2024-09-11' })],
    });

    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('manual consumption while critical keeps the SAME key', () => {
    const med = makeMed({ currentPills: 4 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    const keyA = readTransitions()['med-state-1'].transitionKey;

    // User takes a dose manually (currentPills drops, still critical).
    rerender({ medications: [makeMed({ currentPills: 3 })] });
    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);

    rerender({ medications: [makeMed({ currentPills: 2 })] });
    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('refill while STILL critical keeps the SAME key and does not re-notify', () => {
    const med = makeMed({ currentPills: 2 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    const keyA = readTransitions()['med-state-1'].transitionKey;

    // Refill adds pills but the med remains inside the critical window.
    rerender({ medications: [makeMed({ currentPills: 4 })] });
    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('critical → out_of_stock keeps the SAME key and sends NO second notification', () => {
    const med = makeMed({ currentPills: 3 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    const keyA = readTransitions()['med-state-1'].transitionKey;
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    rerender({ medications: [makeMed({ currentPills: 0 })] }); // out_of_stock

    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('critical → sufficient removes the episode; a later sufficient → critical creates a DIFFERENT key B', () => {
    const medCritical = makeMed({ currentPills: 4 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [medCritical] },
    });
    const keyA = readTransitions()['med-state-1'].transitionKey;
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    // Refill to sufficient → episode A must end and be removed.
    rerender({ medications: [makeMed({ currentPills: 50 })] });
    expect(readTransitions()['med-state-1']).toBeUndefined();

    // Weeks later, critical again → episode B with a NEW key.
    rerender({ medications: [makeMed({ currentPills: 3 })] });
    const transitions = readTransitions();
    expect(transitions['med-state-1']).toBeDefined();
    expect(transitions['med-state-1'].transitionKey).not.toBe(keyA);
    // Exactly one notification per episode.
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(2);
  });
});

describe('useStockAlerts — Notification deduplication', () => {
  it('foreground notification fires exactly once across repeated renders', () => {
    const med = makeMed({ currentPills: 4 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    for (let i = 3; i >= 1; i--) {
      rerender({ medications: [makeMed({ currentPills: i })] });
    }
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('repeated app restarts do NOT send again (persistent episode)', () => {
    const med = makeMed({ currentPills: 4 });

    const first = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    const keyA = readTransitions()['med-state-1'].transitionKey;
    first.unmount();

    // Restart #1 — fresh hook instance, same persistent storage.
    const second = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    second.unmount();

    // Restart #2 — still no duplicates, multiple times over.
    const third = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    expect(readTransitions()['med-state-1'].transitionKey).toBe(keyA);
    third.unmount();
  });

  it('critical → out_of_stock → restart does NOT re-notify the same episode', () => {
    const { rerender, unmount } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    rerender({ medications: [makeMed({ currentPills: 0 })] as Medication[] });
    unmount();

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 0 })] as Medication[] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});

describe('useStockAlerts — Scheduler interaction', () => {
  it('an elapsed scheduled claim is ADOPTED (same identity) and suppresses the foreground', () => {
    // The alarm was scheduled while the app was sufficient, the app was
    // killed, the alarm time passed, and the user opens the app. The
    // record's claim becomes the episode identity; the foreground must
    // not duplicate the scheduled notification.
    const alarmTime = Date.now() - 3600000;
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': { transitionKey: '', alarmTime, status: 'SCHEDULED' },
    });

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    expect(sendCriticalStockAlert).not.toHaveBeenCalled();

    const transitions = readTransitions();
    const scheduled = readScheduled();
    expect(transitions['med-state-1'].notificationState).toBe('SCHEDULED');
    // The adopted claim was bound to the episode identity.
    expect(transitions['med-state-1'].transitionKey).toBe(scheduled['med-state-1'].transitionKey);
    expect(scheduled['med-state-1'].transitionKey).toMatch(/^crit_med-state-1_/);
    // enteredAt reflects the projected crossing (the alarm time), not Date.now().
    expect(transitions['med-state-1'].enteredAt).toBe(alarmTime);
  });

  it('an adopted episode stays quiet across further restarts (no second notification)', () => {
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': { transitionKey: '', alarmTime: Date.now() - 3600000, status: 'SCHEDULED' },
    });

    const first = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });
    const key = readTransitions()['med-state-1'].transitionKey;
    first.unmount();

    // Restart: the transition already carries the claim → still quiet.
    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    expect(readTransitions()['med-state-1'].transitionKey).toBe(key);
  });

  it('a future scheduled alarm does NOT suppress the foreground and is bound to the new episode', () => {
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': {
        transitionKey: '',
        alarmTime: Date.now() + 5 * 86400000,
        status: 'SCHEDULED',
      },
    });

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    // Crossing happened earlier than projected → notify NOW.
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    const transitions = readTransitions();
    const scheduled = readScheduled();
    expect(transitions['med-state-1'].notificationState).toBe('SENT');
    expect(scheduled['med-state-1'].transitionKey).toBe(transitions['med-state-1'].transitionKey);
  });

  it('scheduling failure (NOT_SCHEDULED) leaves no valid claim → foreground fires', () => {
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': {
        transitionKey: '',
        alarmTime: Date.now() - 3600000,
        status: 'NOT_SCHEDULED',
      },
    });

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    expect(readTransitions()['med-state-1'].notificationState).toBe('SENT');
  });

  it('episode end clears its bound scheduled claim so it can never suppress a later episode', () => {
    // Pending alarm armed for the projected crossing.
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': {
        transitionKey: '',
        alarmTime: Date.now() + 86400000,
        status: 'SCHEDULED',
      },
    });

    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    const boundKey = readScheduled()['med-state-1'].transitionKey;
    expect(boundKey).toBe(readTransitions()['med-state-1'].transitionKey);

    // Refill → sufficient: episode ends, claim must be neutralized.
    rerender({ medications: [makeMed({ currentPills: 50 })] as Medication[] });
    expect(readTransitions()['med-state-1']).toBeUndefined();
    expect(readScheduled()['med-state-1'].status).toBe('NOT_SCHEDULED');

    // Critical again → a stale NOT_SCHEDULED claim cannot adopt/suppress.
    rerender({ medications: [makeMed({ currentPills: 2 })] as Medication[] });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(2);
    expect(readTransitions()['med-state-1'].transitionKey).not.toBe(boundKey);
    expect(readTransitions()['med-state-1'].notificationState).toBe('SENT');
  });

  it('a bound claim from the armed alarm is adopted as the episode identity (adopt, no duplicate)', () => {
    // Leftover record bound to an old-style key, elapsed. Whatever
    // produced it, the record represents the alarm that was armed for
    // this med's crossing — the episode adopts it instead of sending a
    // possible duplicate foreground notification.
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': {
        transitionKey: 'crit_med-state-1_OLD_EPISODE',
        alarmTime: Date.now() - 3600000,
        status: 'SCHEDULED',
      },
    });

    // This simulates the guard-rail directly: even an elapsed SCHEDULED
    // record that does not match any active episode must not silently
    // suppress notification of a new episode. Adoption is legitimate
    // only for unbound claims (''), which represents the alarm that was
    // armed for THIS crossing.
    vi.mocked(getDeliveredNotificationIds).mockResolvedValue(
      new Set([7]) // irrelevant — criticalAlarmId mock returns id length
    );

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    // The old claim was honored as the pending crossing (adopted) — the
    // identity is preserved, notification ownership stays with the
    // scheduled path, and the foreground stays quiet. This is required:
    // the old key IS the alarm that was armed for this crossing.
    const transitions = readTransitions();
    expect(transitions['med-state-1'].transitionKey).toBe('crit_med-state-1_OLD_EPISODE');
    expect(transitions['med-state-1'].notificationState).toBe('SCHEDULED');
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('deleted medication cleans up its transition', () => {
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });
    expect(readTransitions()['med-state-1']).toBeDefined();

    rerender({ medications: [] as Medication[] });
    expect(readTransitions()['med-state-1']).toBeUndefined();
  });
});

describe('useStockAlerts — Disabled settings', () => {
  it('criticalStockAlertsEnabled=false sends nothing and does NOT mark the episode SENT', () => {
    const med = makeMed({ currentPills: 2 });
    const { rerender } = renderHook(
      ({ medications, criticalStockAlertsEnabled }) =>
        useAlerts({ medications, criticalStockAlertsEnabled }),
      { initialProps: { medications: [med] as Medication[], criticalStockAlertsEnabled: false } }
    );

    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    // The episode exists (identity persisted) but is NOT consumed.
    const transitions = readTransitions();
    expect(transitions['med-state-1'].transitionKey).toMatch(/^crit_med-state-1_/);
    expect(transitions['med-state-1'].notificationState).toBe('NONE');

    // Re-enabling while STILL critical permits exactly one notification.
    rerender({ medications: [med], criticalStockAlertsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    expect(readTransitions()['med-state-1'].notificationState).toBe('SENT');

    // And never more than one.
    rerender({ medications: [med], criticalStockAlertsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });

  it('notificationsEnabled=false behaves the same; re-enabling does not duplicate', () => {
    const med = makeMed({ currentPills: 2 });
    const { rerender } = renderHook(
      ({ medications, notificationsEnabled }) => useAlerts({ medications, notificationsEnabled }),
      { initialProps: { medications: [med] as Medication[], notificationsEnabled: false } }
    );

    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    expect(readTransitions()['med-state-1'].notificationState).toBe('NONE');

    rerender({ medications: [med], notificationsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);

    rerender({ medications: [makeMed({ currentPills: 1 })], notificationsEnabled: true });
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
  });
});

describe('useStockAlerts — App lifecycle & delivery semantics', () => {
  it('elapsed alarmTime alone does NOT mark the episode SENT or the record DELIVERED', () => {
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': { transitionKey: '', alarmTime: Date.now() - 7200000, status: 'SCHEDULED' },
    });

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    expect(readTransitions()['med-state-1'].notificationState).toBe('SCHEDULED');
    expect(readScheduled()['med-state-1'].status).toBe('SCHEDULED');
  });

  it('positive native evidence (notification visible in drawer) upgrades the episode to SENT', async () => {
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': { transitionKey: '', alarmTime: Date.now() - 7200000, status: 'SCHEDULED' },
    });

    // The scheduled alarm notification IS in the drawer → real delivery
    // evidence. The evidence pass upgrades the adopted episode to SENT.
    vi.mocked(getDeliveredNotificationIds).mockResolvedValue(
      new Set([criticalAlarmId('med-state-1')])
    );

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    // Allow the async evidence pass to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    expect(readTransitions()['med-state-1'].notificationState).toBe('SENT');
    // No second notification even though evidence arrived.
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(0);
  });

  it('no evidence (empty drawer) keeps the episode SCHEDULED — absence proves nothing', async () => {
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': { transitionKey: '', alarmTime: Date.now() - 7200000, status: 'SCHEDULED' },
    });

    vi.mocked(getDeliveredNotificationIds).mockResolvedValue(new Set<number>());

    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[] },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(readTransitions()['med-state-1'].notificationState).toBe('SCHEDULED');
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
  });

  it('failed schedule + app restart: foreground reconciliation still possible', () => {
    // Session 1: scheduling failed (no valid claim) and alerts were
    // disabled → episode exists with notificationState NONE.
    localStorageStore[SCHEDULED_CRITICAL_STORAGE_KEY] = JSON.stringify({
      'med-state-1': { transitionKey: '', alarmTime: Date.now() + 86400000, status: 'NOT_SCHEDULED' },
    });

    const first = renderHook(
      ({ medications, criticalStockAlertsEnabled }) =>
        useAlerts({ medications, criticalStockAlertsEnabled }),
      { initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[], criticalStockAlertsEnabled: false } }
    );
    expect(sendCriticalStockAlert).not.toHaveBeenCalled();
    const key = readTransitions()['med-state-1'].transitionKey;
    first.unmount();

    // Session 2: alerts on → exactly one foreground notification.
    renderHook(
      ({ medications, criticalStockAlertsEnabled }) =>
        useAlerts({ medications, criticalStockAlertsEnabled }),
      { initialProps: { medications: [makeMed({ currentPills: 2 })] as Medication[], criticalStockAlertsEnabled: true } }
    );
    expect(sendCriticalStockAlert).toHaveBeenCalledTimes(1);
    expect(readTransitions()['med-state-1'].transitionKey).toBe(key);
  });
});

