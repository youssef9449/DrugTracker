/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * App-layer restore lifecycle regressions (PR #185).
 *
 * Restores go through MedicationCard restore control → SelectDoseModal (restore mode)
 * → handleCardRestoreDose → handleRestoreDose → restoreDose.
 * (Logs-tab restore UI was intentionally removed from ConsumptionLogView.)
 * Takes go through SelectDoseModal (explicit doseId) → handleConsumeDose → consumeDose.
 * Never relies on Card chronological target resolution for dose identity.
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
        // Open SelectDoseModal take path without a pre-selected doseId (card always passes one).
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': `consume-no-doseid-${props.medication.id}`,
            onClick: () => props.onConsumeDose?.(props.medication.id),
          },
          'consume-without-doseId'
        ),
        // Open App restore path without doseId → multi-dose SelectDoseModal (restore mode).
        // Same semantic entry as handleCardRestoreDose(medId); required because the card
        // toggle only surfaces restore-dose-* when canRestore (manual take), not for
        // auto-deduct-only slots — while App restore lifecycle still uses this handler.
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': `restore-dose-${props.medication.id}`,
            onClick: () => props.onRestoreDose?.(props.medication.id),
          },
          'restore-open-modal'
        ),
        React.createElement(actual.MedicationCard, {
          ...props,
          // Avoid duplicate restore-dose-* when the real card also renders canRestore.
          onRestoreDose: undefined,
        })
      ),
  };
});

import App from '@/App';
import type { Medication, ConsumptionLog } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const TEST_DATE = '2024-09-10';
const MED_ID = 'med-restore-handler';

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

/** Multi-dose restore via card (opens SelectDoseModal in restore mode). */
async function restoreDoseViaCardModal(doseId: string): Promise<void> {
  await goToStockTab();
  fireEvent.click(screen.getByTestId(`restore-dose-${MED_ID}`));
  await waitFor(() => {
    expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
  });
  const doseButtons = screen.getAllByRole('button').filter((b) =>
    b.getAttribute('data-dose-id')
  );
  const target = doseButtons.find((b) => b.getAttribute('data-dose-id') === doseId);
  expect(target).toBeTruthy();
  fireEvent.click(target!);
}

async function takeDoseViaSelectModal(doseId: string): Promise<void> {
  // Stock tab mounts MedicationCard + consume-without-doseId → SelectDoseModal
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
  // Restored/skipped doses must remain selectable despite elapsed time (Case D).
  expect(target).not.toBeDisabled();
  fireEvent.click(target!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 15:00 — d1 and d2 auto-elapsed; d3 not. Card target is ambiguous for identity tests.
  vi.setSystemTime(new Date(`${TEST_DATE}T15:00:00`));
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App — Auto-Deduct → Restore → Restore blocked (explicit doseId)', () => {
  it('first Restore of d1 succeeds; second Restore of same d1+date is blocked by App guard', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
      expect(screen.getByTestId(`restore-dose-${MED_ID}`)).toBeInTheDocument();
    });

    const pillsBefore = readMeds()[0].currentPills;

    // Step 1 — explicit Restore d1
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
      // Auto-only restore: snapshot not inflated
      expect(med.currentPills).toBe(pillsBefore);
      const restores = readLogs().filter(
        (l) => l.type === 'skipped_day' && l.doseId === 'd1'
      );
      expect(restores).toHaveLength(1);
      expect(restores[0].amount).toBe(1);
    });

    // Step 2 — second Restore same d1+date: modal keeps d1 non-selectable;
    // storage must remain single restore (no duplicate log / stock change).
    await goToStockTab();
    fireEvent.click(screen.getByTestId(`restore-dose-${MED_ID}`));
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    const d1Btn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd1');
    expect(d1Btn).toBeTruthy();
    expect(d1Btn).toBeDisabled();
    // Clicking a disabled option must not create a second restore.
    fireEvent.click(d1Btn!);

    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.currentPills).toBe(pillsBefore);
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
    await waitFor(() => expect(screen.getByTestId(`restore-dose-${MED_ID}`)).toBeInTheDocument());

    await restoreDoseViaCardModal('d1');
    await waitFor(() => {
      expect(screen.getByText(/تم استرجاع الجرعة — Restore Handler Med/)).toBeInTheDocument();
    });

    // d1 already restored — modal marks it disabled; proceed to independent d2.
    await restoreDoseViaCardModal('d2');
    await waitFor(() => {
      const restores = readLogs().filter((l) => l.type === 'skipped_day');
      expect(restores).toHaveLength(2);
      expect(restores.map((l) => l.doseId).sort()).toEqual(['d1', 'd2']);
      expect(restores.every((l) => l.amount === 1)).toBe(true);
    });
  });
});

describe('App — Restore → Take → Restore for the SAME doseId (explicit selection)', () => {
  it('explicit d1 Restore → explicit d1 Take → explicit d1 Restore is allowed', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Restore Handler Med')).toBeInTheDocument();
      expect(screen.getByTestId(`restore-dose-${MED_ID}`)).toBeInTheDocument();
    });

    // ── Step 1: Restore d1 (logs dose selector → handleRestoreDose) ──
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

    // ── Step 2: Take d1 (SelectDoseModal → handleConsumeDose → consumeDose) ──
    await takeDoseViaSelectModal('d1');
    await waitFor(() => {
      const med = readMeds()[0];
      expect(med.doseConsumption?.d1).toBe(getTodayDateString());
      // consumeDose clears outstanding skip
      expect(med.doseSkippedHistory?.d1).toBeUndefined();
      const taken = readLogs().filter(
        (l) => l.type === 'dose_taken' && l.doseId === 'd1'
      );
      expect(taken).toHaveLength(1);
      expect(taken[0].amount).toBe(-1);
      expect(med.doseConsumption?.d2).toBeUndefined();
      expect(med.doseConsumption?.d3).toBeUndefined();
      expect(med.doseSkippedHistory?.d2).toBeUndefined();
      expect(med.doseSkippedHistory?.d3).toBeUndefined();
    });

    // ── Step 3: Restore d1 again (logs selector — same doseId) ──
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
      // only one Take for d1
      expect(
        readLogs().filter((l) => l.type === 'dose_taken' && l.doseId === 'd1')
      ).toHaveLength(1);
    });
  });
});
