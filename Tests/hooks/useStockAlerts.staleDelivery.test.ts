import { requireDefined } from '../helpers/requireDefined';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Medication } from '@/types';
import { useStockAlerts } from '@/hooks/useStockAlerts';
import {
  bumpCriticalAlarmGeneration,
} from '@/utils/criticalAlarmOperations';

/**
 * #539 regression coverage: foreground Critical Stock delivery must
 * revalidate BEFORE and AFTER the async send against the LATEST medication
 * state, the current policy, and the operation generation — a stale
 * foreground operation must never deliver stale content, cancel a newer
 * scheduled fallback, or release a claim owned by a different operation.
 */

vi.mock('@/utils/notifications/criticalStockNotifications', () => ({
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/utils/criticalAlarmScheduling', () => ({
  cancelCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { sendCriticalStockAlert } from '@/utils/notifications/criticalStockNotifications';
import { cancelCriticalAlarm } from '@/utils/criticalAlarmScheduling';
import {
  readCriticalClaims,
  writeCriticalClaim,
} from '../helpers/criticalStockClaims';
import { installWebLocksShim } from '../helpers/webLocksShim';

const sendMock = vi.mocked(sendCriticalStockAlert);
const cancelMock = vi.mocked(cancelCriticalAlarm);

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 10,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    criticalStockAlertsEnabled: true,
    ...overrides,
  };
}

/** Deferred send so tests can hold delivery in flight. */
function deferSend(): { promise: Promise<boolean>; resolve: (v: boolean) => void } {
  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Lock manager whose request() blocks until explicitly opened: lets a test
 * land a medication-state change BETWEEN acquisition and the delivery
 * decision (pre-delivery revalidation window).
 */
function installGatedLocks() {
  let open = false;
  const waiters: Array<() => void> = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, cb: () => Promise<unknown>) => {
        if (!open) {
          await new Promise<void>((r) => waiters.push(r));
        }
        return cb();
      },
    },
  });
  return {
    open() {
      open = true;
      waiters.splice(0).forEach((r) => r());
    },
  };
}

/** Props surface exercised by this regression file (hook options subset). */
type UseAlertsProps = {
  medications: Medication[];
  criticalStockAlertsEnabled?: boolean;
};

function useAlerts(props: UseAlertsProps) {
  return useStockAlerts({
    medications: props.medications,
    criticalStockAlertsEnabled: props.criticalStockAlertsEnabled ?? true,
    hydrated: true,
    isFirstRun: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installWebLocksShim();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  localStorage.clear();
  sendMock.mockResolvedValue(true);
  cancelMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (navigator as unknown as { locks?: unknown }).locks;
});

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('#539 pre-delivery revalidation (state changed before delivery starts)', () => {
  it('refill landing before delivery starts: no stale send, in-flight claim released', async () => {
    const gated = installGatedLocks();
    const critical = makeMed({ currentPills: 10, dailyDose: 2 });
    const { rerender } = renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [critical] },
    });
    // Acquisition is gated — newer state arrives BEFORE delivery starts.
    rerender({ medications: [makeMed({ currentPills: 40, dailyDose: 2 })] });
    gated.open();
    await flush();

    expect(sendMock).not.toHaveBeenCalled();
    // The in-flight claim this pass owned is released (CAS), never leaked.
    expect(readCriticalClaims()['med-1']).toEqual({
      claimed: false,
      alarmTime: null,
    });
  });

  it('threshold change before delivery starts (no longer critical): no send', async () => {
    const gated = installGatedLocks();
    const { rerender } = renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [makeMed({ currentPills: 10, warningThresholdDays: 5 })] },
    });
    rerender({
      medications: [makeMed({ currentPills: 10, warningThresholdDays: 1 })],
    });
    gated.open();
    await flush();

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('edit before delivery starts: delivery uses the LATEST name/values, not the render snapshot', async () => {
    const gated = installGatedLocks();
    const { rerender } = renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [makeMed({ name: 'Old Name', currentPills: 10 })] },
    });
    rerender({ medications: [makeMed({ name: 'New Name', currentPills: 8 })] });
    gated.open();
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(requireDefined(sendMock.mock.calls[0], 'sendMock.mock.calls[0]')[1]).toBe('New Name');
    expect(requireDefined(sendMock.mock.calls[0], 'sendMock.mock.calls[0]')[3]).toBe(8);
  });
});

describe('#539 post-send revalidation (state changed while delivery in flight)', () => {
  it('refill during delivery: exactly one send, no stale alarm cancellation', async () => {
    const deferred = deferSend();
    sendMock.mockImplementation(() => deferred.promise);
    const { rerender } = renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [makeMed({ currentPills: 10 })] },
    });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Refill lands while the send is in flight.
    rerender({ medications: [makeMed({ currentPills: 50 })] });
    await flush();
    deferred.resolve(true);
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    // Stale work must not cancel anything on behalf of the newer state.
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('edit during delivery: no duplicate send after the newest state lands', async () => {
    const deferred = deferSend();
    sendMock.mockImplementation(() => deferred.promise);
    const { rerender } = renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [makeMed({ name: 'Before' })] },
    });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);

    rerender({ medications: [makeMed({ name: 'After', currentPills: 40 })] });
    await flush();
    deferred.resolve(true);
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('delete during delivery: no delivery side effects touch removed medication', async () => {
    const deferred = deferSend();
    sendMock.mockImplementation(() => deferred.promise);
    const { rerender } = renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [makeMed()] },
    });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);

    rerender({ medications: [] });
    await flush();
    deferred.resolve(true);
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('critical disabled during delivery: episode re-evaluated, no alarm touched', async () => {
    const deferred = deferSend();
    sendMock.mockImplementation(() => deferred.promise);
    const { rerender } = renderHook(
      (p: UseAlertsProps) => useAlerts(p),
      {
        initialProps: {
          medications: [makeMed()],
          criticalStockAlertsEnabled: true,
        },
      }
    );
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);

    rerender({ medications: [makeMed()], criticalStockAlertsEnabled: false });
    await flush();
    deferred.resolve(true);
    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('newer scheduled fallback created while the old foreground send is in flight is never cancelled', async () => {
    const deferred = deferSend();
    sendMock.mockImplementation(() => deferred.promise);
    renderHook((p: { medications: Medication[] }) => useAlerts(p), {
      initialProps: { medications: [makeMed()] },
    });
    await flush();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A NEWER operation owns the episode now: it bumped the generation and
    // created a scheduled fallback ({ claimed: true, alarmTime: future }).
    bumpCriticalAlarmGeneration('med-1');
    const futureAlarm = Date.now() + 86_400_000;
    writeCriticalClaim('med-1', { claimed: true, alarmTime: futureAlarm });

    deferred.resolve(true);
    await flush();

    // Stale work must not cancel the newer scheduled fallback...
    expect(cancelMock).not.toHaveBeenCalled();
    // ...nor release/overwrite the newer claim it does not own.
    expect(readCriticalClaims()['med-1']).toEqual({
      claimed: true,
      alarmTime: futureAlarm,
    });
  });
});
