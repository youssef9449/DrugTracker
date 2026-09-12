/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../types';
import { useStockAlerts } from './useStockAlerts';
import { getTodayDateString, getCriticalAlarmDate } from '../utils/dateCalculations';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '../utils/criticalNotificationClaims';

vi.mock('../utils/notifications', () => ({
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve()),
}));

import { sendCriticalStockAlert, cancelCriticalAlarm } from '../utils/notifications';

const sendMock = vi.mocked(sendCriticalStockAlert);
const cancelMock = vi.mocked(cancelCriticalAlarm);

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

function useAlerts(props: {
  medications: Medication[];
  notificationsEnabled?: boolean;
  criticalStockAlertsEnabled?: boolean;
  hydrated?: boolean;
  isFirstRun?: boolean;
}) {
  return useStockAlerts({
    notificationsEnabled: true,
    criticalStockAlertsEnabled: true,
    hydrated: true,
    isFirstRun: false,
    ...props,
  });
}

function readClaims(): Record<string, { claimed: boolean; alarmTime: number | null }> {
  return JSON.parse(localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY) || '{}');
}

function writeClaim(medId: string, claim: { claimed: boolean; alarmTime: number | null }) {
  const claims = readClaims();
  claims[medId] = claim;
  localStorage.setItem(CRITICAL_CLAIMS_STORAGE_KEY, JSON.stringify(claims));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  localStorage.clear();
  sendMock.mockResolvedValue(true);
  cancelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStockAlerts — gating', () => {
  it('does NOT fire when hydrated is false', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        hydrated: false,
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT fire on first run', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        isFirstRun: true,
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT fire when notifications are disabled, and does not mark the episode claimed', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        notificationsEnabled: false,
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']?.claimed).toBeFalsy();
  });

  it('does NOT fire when critical stock alerts are disabled, and does not mark claimed', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
        criticalStockAlertsEnabled: false,
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']?.claimed).toBeFalsy();
  });

  it('does NOT fire when med is sufficient (8 days > threshold 7)', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 8, dailyDose: 1, warningThresholdDays: 7 })],
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toBeUndefined();
  });
});

