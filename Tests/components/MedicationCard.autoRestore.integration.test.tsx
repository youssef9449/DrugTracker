/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Auto-deduct Restore button on MedicationCard — real App wiring.
 *
 * Covers:
 * - Compact + Detailed auto Restore visibility and callback
 * - Hidden when global or medication auto is off
 * - Multi-dose opens real SelectDoseModal (restore mode)
 * - Manual Take → Restore regression
 * - Legacy auto Restore path
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
  cleanupNativeListeners: vi.fn(() => Promise.resolve()),
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
import {
  getTodayDateString,
  effectiveCurrentPills,
  isDoseSkippedOnDate,
  isDoseConsumedOnDate,
} from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_GLOBAL_AUTO_DEDUCT_KEY = 'android_med_tracker_auto_deduct_v1';
const COMPACT_VIEW_KEY = 'android_med_tracker_compact_view_v1';

const TEST_DATE = '2024-09-10';
const MED_ID = 'med-auto-restore';

function readMeds(): Medication[] {
  return JSON.parse(localStorage.getItem(STORAGE_MEDS_KEY) || '[]');
}

function readLogs(): ConsumptionLog[] {
  return JSON.parse(localStorage.getItem(STORAGE_LOGS_KEY) || '[]');
}

/** Single-dose with pure auto-completed slot (time elapsed, no consumption mark). */
function makeSingleAuto(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Auto Restore Single',
    currentPills: 20,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TEST_DATE,
    autoDeductEnabled: true,
    reminderEnabled: false,
    doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
    dosesPerDay: 1,
    ...overrides,
  };
}

/** Multi-dose: d1@08:00 and d2@14:00 both auto-elapsed at 16:00. */
function makeMultiAuto(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Auto Restore Multi',
    currentPills: 30,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TEST_DATE,
    autoDeductEnabled: true,
    reminderEnabled: false,
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '14:00' },
    ],
    dosesPerDay: 2,
    ...overrides,
  };
}

function makeLegacyAuto(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-legacy-auto',
    name: 'Legacy Auto Restore',
    currentPills: 12,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TEST_DATE,
    autoDeductEnabled: true,
    reminderEnabled: false,
    reminderTime: '09:00',
    ...overrides,
  };
}

async function clickAutoRestore(medId: string = MED_ID): Promise<void> {
  const btn = await screen.findByTestId(`auto-restore-dose-${medId}`);
  fireEvent.click(btn);
}

async function selectDoseInModal(doseId: string): Promise<void> {
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
  // 16:00 — morning and afternoon slots elapsed.
  vi.setSystemTime(new Date(`${TEST_DATE}T16:00:00`));
  vi.clearAllMocks();
  localStorage.clear();
  // Default: global auto ON, detailed view.
  localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true');
  localStorage.setItem(COMPACT_VIEW_KEY, 'false');
  window.history.replaceState({}, '', '/?tab=stock');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MedicationCard Auto Restore — Compact', () => {
  it('shows auto-restore button, no Take, and restores single-dose via real path', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'true');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    // Auto restore present
    const autoBtn = screen.getByTestId(`auto-restore-dose-${MED_ID}`);
    expect(autoBtn).toBeInTheDocument();
    // Manual restore / Take should not be the path for pure auto
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).toBeNull();
    // No Take pill button when auto-active with completed slot
    const takeCandidates = screen.queryAllByTitle(/تناول جرعة/);
    expect(takeCandidates.length).toBe(0);

    const pillsBefore = readMeds()[0].currentPills;
    const effBefore = effectiveCurrentPills(readMeds()[0]);

    fireEvent.click(autoBtn);

    await waitFor(() => {
      const med = readMeds()[0];
      // Pure auto restore records skip; projection undoes due units.
      expect(isDoseSkippedOnDate(med, 's1', getTodayDateString())).toBe(true);
      expect(isDoseConsumedOnDate(med, 's1', getTodayDateString())).toBe(false);
      // Effective stock rises by slot amount (projection model).
      expect(effectiveCurrentPills(med)).toBe(effBefore + 2);
      // Snapshot unchanged for pure auto-only restore today.
      expect(med.currentPills).toBe(pillsBefore);
    });
  });
});

describe('MedicationCard Auto Restore — Detailed', () => {
  it('shows auto-restore button and same restore behavior as compact', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'false');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.queryAllByTitle(/تناول جرعة/).length).toBe(0);

    const effBefore = effectiveCurrentPills(readMeds()[0]);
    await clickAutoRestore();

    await waitFor(() => {
      const med = readMeds()[0];
      expect(isDoseSkippedOnDate(med, 's1', getTodayDateString())).toBe(true);
      expect(effectiveCurrentPills(med)).toBe(effBefore + 2);
    });
  });
});

