/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Multi-dose Restore selection UX — real App path:
 * MedicationCard Restore button
 *   → SelectDoseModal (mode=restore)
 *   → selected doseId
 *   → handleCardRestoreDose → handleRestoreDose → restoreDose
 *   → state + card update
 *
 * Proves: no direct restore of default/first/last dose; amount = selected slot;
 * sibling isolation; single-dose still direct.
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
import type { Medication, ConsumptionLog } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const TEST_DATE = '2024-09-10';
const MED_ID = 'med-restore-select';


function readLogs(): ConsumptionLog[] {
  return JSON.parse(localStorage.getItem(STORAGE_LOGS_KEY) || '[]');
}

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Restore Select Med',
    currentPills: 10,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 3,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    reminderEnabled: false,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '14:00' },
    ],
    dosesPerDay: 2,
    // Both slots already settled as manual consume so Restore is available.
    doseConsumptionHistory: {
      d1: [TEST_DATE],
      d2: [TEST_DATE],
    },
    ...overrides,
  };
}

function makeSingle(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-single',
    name: 'Single Dose Med',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 3,
    colorTag: 'blue',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    reminderEnabled: false,
    doseSchedule: [{ id: 'only', amount: 1, time: '09:00' }],
    dosesPerDay: 1,
    doseConsumptionHistory: { only: [TEST_DATE] },
    ...overrides,
  };
}

async function clickCardManage(medId: string = MED_ID): Promise<void> {
  const btn = await screen.findByTestId(`manage-doses-${medId}`);
  fireEvent.click(btn);
}

/**
 * Durable deduction evidence for one occurrence. Current production Restore
 * (UI + durable domain) is evidence-gated: it reverses an ACTIVE (un-reversed)
 * dose_taken / exact_auto log for (medicationId + doseId + calendarDate).
 */
function makeDoseTakenLog(doseId: string, amount: number): ConsumptionLog {
  return {
    id: `seed-take-${doseId}`,
    medicationId: MED_ID,
    medicationName: 'Restore Select Med',
    type: 'dose_taken',
    amount: -amount,
    date: TEST_DATE,
    timestamp: `${TEST_DATE}T12:00:00.000Z`,
    description: `تناول جرعة يدوياً (-${amount} قرص)`,
    doseId,
  };
}

/** Evidence for the makeMulti fixture: d1 (amount 1) and d2 (amount 2) consumed. */
function makeMultiEvidenceLogs(): ConsumptionLog[] {
  return [makeDoseTakenLog('d1', 1), makeDoseTakenLog('d2', 2)];
}

/** Explicit single-slot Card restore path — no manage modal, direct restore button. */
async function clickCardRestoreDirect(medId: string): Promise<void> {
  const btn = await screen.findByTestId(`restore-dose-${medId}`);
  fireEvent.click(btn);
}