describe('useStockAlerts — one notification per critical episode', () => {
  it('fires ONE critical alert when the med becomes critical, and persists the claim', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      })
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('fires for out_of_stock too (0 pills)', () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 0, dailyDose: 1 })],
      })
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('does NOT duplicate on re-render while still critical', () => {
    const med = makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    rerender({ medications: [{ ...med }] });
    rerender({ medications: [{ ...med }] });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT duplicate when a day passes / balance changes while still critical (same episode)', async () => {
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: {
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A day passes and auto-deduction consumed a pill: still critical.
    vi.setSystemTime(new Date('2024-09-11T12:00:00Z'));
    rerender({
      medications: [
        makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 7, lastSyncDate: '2024-09-11' }),
      ],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Manual consumption while critical.
    rerender({
      medications: [
        makeMed({ currentPills: 3, dailyDose: 1, warningThresholdDays: 7, lastSyncDate: '2024-09-11' }),
      ],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Critical → out_of_stock: same episode, no second notification.
    rerender({
      medications: [
        makeMed({ currentPills: 0, dailyDose: 1, warningThresholdDays: 7, lastSyncDate: '2024-09-11' }),
      ],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT duplicate after an app restart while still critical (claim persists)', () => {
    // First launch.
    const first = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: {
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // Second launch (app restart): claim loaded from storage → quiet.
    renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: {
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('allows a NEW notification after Critical → Sufficient → Critical (new episode)', () => {
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: {
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });

    // Refill → sufficient. This hook OWNS the episode end: the claim is
    // cleared SYNCHRONOUSLY on this very render — no manual storage
    // edits, no waiting for any async scheduler cleanup.
    rerender({
      medications: [
        makeMed({ currentPills: 40, dailyDose: 1, warningThresholdDays: 7 }),
      ],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toBeUndefined();

    // Stock drops again → new critical episode → exactly one new notification.
    rerender({
      medications: [
        makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 7 }),
      ],
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('changing currentPills / lastSyncDate does not create a new episode while critical', () => {
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: {
        medications: [makeMed({ currentPills: 4, dailyDose: 1, warningThresholdDays: 5 })],
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    for (const pills of [3, 2, 1]) {
      rerender({
        medications: [
          makeMed({ currentPills: pills, dailyDose: 1, warningThresholdDays: 5 }),
        ],
      });
    }
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('useStockAlerts — claim backed by a scheduled alarm', () => {
  it('stays quiet when the claim came from a scheduled alarm whose window has passed', () => {
    // Alarm was armed yesterday: fired while the app was closed (or was
    // missed). Delivery is NOT reconstructed — the claim stands.
    writeClaim('med-1', {
      claimed: true,
      alarmTime: Date.now() - 60 * 60 * 1000,
    });
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('releases a still-future claimed alarm and sends once when the med crossed early', async () => {
    // The alarm is armed for tomorrow, but the med is already critical
    // (early crossing). The alarm provably has not fired → release it
    // and send the one foreground notification now.
    writeClaim('med-1', {
      claimed: true,
      alarmTime: Date.now() + 24 * 60 * 60 * 1000,
    });
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      })
    );
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(cancelMock).toHaveBeenCalledWith('med-1');
    });
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('cancels any armed alarm after a successful foreground send', async () => {
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      })
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith('med-1');
    });
  });
});

describe('useStockAlerts — Sufficient clears the claim synchronously (episode ownership)', () => {
  it('clears a consumed claim immediately when the med becomes sufficient', () => {
    writeClaim('med-1', { claimed: true, alarmTime: null });
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 30, dailyDose: 1, warningThresholdDays: 5 })],
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toBeUndefined();
    // alarmTime was null — no armed alarm to cancel.
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('clears a stale still-future claim when sufficient and cancels the armed alarm it references', async () => {
    // Episode A ended (refill) while an alarm armed for its (early)
    // crossing was still pending: the claim is cleared synchronously and
    // the now-stale alarm is cancelled natively.
    writeClaim('med-1', { claimed: true, alarmTime: Date.now() + 24 * 60 * 60 * 1000 });
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 30, dailyDose: 1, warningThresholdDays: 5 })],
      })
    );
    // Cleared synchronously — before any async operation resolves.
    expect(readClaims()['med-1']).toBeUndefined();
    await vi.waitFor(() => {
      expect(cancelMock).toHaveBeenCalledWith('med-1');
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT touch the scheduler\u2019s live armed record (claim === current projection)', () => {
    const med = makeMed({ currentPills: 30, dailyDose: 1, warningThresholdDays: 5 });
    const projectedT = getCriticalAlarmDate(med, getTodayDateString()) as number;
    writeClaim('med-1', { claimed: true, alarmTime: projectedT });
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: { medications: [med] },
    });

    // Signature-neutral re-render: the live record (and the alarm it
    // books) must survive untouched.
    rerender({ medications: [{ ...med }] });

    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: projectedT });
    expect(cancelMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('clears an ended episode\u2019s claim even while notifications are disabled (bookkeeping, not notification)', () => {
    writeClaim('med-1', { claimed: true, alarmTime: null });
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 30, dailyDose: 1, warningThresholdDays: 5 })],
        notificationsEnabled: false,
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(readClaims()['med-1']).toBeUndefined();
  });

  it('a frozen sufficient med\u2019s stale claim is cleared synchronously; nothing live is cancelled', () => {
    writeClaim('med-1', { claimed: true, alarmTime: Date.now() - 86_400_000 });
    renderHook(() =>
      useAlerts({
        medications: [
          makeMed({
            currentPills: 30,
            dailyDose: 1,
            warningThresholdDays: 5,
            autoDeductEnabled: false,
          }),
        ],
      })
    );
    expect(readClaims()['med-1']).toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
    // alarmTime in the past — nothing live to cancel.
    expect(cancelMock).not.toHaveBeenCalled();
  });
});

describe('useStockAlerts — failures and cleanup', () => {
  it('does NOT leave the episode claimed when the send fails, so the fallback is never suppressed', async () => {
    sendMock.mockResolvedValueOnce(false);
    renderHook(() =>
      useAlerts({
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      })
    );
    await vi.waitFor(() => {
      expect(readClaims()['med-1']).toEqual({ claimed: false, alarmTime: null });
    });

    // A later pass (send now succeeds) can still notify exactly once.
    sendMock.mockResolvedValue(true);
    const { rerender } = renderHook(({ medications }) => useAlerts({ medications }), {
      initialProps: {
        medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      },
    });
    rerender({
      medications: [makeMed({ currentPills: 6, dailyDose: 1, warningThresholdDays: 7 })],
    });
    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenCalledTimes(2);
    });
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });

  it('removes the claim when the medication is deleted', () => {
    writeClaim('med-1', { claimed: true, alarmTime: null });
    writeClaim('med-other', { claimed: true, alarmTime: null });
    renderHook(() =>
      useAlerts({
        // med-other stays CRITICAL so its claim legitimately survives —
        // isolating the deletion cleanup from the Sufficient lifecycle
        // (a sufficient med's stale claim is cleared synchronously, see
        // the episode-ownership suite above).
        medications: [
          makeMed({ id: 'med-other', currentPills: 3, dailyDose: 1, warningThresholdDays: 5 }),
        ],
      })
    );
    const claims = readClaims();
    expect(claims['med-1']).toBeUndefined();
    expect(claims['med-other']).toEqual({ claimed: true, alarmTime: null });
  });
});

