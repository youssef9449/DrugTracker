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
    autoDeductEnabled: false,
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
  // The manage-doses button lives only on the MedicationCard (not on the
  // SelectDoseModal that stays open in manage mode after a Take). Using
  // its testid avoids the "multiple elements" clash with the modal's h2
  // (which also renders the medication name) and uniquely confirms the
  // card is mounted on the stock tab.
  await waitFor(() => {
    expect(screen.getByTestId('manage-doses-med-restore')).toBeInTheDocument();
  });
}

/**
 * Real MedicationCard Take control (title="تناول جرعة (-N)").
 * Card passes doseToggle.doseId into onConsumeDose — no SelectDoseModal for Take.
 */
async function takeDoseViaCard(doseId: string): Promise<void> {
  setClockBeforeDose(doseId);
  await goToStockTab();
  // Multi-dose Card → إدارة الجرعات → take action on exact doseId
  const manage = await screen.findByTestId('manage-doses-med-restore');
  fireEvent.click(manage);
  await waitFor(() => {
    expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
  });
  const target = screen
    .getAllByRole('button')
    .find(
      (b) =>
        b.getAttribute('data-dose-id') === doseId &&
        b.getAttribute('data-dose-action') === 'take'
    );
  expect(target).toBeTruthy();
  fireEvent.click(target!);
  await waitFor(() => {
    expect(readMeds()[0].doseConsumptionHistory?.[doseId]).toBe(getTodayDateString());
  });
}

/**
 * Real MedicationCard Restore (data-testid=restore-dose-med-restore) then
 * SelectDoseModal restore mode → pick data-dose-id.
 */
async function restoreDoseViaCardModal(doseId: string): Promise<void> {
  advanceClockPastMorningDoses();
  await goToStockTab();
  // Multi-dose: unified إدارة الجرعات
  await waitFor(() => {
    expect(screen.getByTestId('manage-doses-med-restore')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId('manage-doses-med-restore'));
  await waitFor(() => {
    expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
  });
  const target = screen
    .getAllByRole('button')
    .find(
      (b) =>
        b.getAttribute('data-dose-id') === doseId &&
        b.getAttribute('data-dose-action') === 'restore'
    );
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
      expect(med.doseConsumptionHistory?.d1).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
      expect(med.doseConsumptionHistory?.d3).toBeUndefined();
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

  it('blocks duplicate Restore of d1 the same day', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti({ currentPills: 10 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Restore Handler Med')).toBeInTheDocument());

    await takeDoseViaCard('d1');
    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      expect(readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')).toHaveLength(1);
    });

    // After restore, d1 is skipped → incomplete → no restore control (or d1 disabled in modal)
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
    } else {
      expect(screen.queryByTestId('restore-dose-med-restore')).not.toBeInTheDocument();
    }

    await waitFor(() => {
      expect(readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')).toHaveLength(1);
      expect(readMeds()[0].doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
    });
  });
});

describe('App — independent multi-dose Restore via SelectDoseModal', () => {
  it('restores only d2 when both d1 and d2 are already manually consumed', async () => {
    // Card chronological Take cannot reach d2 while d1 is incomplete after a
    // prior Restore. Seed both consumes so the real Restore UI + modal can
    // target d2 without depending on Card advancing past an incomplete d1.
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          currentPills: 10,
          doseConsumptionHistory: { d1: [TEST_DATE], d2: [TEST_DATE] },
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Restore Handler Med')).toBeInTheDocument());

    advanceClockPastMorningDoses();
    await goToStockTab();
    await waitFor(() => {
      expect(screen.getByTestId('manage-doses-med-restore')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('manage-doses-med-restore'));
    await waitFor(() => {
      expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
    });
    const d2Btn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-dose-id') === 'd2' &&
          b.getAttribute('data-dose-action') === 'restore'
      );
    expect(d2Btn).toBeTruthy();
    expect(d2Btn).not.toBeDisabled();
    fireEvent.click(d2Btn!);

    await waitFor(() => {
      const med = readMeds()[0];
      // d1 untouched
      expect(med.doseConsumptionHistory?.d1).toBe(TEST_DATE);
      expect(readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')).toHaveLength(
        0
      );
      // d2 restored only
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toEqual([TEST_DATE]);
      const d2Restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd2'
      );
      expect(d2Restores).toHaveLength(1);
      expect(d2Restores[0].amount).toBe(1);
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
      expect(med.doseConsumptionHistory?.d1).toBeUndefined();
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
      expect(med.doseConsumptionHistory?.d3).toBeUndefined();
    });

    await takeDoseViaCard('d1');
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseConsumptionHistory?.d1).toBe(getTodayDateString());
      expect(med.doseSkippedHistory?.d1).toBeUndefined();
      const taken = readLogs().filter(
        (l) => l.type === 'dose_taken' && l.doseId === 'd1'
      );
      expect(taken).toHaveLength(2);
      expect(taken.every((l) => l.amount === -1)).toBe(true);
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
      expect(med.doseConsumptionHistory?.d3).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
    });

    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseConsumptionHistory?.d1).toBeUndefined();
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(2);
      expect(restores.every((l) => l.amount === 1)).toBe(true);
      expect(restores.every((l) => l.amount !== 4)).toBe(true);
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
      expect(med.doseConsumptionHistory?.d3).toBeUndefined();
      expect(
        readLogs().filter((l) => l.type === 'dose_taken' && l.doseId === 'd1')
      ).toHaveLength(2);
    });
  });
});
