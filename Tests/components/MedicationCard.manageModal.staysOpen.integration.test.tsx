import { requireDefined } from '../helpers/requireDefined';
/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Management modal stays open after Take / Restore so the user can
 * chain actions (Take → Restore → Take, or switch dose) without
 * reopening إدارة الجرعات.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readPersistedMedications } from '../helpers/persistedMedications';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
  openAppSettings: vi.fn(() => Promise.resolve(false)),
  registerBackButtonHandler: vi.fn(),
  registerNotificationActionHandler: vi.fn(),
  registerDoseReceivedHandler: vi.fn(),
  registerAppResumeHandler: vi.fn(),
  cleanupNativeListeners: vi.fn(() => Promise.resolve()),
}));

vi.mock('../utils/notificationTestFacade', () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  sendTestAlertNotification: vi.fn(() => Promise.resolve()),
  openNotificationSettings: vi.fn(),
  getNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  getExactAlarmPermission: vi.fn(() => Promise.resolve('granted')),
  openExactAlarmSettings: vi.fn(() => Promise.resolve({ ok: true })),
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  verifyCriticalAlarmPending: vi.fn(() => Promise.resolve({ ok: true, pending: false })),
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
import type { Medication } from '@/types';
import {
  getTodayDateString,
  isDoseConsumedOnDate } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_GLOBAL_AUTO_DEDUCT_KEY = 'android_med_tracker_auto_deduct_v1';
const TEST_DATE = '2024-09-10';
const MED_ID = 'med-manage-stay';


function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Manage Stay Open',
    currentPills: 30,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: false,
    reminderEnabled: false,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '14:00' },
    ],
    dosesPerDay: 2,
    ...overrides,
  };
}

async function openManage(): Promise<void> {
  const btn = await screen.findByTestId(`manage-doses-${MED_ID}`);
  fireEvent.click(btn);
  await waitFor(() => {
    expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
  });
}

function actionButton(doseId: string, action: 'take' | 'restore'): HTMLElement {
  const btn = screen
    .getAllByRole('button')
    .find(
      (b) =>
        b.getAttribute('data-dose-id') === doseId &&
        b.getAttribute('data-dose-action') === action
    );
  expect(btn).toBeTruthy();
  return btn as HTMLElement;
}

function expectManageStillOpen(): void {
  expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TEST_DATE}T16:00:00`));
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'false');
  window.history.replaceState({}, '', '/?tab=stock');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Management modal stays open after actions', () => {
  it('Test 1 — Take does not close Management; d1 becomes Restore', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });

    await openManage();
    fireEvent.click(actionButton('d1', 'take'));

    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(true);
    });
    expectManageStillOpen();
    expect(actionButton('d1', 'restore')).toBeTruthy();
  });

  it('Test 2 — Restore does not close Management; d1 becomes Take again', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          doseConsumptionHistory: { d1: [TEST_DATE] },
          currentPills: 29,
        }),
      ])
    );
    // Restore is evidence-gated: the manage modal offers the d1 Restore action
    // only when an ACTIVE dose_taken deduction log exists for the occurrence.
    localStorage.setItem(
      STORAGE_LOGS_KEY,
      JSON.stringify([
        {
          id: 'seed-take-d1',
          medicationId: MED_ID,
          medicationName: 'Manage Stay Open',
          type: 'dose_taken',
          amount: -1,
          date: TEST_DATE,
          timestamp: `${TEST_DATE}T12:00:00.000Z`,
          description: 'تناول جرعة يدوياً (-1 قرص)',
          doseId: 'd1',
        },
      ])
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });

    await openManage();
    fireEvent.click(actionButton('d1', 'restore'));

    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(false);
    });
    expectManageStillOpen();
    expect(actionButton('d1', 'take')).toBeTruthy();
  });

  it('Test 3 — Take → Restore → Take on same doseId without closing', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });

    await openManage();
    const pills0 = requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills;

    fireEvent.click(actionButton('d1', 'take'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(true);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0 - 1);
    });
    expectManageStillOpen();

    fireEvent.click(actionButton('d1', 'restore'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(false);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0);
    });
    expectManageStillOpen();

    fireEvent.click(actionButton('d1', 'take'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(true);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0 - 1);
    });
    expectManageStillOpen();
  });

  it('Test 4 — action on d2 after d1 without reopening Management', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });

    await openManage();
    fireEvent.click(actionButton('d1', 'take'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(true);
    });
    expectManageStillOpen();

    fireEvent.click(actionButton('d2', 'take'));
    await waitFor(() => {
      const med = readPersistedMedications()[0];
      expect(isDoseConsumedOnDate(requireDefined(med, 'med'), 'd1', getTodayDateString())).toBe(true);
      expect(isDoseConsumedOnDate(requireDefined(med, 'med'), 'd2', getTodayDateString())).toBe(true);
    });
    expectManageStillOpen();
  });

  it('Test 5 — single-dose still uses direct Card Take (no manage modal)', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        {
          id: 'med-single',
          name: 'Single Slot',
          currentPills: 20,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          autoDeductEnabled: false,
          reminderEnabled: false,
          doseSchedule: [{ id: 's1', amount: 2, time: '09:00' }],
          dosesPerDay: 1,
        },
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Single Slot')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('manage-doses-med-single')).toBeNull();
    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 's1', getTodayDateString())).toBe(true);
    });
    // No management modal opened
    expect(screen.queryByText(/اختر الإجراء المناسب لكل جرعة/)).toBeNull();
  });

  it('Take → Restore → Take → Restore on d1 keeps modal open and updates stock', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });

    await openManage();
    const pills0 = requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills;

    fireEvent.click(actionButton('d1', 'take'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(true);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0 - 1);
    });
    expectManageStillOpen();
    expect(actionButton('d1', 'restore')).toBeTruthy();

    fireEvent.click(actionButton('d1', 'restore'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(false);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0);
    });
    expectManageStillOpen();
    expect(actionButton('d1', 'take')).toBeTruthy();

    fireEvent.click(actionButton('d1', 'take'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(true);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0 - 1);
    });
    expectManageStillOpen();
    expect(actionButton('d1', 'restore')).toBeTruthy();

    fireEvent.click(actionButton('d1', 'restore'));
    await waitFor(() => {
      expect(isDoseConsumedOnDate(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]'), 'd1', getTodayDateString())).toBe(false);
      expect(requireDefined(readPersistedMedications()[0], 'readPersistedMedications()[0]').currentPills).toBe(pills0);
    });
    expectManageStillOpen();
    expect(actionButton('d1', 'take')).toBeTruthy();
  });

  it('manage-doses button stays present for multi-dose in Auto ON and Auto OFF', async () => {
    // Auto OFF
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'false');
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ autoDeductEnabled: false })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    const { unmount } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });
    expect(screen.getByTestId(`manage-doses-${MED_ID}`)).toBeInTheDocument();
    unmount();

    // Auto ON
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true');
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ autoDeductEnabled: true })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Manage Stay Open')).toBeInTheDocument();
    });
    expect(screen.getByTestId(`manage-doses-${MED_ID}`)).toBeInTheDocument();
  });

});