describe('useStockAlerts — threshold semantics (user-configured threshold only)', () => {
  it('warningThresholdDays = 7: 8 days sufficient, 7 critical, 6 critical, 0 out of stock', () => {
    const cases: Array<{ pills: number; expected: boolean }> = [
      { pills: 8, expected: false },
      { pills: 7, expected: true },
      { pills: 6, expected: true },
      { pills: 0, expected: true },
    ];
    for (const { pills, expected } of cases) {
      sendMock.mockClear();
      localStorage.clear();
      renderHook(() =>
        useAlerts({
          medications: [makeMed({ currentPills: pills, dailyDose: 1, warningThresholdDays: 7 })],
        })
      );
      if (expected) {
        expect(sendMock).toHaveBeenCalledTimes(1);
      } else {
        expect(sendMock).not.toHaveBeenCalled();
      }
    }
  });
});

describe('useStockAlerts — re-enabling alerts mid-episode', () => {
  it('disabling then re-enabling while still critical allows exactly one notification', () => {
    const { rerender } = renderHook(
      ({ medications, notificationsEnabled }) =>
        useAlerts({ medications, notificationsEnabled }),
      {
        initialProps: {
          medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
          notificationsEnabled: true,
        },
      }
    );
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Disabled: nothing sent, nothing claimed.
    rerender({
      medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      notificationsEnabled: false,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Re-enabled while STILL critical — the episode already consumed its
    // opportunity with the first send, so no duplicate.
    rerender({
      medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      notificationsEnabled: true,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('an episode that became critical while disabled notifies exactly once when re-enabled', () => {
    const { rerender } = renderHook(
      ({ medications, notificationsEnabled }) =>
        useAlerts({ medications, notificationsEnabled }),
      {
        initialProps: {
          medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
          notificationsEnabled: false,
        },
      }
    );
    expect(sendMock).not.toHaveBeenCalled();

    rerender({
      medications: [makeMed({ currentPills: 7, dailyDose: 1, warningThresholdDays: 7 })],
      notificationsEnabled: true,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-1']).toEqual({ claimed: true, alarmTime: null });
  });
});