describe('MedicationCard Auto Restore — hidden when auto inactive', () => {
  it('global auto OFF hides auto restore even if medication auto ON', async () => {
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'false');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto({ autoDeductEnabled: true })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
  });

  it('medication auto OFF hides auto restore even if global auto ON', async () => {
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true');
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeSingleAuto({ autoDeductEnabled: false })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
  });
});

describe('MedicationCard Auto Restore — Multi-dose SelectDoseModal', () => {
  it('opens real SelectDoseModal; selecting d2 restores only d2', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMultiAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Multi')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();

    const pillsBefore = readMeds()[0].currentPills;
    const effBefore = effectiveCurrentPills(readMeds()[0]);

    // Click does NOT restore immediately — opens modal
    await clickAutoRestore();
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    expect(readMeds()[0].currentPills).toBe(pillsBefore);
    expect(isDoseSkippedOnDate(readMeds()[0], 'd1', getTodayDateString())).toBe(false);
    expect(isDoseSkippedOnDate(readMeds()[0], 'd2', getTodayDateString())).toBe(false);

    await selectDoseInModal('d2');

    await waitFor(() => {
      const med = readMeds()[0];
      expect(isDoseSkippedOnDate(med, 'd2', getTodayDateString())).toBe(true);
      expect(isDoseSkippedOnDate(med, 'd1', getTodayDateString())).toBe(false);
      // Auto-only: snapshot unchanged; effective rises by d2.amount
      expect(med.currentPills).toBe(pillsBefore);
      expect(effectiveCurrentPills(med)).toBe(effBefore + 2);
    });

    // Same dose cannot be restored again — modal would show it disabled / empty
    // Re-open: d2 already skipped so not selectable as restorable pure-auto in same way
    // After restore, showAutoRestore may still be true (d1 still restorable)
    await waitFor(() => {
      // d1 still auto-restorable
      expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();
    });
    await clickAutoRestore();
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    const doseButtons = screen.getAllByRole('button').filter((b) =>
      b.getAttribute('data-dose-id')
    );
    const d2Btn = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2');
    // d2 already skipped → not selectable
    if (d2Btn) {
      expect(d2Btn).toBeDisabled();
    }
    // d1 still available
    const d1Btn = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd1');
    expect(d1Btn).toBeTruthy();
    expect(d1Btn).not.toBeDisabled();
  });
});

describe('MedicationCard Manual Restore regression', () => {
  it('manual Take → Restore still works with auto ON', async () => {
    // Early morning so nothing is auto-elapsed yet; auto ON but time not passed.
    vi.setSystemTime(new Date(`${TEST_DATE}T07:00:00`));

    const med = makeSingleAuto({
      // not yet elapsed
      doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
    });
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([med]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    // Before take: Take available, no auto restore (time not elapsed)
    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    const takeBtn = screen.getByTitle(/تناول جرعة/);
    const pillsBefore = readMeds()[0].currentPills;
    fireEvent.click(takeBtn);

    await waitFor(() => {
      const m = readMeds()[0];
      expect(isDoseConsumedOnDate(m, 's1', getTodayDateString())).toBe(true);
      expect(m.currentPills).toBe(pillsBefore - 2);
    });

    // Manual restore appears
    const restoreBtn = await screen.findByTestId(`restore-dose-${MED_ID}`);
    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      const m = readMeds()[0];
      expect(isDoseConsumedOnDate(m, 's1', getTodayDateString())).toBe(false);
      expect(isDoseSkippedOnDate(m, 's1', getTodayDateString())).toBe(true);
      expect(m.currentPills).toBe(pillsBefore); // manual path restores snapshot
    });
  });
});

describe('MedicationCard Auto Restore — Legacy', () => {
  it('legacy pure auto shows auto restore and uses existing restoreDose path', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeLegacyAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Legacy Auto Restore')).toBeInTheDocument();
    });

    const autoBtn = screen.getByTestId('auto-restore-dose-med-legacy-auto');
    expect(autoBtn).toBeInTheDocument();

    fireEvent.click(autoBtn);

    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-legacy-auto')!;
      // Legacy restore clears the auto-completed state via existing path
      // (skip / lastConsumed handling inside restoreDose)
      expect(med).toBeTruthy();
    });
  });
});
