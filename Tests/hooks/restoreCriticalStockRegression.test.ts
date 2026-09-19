/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication, ConsumptionLog } from '@/types';
import { useStockAlerts } from '@/hooks/useStockAlerts';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '@/utils/criticalNotificationClaims';
import { restoreDose, resolveRestoreDoseId } from '@/utils/medActions';

vi.mock('@/utils/notifications', () => ({
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve()),
}));

import { sendCriticalStockAlert, cancelCriticalAlarm } from '@/utils/notifications';

const sendMock = vi.mocked(sendCriticalStockAlert);
const cancelMock = vi.mocked(cancelCriticalAlarm);
const TEST_DATE = '2024-09-10';
const TEST_NOW = new Date('2024-09-10T07:00:00Z');

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-restore',
    name: 'Restore Test Med',
    currentPills: 30,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 3,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TEST_DATE,
    autoDeductEnabled: true,
    doseSchedule: [
      { id: 'morning', amount: 1, time: '08:00' },
      { id: 'evening', amount: 2, time: '20:00' },
    ],
    ...overrides,
  };
}

/** Build a `dose_taken` log for a single occurrence (med + doseId + date). */
function makeDoseTakenLog(
  med: Medication,
  doseId: string,
  date: string,
  amount: number,
  logId: string
): ConsumptionLog {
  return {
    id: logId,
    medicationId: med.id,
    medicationName: med.name,
    type: 'dose_taken',
    amount: -amount,
    date,
    timestamp: `${date}T08:00:00.000Z`,
    description: 'test dose_taken',
    doseId,
  };
}

/** Build a med that has had `doseId` consumed on `date` (with the durable log). */
function makeConsumedMed(
  baseMed: Medication,
  doseId: string,
  date: string,
  deductedAmount: number
): { med: Medication; logs: ConsumptionLog[] } {
  const slot = baseMed.doseSchedule!.find((d) => d.id === doseId)!;
  const med: Medication = {
    ...baseMed,
    currentPills: Math.max(0, baseMed.currentPills - deductedAmount),
    doseConsumption: { ...(baseMed.doseConsumption ?? {}), [doseId]: date },
    doseConsumptionHistory: {
      ...(baseMed.doseConsumptionHistory ?? {}),
      [doseId]: [date],
    },
  };
  const logs: ConsumptionLog[] = [
    makeDoseTakenLog(baseMed, doseId, date, deductedAmount, `take-${doseId}-${date}`),
  ];
  return { med, logs };
}

function useAlerts(medications: Medication[]) {
  return useStockAlerts({
    medications,
    notificationsEnabled: true,
    criticalStockAlertsEnabled: true,
    hydrated: true,
    isFirstRun: false,
  });
}

