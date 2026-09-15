/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * App-layer restore lifecycle regressions (PR #185).
 *
 * Restores use the remaining product path: manual Take first (so card canRestore),
 * then MedicationCard restore-dose-* → SelectDoseModal (restore mode) for multi-dose
 * → handleCardRestoreDose → handleRestoreDose → restoreDose.
 * Logs-tab / ConsumptionLogView restore UI stays intentionally removed (UI redesign later);
 * restore business logic in App handlers remains intact.
 * Takes go through SelectDoseModal (explicit doseId) → handleConsumeDose → consumeDose.
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

/**
 * Card always passes an explicit toggle doseId. To open the real App
 * SelectDoseModal path (handleConsumeDose without doseId), add a test
 * trigger that omits doseId — same pattern as doseSelect.integration.
 */
vi.mock('@/components/MedicationCard', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<typeof import('@/components/MedicationCard')>();
  return {
    ...actual,
    MedicationCard: (props: React.ComponentProps<typeof actual.MedicationCard>) =>
      React.createElement(
        React.Fragment,
        null,
        // Card always passes an explicit toggle doseId. This helper omits doseId
        // so tests exercise App handleConsumeDose → SelectDoseModal (take mode).
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': `consume-no-doseid-${props.medication.id}`,
            onClick: () => props.onConsumeDose?.(props.medication.id),
          },
          'consume-without-doseId'
        ),
        React.createElement(actual.MedicationCard, props)
      ),
  };
});

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

async function goToStockTab(): Promise<void> {
  const stockNav = screen.getByText('المخزون');
  fireEvent.click(stockNav);
  await waitFor(() => {
    expect(screen.getByTestId(`consume-no-doseid-${MED_ID}`)).toBeInTheDocument();
  });
}

/**
 * Advance past d1/d2 scheduled times so restoreDose records doseSkippedHistory
 * (past-due skip marker). Keep date = TEST_DATE. Call after Take, before Restore.
 * Production only writes doseSkippedHistory when the slot time has elapsed.
 */
function advanceClockPastMorningDoses(): void {
  vi.setSystemTime(new Date(`${TEST_DATE}T15:00:00`));
}

/**
 * Multi-dose restore via the real MedicationCard control.
 * Requires a prior manual Take so canRestore is true and restore-dose-med-restore is rendered.
 * Opens SelectDoseModal (restore mode) then picks doseId.
 */
async function restoreDoseViaCardModal(doseId: string): Promise<void> {
  // Past-due clock so restoreDose writes doseSkippedHistory[doseId] = [TEST_DATE]
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

async function takeDoseViaSelectModal(doseId: string): Promise<void> {
  // Stock tab: consume without doseId → SelectDoseModal (take mode).
  // Prefer morning clock so unconsumed slots are not auto-completed; skipped
  // slots remain selectable even after 15:00 (isDoseCompletedToday false).
  const scheduleTimes: Record<string, string> = { d1: '08:00', d2: '14:00', d3: '20:00' };
  const slotTime = scheduleTimes[doseId];
  if (slotTime) {
    // Set clock one minute before this slot so Take is enabled for a fresh take
    const [hh, mm] = slotTime.split(':').map(Number);
    const before = new Date(`${TEST_DATE}T00:00:00`);
    before.setHours(hh, Math.max(0, mm - 1), 0, 0);
    vi.setSystemTime(before);
  }
  await goToStockTab();
  fireEvent.click(screen.getByTestId(`consume-no-doseid-${MED_ID}`));
  await waitFor(() => {
    expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
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
  // 07:30 — before d1 (08:00). Take modal can select d1 (not auto-completed yet).
  // After Take, getCardDoseToggleTarget returns canRestore=true so the real
  // MedicationCard restore-dose-* control is rendered (no fake DOM).
  // At 15:00 d1/d2 are auto-completed → Take options disabled and canRestore stays false.
  vi.setSystemTime(new Date(`${TEST_DATE}T07:30:00`));
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App — Take → Restore → Restore blocked (explicit doseId via card)', () => {
  it('first Restore of d1 succeeds; second Restore of same d1+date is blocked', async () => {
    // Remaining UI path: manual Take makes canRestore true so real restore-dose-* appears.
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
    });

    // Prerequisite: Take d1 so MedicationCard surfaces restore control.
    await takeDoseViaSelectModal('d1');
    await waitFor(() => {
      expect(readMeds()[0].doseConsumption?.d1).toBe(getTodayDateString());
    });
    const pillsAfterTake = readMeds()[0].currentPills;

    // Step 1 — explicit Restore d1 via real card + SelectDoseModal
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
      // Manual take then restore returns the dose amount to stock
      expect(med.currentPills).toBe(pillsAfterTake + 1);
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
    });

    // Step 2 — second Restore same d1: modal keeps d1 non-selectable (or card hides restore)
    const restoreBtn = screen.queryByTestId(`restore-dose-${MED_ID}`);
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
    // Card chronological toggle: an incomplete earlier slot hides restore for later ones.
    // Independent d1/d2 restores: Take+Restore each dose in sequence (real UI path).
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti({ currentPills: 10 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => expect(screen.getByText('Restore Handler Med')).toBeInTheDocument());

    // d1 cycle
    await takeDoseViaSelectModal('d1');
    await waitFor(() => {
      expect(readMeds()[0].doseConsumption?.d1).toBe(getTodayDateString());
    });
    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      expect(readLogs().filter((l) => l.type === 'skipped_day' && l.doseId === 'd1')).toHaveLength(1);
    });

    // Duplicate d1: after restore, d1 is skipped → incomplete → canRestore false (no restore control)
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).not.toBeInTheDocument();

    // Independent d2 cycle
    await takeDoseViaSelectModal('d2');
    await waitFor(() => {
      expect(readMeds()[0].doseConsumption?.d2).toBe(getTodayDateString());
    });
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
    // Card only shows restore-dose-* after a manual Take (canRestore).
    // Full cycle exercises handleCardRestoreDose + handleRestoreDose + consumeDose.
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
    });

    // ── Step 1: Take d1 ──
    await takeDoseViaSelectModal('d1');
    await waitFor(() => {
      expect(readMeds()[0].doseConsumption?.d1).toBe(getTodayDateString());
    });

    // ── Step 2: Restore d1 (real restore-dose-* + SelectDoseModal) ──
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

    // ── Step 3: Take d1 again (clears outstanding skip) ──
    await takeDoseViaSelectModal('d1');
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

    // ── Step 4: Restore d1 again ──
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
      // siblings still clean
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
