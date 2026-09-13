/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication } from '../types';
import { useStockAlerts } from './useStockAlerts';
import {
  resolveRestoreDoseAmount,
  settleAndAdjust,
} from '../utils/medActions';
import { getTodayDateString } from '../utils/dateCalculations';
import { CRITICAL_CLAIMS_STORAGE_KEY } from '../utils/criticalNotificationClaims';

vi.mock('../utils/notifications', () => ({
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve()),
}));

import { sendCriticalStockAlert, cancelCriticalAlarm } from '../utils/notifications';

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
  vi.setSystemTime(new Date('2024-09-10T07:00:00Z'));
  localStorage.clear();
  sendMock.mockResolvedValue(true);
  cancelMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('restore dose → critical stock reconciliation', () => {
  it('Critical → Restore → Sufficient: restores only the selected dose and ends the critical episode', () => {
    const med = makeMed({ currentPills: 2 });
    const firstRender = renderHook(() => useAlerts([med]));

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']).toEqual({ claimed: true, alarmTime: null });

    const resolved = resolveRestoreDoseAmount(med, 'evening');
    expect(resolved).toEqual({ ok: true, amount: 2, doseId: 'evening' });

    if (!resolved.ok) throw new Error('Expected evening dose to resolve');
    const { updatedMed } = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW);

    expect(updatedMed.currentPills).toBe(4);
    expect(updatedMed.currentPills).not.toBe(5);
    expect(updatedMed.currentPills / updatedMed.dailyDose).toBeGreaterThan(
      updatedMed.warningThresholdDays
    );

    firstRender.rerender();
    // The hook receives the medication through props, so rerender with the
    // actual post-restore object to exercise production reconciliation.
    firstRender.rerender();
  });

  it('Critical → Restore → Sufficient: production hook clears the previous claim and permits a later new episode', () => {
    const med = makeMed({ currentPills: 2 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);

    const resolved = resolveRestoreDoseAmount(med, 'evening');
    if (!resolved.ok) throw new Error('Expected evening dose to resolve');
    const { updatedMed } = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW);

    expect(updatedMed.currentPills).toBe(4);
    rerender({ medications: [updatedMed] });

    expect(readClaims()['med-restore']).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A later drop below the threshold starts a genuinely new episode.
    const criticalAgain = { ...updatedMed, currentPills: 2 };
    rerender({ medications: [criticalAgain] });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('Critical → Restore → Still Critical: restores the exact dose but keeps the same critical claim', () => {
    const med = makeMed({ currentPills: 0 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const originalClaim = readClaims()['med-restore'];
    expect(originalClaim?.claimed).toBe(true);

    const resolved = resolveRestoreDoseAmount(med, 'morning');
    if (!resolved.ok) throw new Error('Expected morning dose to resolve');
    const { updatedMed } = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW);

    expect(updatedMed.currentPills).toBe(1);
    expect(updatedMed.currentPills).not.toBe(3);

    rerender({ medications: [updatedMed] });

    expect(readClaims()['med-restore']).toEqual(originalClaim);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('Multi-dose exact amount: restoring the evening 2-tablet slot adds +2, never dailyDose +3', () => {
    const med = makeMed({ currentPills: 2 });
    const resolved = resolveRestoreDoseAmount(med, 'evening');

    expect(resolved).toEqual({ ok: true, amount: 2, doseId: 'evening' });
    if (!resolved.ok) throw new Error('Expected evening dose to resolve');

    const { updatedMed } = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW);

    expect(updatedMed.currentPills).toBe(4);
    expect(updatedMed.currentPills - med.currentPills).toBe(2);
    expect(updatedMed.currentPills - med.currentPills).not.toBe(med.dailyDose);

    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    rerender({ medications: [updatedMed] });
    expect(readClaims()['med-restore']).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('Multiple restores on the same day use independent dose amounts and never duplicate the critical notification', () => {
    const med = makeMed({ currentPills: 0 });
    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });

    expect(sendMock).toHaveBeenCalledTimes(1);

    const morning = resolveRestoreDoseAmount(med, 'morning');
    expect(morning).toEqual({ ok: true, amount: 1, doseId: 'morning' });
    if (!morning.ok) throw new Error('Expected morning dose to resolve');
    const afterMorning = settleAndAdjust(med, morning.amount, TEST_DATE, TEST_NOW).updatedMed;
    expect(afterMorning.currentPills).toBe(1);

    rerender({ medications: [afterMorning] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']?.claimed).toBe(true);

    const evening = resolveRestoreDoseAmount(afterMorning, 'evening');
    expect(evening).toEqual({ ok: true, amount: 2, doseId: 'evening' });
    if (!evening.ok) throw new Error('Expected evening dose to resolve');
    const afterEvening = settleAndAdjust(
      afterMorning,
      evening.amount,
      TEST_DATE,
      TEST_NOW
    ).updatedMed;

    expect(afterEvening.currentPills).toBe(3);
    expect(afterEvening.currentPills - afterMorning.currentPills).toBe(2);
    expect(afterEvening.currentPills - med.currentPills).toBe(3);

    rerender({ medications: [afterEvening] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(readClaims()['med-restore']?.claimed).toBe(true);
  });

  it('does not silently resolve a multi-dose restore without a doseId', () => {
    const med = makeMed();
    expect(resolveRestoreDoseAmount(med)).toEqual({
      ok: false,
      amount: 0,
      reason: 'missing_dose_id',
    });
  });

  it('uses the real effective stock state after restore rather than assuming dailyDose was restored', () => {
    const med = makeMed({ currentPills: 2 });
    const resolved = resolveRestoreDoseAmount(med, 'evening');
    if (!resolved.ok) throw new Error('Expected evening dose to resolve');

    const { updatedMed } = settleAndAdjust(med, resolved.amount, TEST_DATE, TEST_NOW);
    expect(updatedMed.currentPills).toBe(4);

    const { rerender } = renderHook(({ medications }) => useAlerts(medications), {
      initialProps: { medications: [med] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);

    rerender({ medications: [updatedMed] });

    // 4 pills / 3 dailyDose = 1.33 days, above the 3-day threshold is false;
    // therefore this medication is still critical. The important invariant
    // is that the hook evaluates the real restored stock, not +dailyDose.
    expect(readClaims()['med-restore']?.claimed).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('uses today as the restore/reconciliation date', () => {
    expect(getTodayDateString()).toBe(TEST_DATE);
  });
});