function readClaims(): Record<string, { claimed: boolean; alarmTime: number | null }> {
  return JSON.parse(localStorage.getItem(CRITICAL_CLAIMS_STORAGE_KEY) || '{}');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(TEST_NOW);
  localStorage.clear();
  sendMock.mockResolvedValue(true);
  cancelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('restore dose → critical stock reconciliation', () => {
  it('Critical → Restore → Sufficient: exact dose restore clears the old critical claim', () => {
    // Start at 4 pills (after taking evening dose=2 from 6). threshold=1.
    // floor(4/3)=1 day left at threshold 1 → critical.
    // After Restore (reverses evening dose +2) → 6 → floor(6/3)=2 → sufficient.
    const baseMed = makeMed({ currentPills: 6, warningThresholdDays: 1 });
    const { med, logs } = makeConsumedMed(baseMed, 'evening', TEST_DATE, 2);
    // med.currentPills = 4 (6 - 2); the active deduction log records -2.
    expect(med.currentPills).toBe(4);

    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']).toEqual({ claimed: true, alarmTime: null });

    // Issue #267: restoreDose reverses the active deduction log's amount
    // (abs(log.amount) = 2 for evening). Restored = currentPills + 2 = 6.
    const result = restoreDose(med, 'evening', TEST_DATE, TEST_NOW, logs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected evening restore to succeed');
    expect(result.restoredAmount).toBe(2);
    expect(result.updatedMed.currentPills).toBe(6);
    // Restore amount equals the slot amount (2), NOT dailyDose (3).
    expect(result.restoredAmount).not.toBe(med.dailyDose);
    // Integer days-left (floor) must exceed threshold to leave critical
    expect(Math.floor(result.updatedMed.currentPills / result.updatedMed.dailyDose)).toBeGreaterThan(
      result.updatedMed.warningThresholdDays
    );

    rerender({ medications: [result.updatedMed] });
    expect(readClaims()['med-restore']).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('Critical → Restore → Sufficient → Critical: a new episode gets exactly one new notification', () => {
    const baseMed = makeMed({ currentPills: 6, warningThresholdDays: 1 });
    const { med, logs } = makeConsumedMed(baseMed, 'evening', TEST_DATE, 2);

    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const result = restoreDose(med, 'evening', TEST_DATE, TEST_NOW, logs);
    if (!result.ok) throw new Error('Expected evening restore to succeed');
    const sufficientMed = result.updatedMed;
    expect(sufficientMed.currentPills).toBe(6);

    rerender({ medications: [sufficientMed] });
    expect(readClaims()['med-restore']).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Drop back into critical for a new episode
    rerender({ medications: [{ ...sufficientMed, currentPills: 2 }] });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('Critical → Restore → Still Critical: exact restore keeps the same episode claim and sends no duplicate', () => {
    // Start at 0 pills (after taking morning dose=1 from 1). Still critical (0 pills).
    const baseMed = makeMed({ currentPills: 1 });
    const { med, logs } = makeConsumedMed(baseMed, 'morning', TEST_DATE, 1);
    expect(med.currentPills).toBe(0);

    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const originalClaim = readClaims()['med-restore'];
    expect(originalClaim?.claimed).toBe(true);

    // Restore reverses morning dose (+1). 0 + 1 = 1. Still critical (floor(1/3)=0 ≤ 3).
    const result = restoreDose(med, 'morning', TEST_DATE, TEST_NOW, logs);
    if (!result.ok) throw new Error('Expected morning restore to succeed');
    expect(result.updatedMed.currentPills).toBe(1);
    expect(result.restoredAmount).not.toBe(med.dailyDose);
    rerender({ medications: [result.updatedMed] });

    expect(readClaims()['med-restore']).toEqual(originalClaim);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('restores the selected multi-dose slot amount, not dailyDose', () => {
    // Take morning (1) then take evening (2). Restoring each reverses only that slot's amount.
    const baseMed = makeMed({ currentPills: 10 });
    const morningTake = makeDoseTakenLog(baseMed, 'morning', TEST_DATE, 1, 'take-morning');
    const eveningTake = makeDoseTakenLog(baseMed, 'evening', TEST_DATE, 2, 'take-evening');
    const logs: ConsumptionLog[] = [morningTake, eveningTake];

    // Med has already taken morning (1) and evening (2): currentPills = 10 - 1 - 2 = 7.
    const med: Medication = {
      ...baseMed,
      currentPills: 7,
      doseConsumption: { morning: TEST_DATE, evening: TEST_DATE },
      doseConsumptionHistory: {
        morning: [TEST_DATE],
        evening: [TEST_DATE],
      },
    };

    // Restore morning first (+1) → 8.
    const morningResult = restoreDose(med, 'morning', TEST_DATE, TEST_NOW, logs);
    expect(morningResult.ok).toBe(true);
    if (!morningResult.ok) throw new Error('Expected morning restore');
    expect(morningResult.restoredAmount).toBe(1);
    expect(morningResult.updatedMed.currentPills).toBe(8);

    // After morning restore, the morning log is reversed. Restore evening (+2) → 10.
    // findActiveDeductionForOccurrence skips reversed logs, so evening restore still
    // finds the active evening log.
    const updatedLogs: ConsumptionLog[] = logs.map((l) =>
      l.id === morningResult.reversedLogId
        ? { ...l, reversedAt: new Date(TEST_NOW).toISOString() }
        : l
    );
    const eveningResult = restoreDose(
      morningResult.updatedMed,
      'evening',
      TEST_DATE,
      TEST_NOW,
      updatedLogs
    );
    expect(eveningResult.ok).toBe(true);
    if (!eveningResult.ok) throw new Error('Expected evening restore');
    expect(eveningResult.restoredAmount).toBe(2);
    expect(eveningResult.updatedMed.currentPills).toBe(10);
    // Total restore = 1 + 2 = 3 (slot amounts), NOT dailyDose*2 = 6.
    expect(morningResult.restoredAmount + eveningResult.restoredAmount).toBe(3);
  });

  it('multiple same-day restores remain in the same critical episode and do not duplicate notifications', () => {
    // Start at 0 pills (after taking both morning=1 and evening=2 from 3).
    const baseMed = makeMed({ currentPills: 3 });
    const morningTake = makeDoseTakenLog(baseMed, 'morning', TEST_DATE, 1, 'take-morning');
    const eveningTake = makeDoseTakenLog(baseMed, 'evening', TEST_DATE, 2, 'take-evening');
    const logs: ConsumptionLog[] = [morningTake, eveningTake];
    const med: Medication = {
      ...baseMed,
      currentPills: 0,
      doseConsumption: { morning: TEST_DATE, evening: TEST_DATE },
      doseConsumptionHistory: {
        morning: [TEST_DATE],
        evening: [TEST_DATE],
      },
    };

    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Restore morning (+1) → 1. Still critical (floor(1/3)=0 ≤ 3).
    const morningResult = restoreDose(med, 'morning', TEST_DATE, TEST_NOW, logs);
    if (!morningResult.ok) throw new Error('Expected morning restore');
    expect(morningResult.updatedMed.currentPills).toBe(1);
    rerender({ medications: [morningResult.updatedMed] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']?.claimed).toBe(true);

    // Restore evening (+2) → 3. Still critical (floor(3/3)=1 ≤ 3).
    const updatedLogs: ConsumptionLog[] = logs.map((l) =>
      l.id === morningResult.reversedLogId
        ? { ...l, reversedAt: new Date(TEST_NOW).toISOString() }
        : l
    );
    const eveningResult = restoreDose(
      morningResult.updatedMed,
      'evening',
      TEST_DATE,
      TEST_NOW,
      updatedLogs
    );
    if (!eveningResult.ok) throw new Error('Expected evening restore');
    expect(eveningResult.updatedMed.currentPills).toBe(3);
    expect(eveningResult.restoredAmount).toBe(2);

    rerender({ medications: [eveningResult.updatedMed] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']?.claimed).toBe(true);
  });

  it('requires a doseId for multi-dose restore', () => {
    // Issue #267: resolveRestoreDoseId replaces the deleted resolveRestoreDoseAmount
    // and returns the dose identity (no amount — amount comes from the log).
    const med = makeMed();
    const resolved = resolveRestoreDoseId(med);
    expect(resolved).toEqual({ ok: false, reason: 'missing_dose_id' });
  });

  it('restoreDose rejects when no active deduction log exists (no pure-projection restore)', () => {
    // Issue #267: restoreDose requires durable deduction evidence.
    // A projection-only restore (no consume marker, no deduction log) is rejected.
    const med = makeMed({ currentPills: 30 });
    const result = restoreDose(med, 'morning', TEST_DATE, TEST_NOW, []);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.reason).toBe('missing_deduction_evidence');
  });
});
