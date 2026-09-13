/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * App-layer restore lifecycle regressions (PR #185).
 * Exercises real App handlers via UI — not pure restoreDose mirrors.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
  openAppSettings: vi.fn(() => Promise.resolve(false)),
  registerBackButtonHandler: vi.fn(),
  registerNotificationActionHandler: vi.fn(),
  registerDoseReceivedHandler: vi.fn(),
  registerAppResumeHandler: vi.fn(),
  cleanupNativeListeners: vi.fn(),
}));

vi.mock('@/utils/notifications', () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  sendTestAlertNotification: vi.fn(() => Promise.resolve()),
  openNotificationSettings: vi.fn(),
  getNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  getExactAlarmPermission: vi.fn(() => Promise.resolve('granted')),
  openExactAlarmSettings: vi.fn(() => Promise.resolve(true)),
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve()),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve()),
  verifyCriticalAlarmPending: vi.fn(() => Promise.resolve(false)),
  criticalAlarmId: vi.fn((id: string) => id.length),
  scheduleDoseReminder: vi.fn(() => Promise.resolve()),
  cancelDoseReminder: vi.fn(() => Promise.resolve()),
  cancelSnoozedDoseReminder: vi.fn(() => Promise.resolve()),
  scheduleSnoozedDoseReminder: vi.fn(() => Promise.resolve()),
  isDoseReminderTimeStillAhead: vi.fn(() => true),
  LEGACY_DOSE_ID: 'legacy',
}));

vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

import App from '@/App';
import type { Medication, ConsumptionLog } from '@/types';
import { getTodayDateString, effectiveCurrentPills } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const TEST_DATE = '2024-09-10';

function readMeds(): Medication[] {
  return JSON.parse(localStorage.getItem(STORAGE_MEDS_KEY) || '[]');
}

function readLogs(): ConsumptionLog[] {
  return JSON.parse(localStorage.getItem(STORAGE_LOGS_KEY) || '[]');
}

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-restore-handler',
    name: 'Restore Handler Med',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 3,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TEST_DATE,
    autoDeductEnabled: true,
    reminderEnabled: false,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '20:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 15:00 local — d1 (08:00) and d2 (14:00) are auto-elapsed; d3 is not.
  vi.setSystemTime(new Date(`${TEST_DATE}T15:00:00`));
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App — multi-dose restore handler (logs tab)', () => {
  function seedMed(overrides: Partial<Medication> = {}): void {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti(overrides)]));
    localStorage.setItem(STORAGE_LOGS_KEY, '[]');
    window.history.replaceState({}, '', '/?tab=logs');
  }

  it('blocks a duplicate restore for the same doseId but allows another dose the same day', async () => {
    seedMed({ currentPills: 10 });
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
      expect(screen.getByText('سجل الاستهلاك')).toBeInTheDocument();
      expect(screen.getByLabelText('اختر الجرعة')).toBeInTheDocument();
    });

    const doseSelect = screen.getByLabelText('اختر الجرعة');
    const restoreButton = screen.getByRole('button', {
      name: /إعادة الجرعة المخصومة للمخزون/,
    });

    fireEvent.change(doseSelect, { target: { value: 'd1' } });
    fireEvent.click(restoreButton);
    await waitFor(() => {
      expect(screen.getByText(/تم استرجاع جرعة \(1 قرص\) إلى مخزون/)).toBeInTheDocument();
    });

    fireEvent.click(restoreButton);
    await waitFor(() => {
      expect(
        screen.getByText('تم استرجاع جرعة "Restore Handler Med" اليوم بالفعل.')
      ).toBeInTheDocument();
    });

    fireEvent.change(doseSelect, { target: { value: 'd2' } });
    fireEvent.click(restoreButton);
    await waitFor(() => {
      const successToasts = screen.getAllByText(/تم استرجاع جرعة \(1 قرص\) إلى مخزون/);
      expect(successToasts.length).toBeGreaterThanOrEqual(1);
    });

    await waitFor(() => {
      const logs = readLogs();
      const restores = logs.filter((log) => log.type === 'skipped_day');
      expect(restores).toHaveLength(2);
      expect(restores.map((log) => log.doseId).sort()).toEqual(['d1', 'd2']);
    });
  });
});

describe('App — Card + logs: Auto-Deduct → Restore → Restore blocked (App guard)', () => {
  it('Restore then Restore again for same doseId is blocked; no second log or stock credit', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti({ currentPills: 30 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    // Start on logs so we can restore twice with explicit dose select
    window.history.replaceState({}, '', '/?tab=logs');

    render(<App />);
    await waitFor(() => {
      expect(screen.getByLabelText('اختر الجرعة')).toBeInTheDocument();
    });

    const doseSelect = screen.getByLabelText('اختر الجرعة');
    const restoreButton = screen.getByRole('button', {
      name: /إعادة الجرعة المخصومة للمخزون/,
    });

    const pillsBefore = readMeds()[0].currentPills;

    // First restore of auto-elapsed d1 (exact doseId)
    fireEvent.change(doseSelect, { target: { value: 'd1' } });
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(screen.getByText(/تم استرجاع جرعة \(1 قرص\) إلى مخزون/)).toBeInTheDocument();
    });

    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      // Auto-only: snapshot not inflated
      expect(med.currentPills).toBe(pillsBefore);
      const restores = readLogs().filter((l) => l.type === 'skipped_day');
      expect(restores).toHaveLength(1);
      expect(restores[0].doseId).toBe('d1');
      expect(restores[0].amount).toBe(1);
    });

    // Second restore same doseId + date — App blocks
    fireEvent.click(restoreButton);
    await waitFor(() => {
      expect(
        screen.getByText('تم استرجاع جرعة "Restore Handler Med" اليوم بالفعل.')
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.currentPills).toBe(pillsBefore);
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      const restores = readLogs().filter((l) => l.type === 'skipped_day');
      expect(restores).toHaveLength(1);
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
    });
  });
});

describe('App — Restore → Take → Restore allowed (App path)', () => {
  it('after Restore then Take of same doseId, Restore is allowed again with exact amount', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti({ currentPills: 30 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    window.history.replaceState({}, '', '/?tab=meds');

    render(<App />);
    await waitFor(() => expect(screen.getByText('Restore Handler Med')).toBeInTheDocument());

    // 1) Restore auto-elapsed d1 via Card (App handleCardRestoreDose → handleRestoreDose)
    fireEvent.click(await screen.findByTitle(/استرجاع الجرعة \(\+1\)/));
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      const restores = readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1');
      expect(restores.length).toBe(1);
    });

    // 2) Take same doseId via Card (App handleConsumeDose → consumeDose)
    fireEvent.click(await screen.findByTitle(/تناول جرعة \(-1\)/));
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseConsumption?.d1).toBe(getTodayDateString());
      // skip cleared by production consumeDose
      expect(med.doseSkippedHistory?.d1).toBeUndefined();
      const taken = readLogs().filter((l) => l.type === 'dose_taken' && l.doseId === 'd1');
      expect(taken.length).toBe(1);
      expect(taken[0].amount).toBe(-1);
      // siblings
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
    });

    // 3) Restore again — must be allowed (Take cleared outstanding skip)
    fireEvent.click(await screen.findByTitle(/استرجاع الجرعة \(\+1\)/));
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseConsumption?.d1).toBeUndefined();
      const restores = readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1');
      // First restore log + this second restore log after Take
      expect(restores.length).toBe(2);
      expect(restores.every((l) => l.amount === 1)).toBe(true);
      // Not dailyDose
      expect(restores.every((l) => l.amount !== 4)).toBe(true);
    });
  });
});
