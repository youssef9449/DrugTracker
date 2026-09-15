/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * App-layer restore lifecycle regressions (PR #185).
 *
 * Production UI path only (no MedicationCard mocks / fake testids):
 *   real MedicationCard Take button (title="تناول جرعة (-N)")
 *     → onConsumeDose(id, doseToggle.doseId) → handleConsumeDose → consumeDose
 *   real MedicationCard Restore button (data-testid="restore-dose-*")
 *     → SelectDoseModal (restore mode) → handleCardRestoreDose → restoreDose
 *
 * Logs-tab / ConsumptionLogView restore UI stays intentionally removed.
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
import { getTodayDateString } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const TEST_DATE = '2024-09-10';
const MED_ID = 'med-restore';

function readMeds(): Medication[] {
  return JSON.parse(localStorage.getItem(STORAGE_MEDS_KEY) || '[]');
}

function readLogs(): ConsumptionLog[] {
  return JSON.parse(localStorage.getItem(STORAGE_LOGS_KEY) || '[]');
}

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Restore Handler Med',
    currentPills: 20,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
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

/** One minute before the slot's scheduled time so Card Take targets that doseId. */
function setClockBeforeDose(doseId: string): void {
  const scheduleTimes: Record<string, [number, number]> = {
    d1: [7, 59],
    d2: [13, 59],
    d3: [19, 59],
  };
  const [hh, mm] = scheduleTimes[doseId] ?? [7, 59];
  const t = new Date(`${TEST_DATE}T00:00:00`);
  t.setHours(hh, mm, 0, 0);
  vi.setSystemTime(t);
}

/** Past d1/d2 so restoreDose records doseSkippedHistory (past-due skip). */
function advanceClockPastMorningDoses(): void {
  vi.setSystemTime(new Date(`${TEST_DATE}T15:00:00`));
}

async function goToStockTab(): Promise<void> {
  fireEvent.click(screen.getByText('المخزون'));
  await waitFor(() => {
    expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
  });
}

/**
 * Real MedicationCard Take control (title="تناول جرعة (-N)").
 * Card passes doseToggle.doseId into onConsumeDose — no SelectDoseModal for Take.
 */
async function takeDoseViaCard(doseId: string): Promise<void> {
  setClockBeforeDose(doseId);
  await goToStockTab();
  const takeButton = await screen.findByTitle(/تناول جرعة \(-/);
  expect(takeButton).not.toBeDisabled();
  fireEvent.click(takeButton);
  await waitFor(() => {
    expect(readMeds()[0].doseConsumption?.[doseId]).toBe(getTodayDateString());
  });
}

/**
 * Real MedicationCard Restore (data-testid=restore-dose-med-restore) then
 * SelectDoseModal restore mode → pick data-dose-id.
 */
async function restoreDoseViaCardModal(doseId: string): Promise<void> {
  advanceClockPastMorningDoses();
  await goToStockTab();
  await waitFor(() => {
    expect(screen.getByTestId('restore-dose-med-restore')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId('restore-dose-med-restore'));
  await waitFor(() => {
    expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
  });
  const doseButtons = screen.getAllByRole('button').filter((b) =>
    b.getAttribute('data-dose-id')
  );
  const target = doseButtons.find((b) => b.getAttribute('data-dose-id') === doseId);
  expect(target).toBeTruthy();
  expect(target).not.toBeDisabled();
  fireEvent.click(target!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Default: before d1 so first Take targets d1.
  vi.setSystemTime(new Date(`${TEST_DATE}T07:59:00`));
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App — Take → Restore → Restore blocked (explicit doseId via card)', () => {
  it('first Restore of d1 succeeds; second Restore of same d1+date is blocked', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
    });

    await takeDoseViaCard('d1');
    const pillsAfterTake = readMeds()[0].currentPills;

    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      expect(screen.getByText(/تم استرجاع الجرعة — Restore Handler Med/)).toBeInTheDocument();
    });

    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseConsumption?.d1).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseConsumption?.d3).toBeUndefined();
      expect(med.currentPills).toBe(pillsAfterTake + 1);
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
    });

    // Second Restore same d1: control gone or modal marks d1 disabled.
    const restoreBtn = screen.queryByTestId('restore-dose-med-restore');
    if (restoreBtn) {
      fireEvent.click(restoreBtn);
      await waitFor(() => {
        expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
      });
      const d1Btn = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1Btn).toBeTruthy();
      expect(d1Btn).toBeDisabled();
      fireEvent.click(d1Btn!);
    }

    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')).toHaveLength(
        1
      );
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
    });
  });

  it('blocks duplicate d1 but still allows independent Restore of d2 the same day', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti({ currentPills: 10 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Restore Handler Med')).toBeInTheDocument());

    // d1 cycle — real Card Take then Restore
    await takeDoseViaCard('d1');
    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      expect(readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')).toHaveLength(1);
    });

    // After restore, d1 is skipped → incomplete → no restore control for d1
    expect(screen.queryByTestId('restore-dose-med-restore')).not.toBeInTheDocument();

    // Independent d2 cycle — clock 13:59 for Take, then 15:00 for Restore
    await takeDoseViaCard('d2');
    await restoreDoseViaCardModal('d2');
    await waitFor(() => {
      const restores = readLogs().filter((l) => l.type === 'skipped_day');
      expect(restores).toHaveLength(2);
      expect(restores.map((l) => l.doseId).sort()).toEqual(['d1', 'd2']);
      expect(restores.every((l) => l.amount === 1)).toBe(true);
    });
  });
});

describe('App — Take → Restore → Take → Restore for the SAME doseId (card path)', () => {
  it('explicit d1 Take → Restore → Take → Restore is allowed', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
    });

    await takeDoseViaCard('d1');

    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseConsumption?.d1).toBeUndefined();
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseConsumption?.d3).toBeUndefined();
    });

    await takeDoseViaCard('d1');
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseConsumption?.d1).toBe(getTodayDateString());
      expect(med.doseSkippedHistory?.d1).toBeUndefined();
      const taken = readLogs().filter(
        (l) => l.type === 'dose_taken' && l.doseId === 'd1'
      );
      expect(taken).toHaveLength(2);
      expect(taken.every((l) => l.amount === -1)).toBe(true);
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseConsumption?.d3).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
    });

    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseConsumption?.d1).toBeUndefined();
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(2);
      expect(restores.every((l) => l.amount === 1)).toBe(true);
      expect(restores.every((l) => l.amount !== 4)).toBe(true);
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseConsumption?.d3).toBeUndefined();
      expect(
        readLogs().filter((l) => l.type === 'dose_taken' && l.doseId === 'd1')
      ).toHaveLength(2);
    });
  });
});