async function selectDoseInModal(doseId: string, action: 'take' | 'restore' = 'restore'): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
  });
  const target = screen
    .getAllByRole('button')
    .find(
      (b) =>
        b.getAttribute('data-dose-id') === doseId &&
        b.getAttribute('data-dose-action') === action
    );
  expect(target).toBeTruthy();
  expect(target).not.toBeDisabled();
  fireEvent.click(target!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 16:00 — both d1 and d2 times elapsed.
  vi.setSystemTime(new Date(`${TEST_DATE}T16:00:00`));
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState({}, '', '/?tab=stock');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MedicationCard multi-dose Restore → SelectDoseModal', () => {
  it('Test 1 — Restore on multi-dose opens SelectDoseModal and does not restore immediately', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    const pillsBefore = readPersistedMedications()[0].currentPills;
    const consumptionBefore = { ...readPersistedMedications()[0].doseConsumptionHistory };

    await clickCardManage();

    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });

    // No mutation until a dose is selected.
    expect(readPersistedMedications()[0].currentPills).toBe(pillsBefore);
    expect(readPersistedMedications()[0].doseConsumptionHistory).toEqual(consumptionBefore);
    expect(readLogs().filter((l) => l.type === 'skipped_day')).toHaveLength(0);
  });

  it('Test 2 — selecting d2 restores doseId=d2 with amount=2 (not dailyDose)', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify(makeMultiEvidenceLogs()));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    const pillsBefore = readPersistedMedications()[0].currentPills;

    await clickCardManage();
    await selectDoseInModal('d2');

    await waitFor(() => {
      const med = readPersistedMedications()[0];
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd2'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(2);
      expect(restores[0].amount).not.toBe(3); // not dailyDose
      expect(restores[0].amount).not.toBe(1); // not d1 amount
      // Manual restore settles amount back into snapshot.
      expect(med.currentPills).toBe(pillsBefore + 2);
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
    });
  });

  it('Test 3 — sibling isolation: restore d2 does not change d1', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify(makeMultiEvidenceLogs()));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    await clickCardManage();
    await selectDoseInModal('d2');

    await waitFor(() => {
      const med = readPersistedMedications()[0];
      expect(med.doseConsumptionHistory?.d1).toEqual([TEST_DATE]);
      expect(med.doseSkippedHistory?.d1).toBeUndefined();
      expect(med.doseConsumptionHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toEqual([getTodayDateString()]);
      expect(
        readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')
      ).toHaveLength(0);
    });
  });

  it('Test 4 — reverse selection: restore d1 only affects d1', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify(makeMultiEvidenceLogs()));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    const pillsBefore = readPersistedMedications()[0].currentPills;

    await clickCardManage();
    await selectDoseInModal('d1');

    await waitFor(() => {
      const med = readPersistedMedications()[0];
      expect(med.doseConsumptionHistory?.d1).toBeUndefined();
      expect(med.doseSkippedHistory?.d1).toEqual([getTodayDateString()]);
      expect(med.doseConsumptionHistory?.d2).toEqual([TEST_DATE]);
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
      expect(med.currentPills).toBe(pillsBefore + 1);
    });
  });

  it('Test 5 — repeated restore of same d2 is blocked by existing guards', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify(makeMultiEvidenceLogs()));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    await clickCardManage();
    await selectDoseInModal('d2');

    await waitFor(() => {
      expect(
        readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd2')
      ).toHaveLength(1);
    });

    // Card may still show Restore (d1 still restorable). Open modal again.
    await clickCardManage();
    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });

    // d2 was restored/skipped under Auto ON → manage modal renders a span "—",
    // NOT an action button (action=null). So no restore action for d2 exists.
    const d2RestoreBtn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-dose-id') === 'd2' &&
          b.getAttribute('data-dose-action') === 'restore'
      );
    expect(d2RestoreBtn).toBeUndefined();

    // d1 still selectable (still has a restore action).
    const d1RestoreBtn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-dose-id') === 'd1' &&
          b.getAttribute('data-dose-action') === 'restore'
      );
    expect(d1RestoreBtn).toBeTruthy();
    expect(d1RestoreBtn).not.toBeDisabled();

    // Close modal without selecting.
    fireEvent.click(screen.getByLabelText('إغلاق'));
    await waitFor(() => {
      expect(screen.queryByText('اختر الإجراء المناسب لكل جرعة')).not.toBeInTheDocument();
    });

    expect(
      readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd2')
    ).toHaveLength(1);
  });

  it('Test 6 — single-dose does not open SelectDoseModal; restores directly', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingle()]));
    // Direct Card Restore is evidence-gated too — seed the 'only' occurrence.
    localStorage.setItem(
      STORAGE_LOGS_KEY,
      JSON.stringify([
        {
          id: 'seed-take-only',
          medicationId: 'med-single',
          medicationName: 'Single Dose Med',
          type: 'dose_taken',
          amount: -1,
          date: TEST_DATE,
          timestamp: `${TEST_DATE}T12:00:00.000Z`,
          description: 'تناول جرعة يدوياً (-1 قرص)',
          doseId: 'only',
        },
      ] satisfies ConsumptionLog[])
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Single Dose Med')).toBeInTheDocument();
    });

    // Single-dose card has no manage-doses button; it shows the per-dose
    // manual Restore button directly.
    expect(screen.queryByTestId('manage-doses-med-single')).not.toBeInTheDocument();
    await clickCardRestoreDirect('med-single');

    await waitFor(() => {
      expect(screen.queryByText('اختر الإجراء المناسب لكل جرعة')).not.toBeInTheDocument();
      expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).not.toBeInTheDocument();
      const med = readPersistedMedications().find((m) => m.id === 'med-single')!;
      expect(med.doseConsumptionHistory?.only).toBeUndefined();
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.medicationId === 'med-single'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
    });
  });


  it('Test 7 — restored amount uses selectedDose.amount not dailyDose', async () => {
    // dailyDose=3, d1=1, d2=2 — select d2 → +2 only
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          currentPills: 10,
          dailyDose: 3,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 2, time: '14:00' },
          ],
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify(makeMultiEvidenceLogs()));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    const before = readPersistedMedications()[0].currentPills;

    await clickCardManage();
    await selectDoseInModal('d2');

    await waitFor(() => {
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd2'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(2);
      expect(restores[0].amount).not.toBe(3);
      expect(readPersistedMedications()[0].currentPills).toBe(before + 2);
      // siblings unchanged
      expect(readPersistedMedications()[0].doseConsumptionHistory?.d1).toEqual([TEST_DATE]);
    });

  });

  it('closing SelectDoseModal without selecting does not restore', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Select Med')).toBeInTheDocument();
    });

    const before = JSON.stringify(readPersistedMedications()[0]);

    await clickCardManage();
    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('إغلاق'));

    await waitFor(() => {
      expect(screen.queryByText('اختر الإجراء المناسب لكل جرعة')).not.toBeInTheDocument();
    });
    expect(JSON.stringify(readPersistedMedications()[0])).toBe(before);
    expect(readLogs()).toHaveLength(0);
  });
});
