/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '@/types';
import { useStockAlerts } from '@/hooks/useStockAlerts';
import { resolveRestoreDoseAmount, settleAndAdjust } from '@/utils/medActions';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '@/utils/criticalNotificationClaims';

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
    // floor(4/3)=1 day left at threshold 1 → critical; after +2 → floor(6/3)=2 → sufficient
    const med = makeMed({ currentPills: 4, warningThresholdDays: 1 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']).toEqual({ claimed: true, alarmTime: null });

    const resolved = resolveRestoreDoseAmount(med, 'evening');
    expect(resolved).toEqual({ ok: true, amount: 2, doseId: 'evening' });
    if (!resolved.ok) throw new Error('Expected evening dose to resolve');

    const { updatedMed } = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW);
    expect(updatedMed.currentPills).toBe(6);
    expect(updatedMed.currentPills - med.currentPills).toBe(2);
    expect(updatedMed.currentPills - med.currentPills).not.toBe(med.dailyDose);
    // Integer days-left (floor) must exceed threshold to leave critical
    expect(Math.floor(updatedMed.currentPills / updatedMed.dailyDose)).toBeGreaterThan(
      updatedMed.warningThresholdDays
    );

    rerender({ medications: [updatedMed] });
    expect(readClaims()['med-restore']).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('Critical → Restore → Sufficient → Critical: a new episode gets exactly one new notification', () => {
    const med = makeMed({ currentPills: 4, warningThresholdDays: 1 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const resolved = resolveRestoreDoseAmount(med, 'evening');
    if (!resolved.ok) throw new Error('Expected evening dose to resolve');
    const sufficientMed = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW).updatedMed;
    expect(sufficientMed.currentPills).toBe(6);

    rerender({ medications: [sufficientMed] });
    expect(readClaims()['med-restore']).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Drop back into critical for a new episode
    rerender({ medications: [{ ...sufficientMed, currentPills: 2 }] });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('Critical → Restore → Still Critical: exact restore keeps the same episode claim and sends no duplicate', () => {
    const med = makeMed({ currentPills: 0 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const originalClaim = readClaims()['med-restore'];
    expect(originalClaim?.claimed).toBe(true);

    const resolved = resolveRestoreDoseAmount(med, 'morning');
    if (!resolved.ok) throw new Error('Expected morning dose to resolve');
    const updatedMed = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW).updatedMed;

    expect(updatedMed.currentPills).toBe(1);
    expect(updatedMed.currentPills).not.toBe(med.dailyDose);
    rerender({ medications: [updatedMed] });

    expect(readClaims()['med-restore']).toEqual(originalClaim);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('restores the selected multi-dose slot amount, not dailyDose', () => {
    const med = makeMed({ currentPills: 10 });
    const morning = resolveRestoreDoseAmount(med, 'morning');
    const evening = resolveRestoreDoseAmount(med, 'evening');

    expect(morning).toEqual({ ok: true, amount: 1, doseId: 'morning' });
    expect(evening).toEqual({ ok: true, amount: 2, doseId: 'evening' });
    if (!morning.ok || !evening.ok) throw new Error('Expected both doses to resolve');

    const afterMorning = settleAndAdjust(med, morning.amount, TEST_DATE, TEST_NOW).updatedMed;
    const afterEvening = settleAndAdjust(
      afterMorning,
      evening.amount,
      TEST_DATE,
      TEST_NOW
    ).updatedMed;

    expect(afterMorning.currentPills).toBe(11);
    expect(afterEvening.currentPills).toBe(13);
    expect(afterEvening.currentPills - afterMorning.currentPills).toBe(2);
    expect(afterEvening.currentPills - med.currentPills).toBe(3);
    expect(afterEvening.currentPills - med.currentPills).not.toBe(6);
  });

  it('multiple same-day restores remain in the same critical episode and do not duplicate notifications', () => {
    const med = makeMed({ currentPills: 0 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const morning = resolveRestoreDoseAmount(med, 'morning');
    if (!morning.ok) throw new Error('Expected morning dose to resolve');
    const afterMorning = settleAndAdjust(med, morning.amount, TEST_DATE, TEST_NOW).updatedMed;
    expect(afterMorning.currentPills).toBe(1);
    rerender({ medications: [afterMorning] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']?.claimed).toBe(true);

    const evening = resolveRestoreDoseAmount(afterMorning, 'evening');
    if (!evening.ok) throw new Error('Expected evening dose to resolve');
    const afterEvening = settleAndAdjust(
      afterMorning,
      evening.amount,
      TEST_DATE,
      TEST_NOW
    ).updatedMed;
    expect(afterEvening.currentPills).toBe(3);
    expect(afterEvening.currentPills - afterMorning.currentPills).toBe(2);

    rerender({ medications: [afterEvening] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']?.claimed).toBe(true);
  });

  it('requires a doseId for multi-dose restore', () => {
    expect(resolveRestoreDoseAmount(makeMed())).toEqual({
      ok: false,
      amount: 0,
      reason: 'missing_dose_id',
    });
  });
});
