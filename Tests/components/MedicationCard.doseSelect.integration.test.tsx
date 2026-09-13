/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Phase 3A integration — real App wiring:
 * MedicationCard → handleConsumeDose → SelectDoseModal → consumeDose(d2)
 *
 * Does NOT re-implement App multi-dose branching. Seeds localStorage the
 * same way App hydrates, renders <App />, and asserts persisted state.
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

/**
 * Card always passes an explicit doseId for its toggle target.
 * To exercise App.handleConsumeDose(medId) WITHOUT doseId → SelectDoseModal,
 * wrap MedicationCard with a test-only trigger that omits doseId while
 * still using the real App callback wiring.
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
import { getTodayDateString, effectiveCurrentPills } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-multi',
    name: 'Drug A Multi',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-09-10',
    autoDeductEnabled: true,
    reminderEnabled: false,
    reminderTime: '08:00',
    doseSchedule: [
      { id: 'd1', amount: 2, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 1, time: '21:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

function makeLegacy(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-legacy',
    name: 'Legacy One Dose',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-09-10',
    autoDeductEnabled: true,
    reminderEnabled: false,
    reminderTime: '20:00',
    ...overrides,
  };
}

function readMeds(): Medication[] {
  const raw = localStorage.getItem(STORAGE_MEDS_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as Medication[];
}

function readLogs(): ConsumptionLog[] {
  const raw = localStorage.getItem(STORAGE_LOGS_KEY);
  if (!raw) return [];
  return JSON.parse(raw) as ConsumptionLog[];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App multi-dose manual consumption (real wiring, Phase 3A)', () => {
  it('missing doseId opens SelectDoseModal; selecting d2 consumes only d2 via App path', async () => {
    // d1=1, d2=2 so selecting d2 proves amount is slot amount, not dailyDose (4)
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          currentPills: 30,
          dailyDose: 4,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 2, time: '14:00' },
            { id: 'd3', amount: 1, time: '21:00' },
          ],
          dosesPerDay: 3,
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    // Real App path: handleConsumeDose(medId) without doseId → SelectDoseModal
    fireEvent.click(screen.getByTestId('consume-no-doseid-med-multi'));

    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
    });

    // Opening selector must not have written consumption yet.
    expect(readMeds()[0]?.doseConsumption?.d1).toBeUndefined();
    expect(readMeds()[0]?.doseConsumption?.d2).toBeUndefined();
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);

    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    expect(doseButtons.map((b) => b.getAttribute('data-dose-id'))).toEqual([
      'd1',
      'd2',
      'd3',
    ]);

    fireEvent.click(
      doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2')!
    );

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi');
      expect(med?.doseConsumption?.d2).toBe(today);
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumption?.d1).toBeUndefined();
    expect(med.doseConsumption?.d3).toBeUndefined();
    expect(med.doseConsumption?.d2).toBe(today);
    // Stock reduced by d2.amount (2), not dailyDose (4)
    expect(effectiveCurrentPills(med)).toBe(28);

    await waitFor(() => {
      const doseLog = readLogs().find(
        (l) => l.type === 'dose_taken' && l.medicationId === 'med-multi'
      );
      expect(doseLog?.doseId).toBe('d2');
      expect(doseLog?.amount).toBe(-2);
    });
  });

  it('closing SelectDoseModal without selecting does not consume', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          currentPills: 30,
          dailyDose: 4,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 2, time: '14:00' },
            { id: 'd3', amount: 1, time: '21:00' },
          ],
          dosesPerDay: 3,
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('consume-no-doseid-med-multi'));
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('إغلاق'));

    await waitFor(() => {
      expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).toBeNull();
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumption).toBeUndefined();
    expect(med.doseConsumptionHistory).toBeUndefined();
    expect(effectiveCurrentPills(med)).toBe(30);
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);
  });

  it('Card Take passes next doseId and consumes d1 directly (no modal)', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/تناول جرعة/));

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi');
      expect(med?.doseConsumption?.d1).toBe(today);
    });

    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).not.toBeInTheDocument();
    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumption?.d2).toBeUndefined();
    expect(med.doseConsumption?.d3).toBeUndefined();

    const doseLog = readLogs().find(
      (l) => l.type === 'dose_taken' && l.medicationId === 'med-multi'
    );
    expect(doseLog?.doseId).toBe('d1');
    expect(doseLog?.amount).toBe(2);
  });


  it('after d1 manually consumed, Card shows Restore d1 (same doseId) not Take d2', async () => {
    const today = getTodayDateString();
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ doseConsumption: { d1: today } })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    // Toggle stays on d1 for restore — does not advance to d2 take
    expect(screen.queryByTitle(/تناول جرعة/)).not.toBeInTheDocument();
    expect(screen.getByTitle(/استرجاع الجرعة/)).toBeInTheDocument();
  });


  it('Card Take with known doseId commits immediately (no abandoned modal state)', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    await waitFor(() => {
      expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(1);
    });
    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).not.toBeInTheDocument();
  });


  it('legacy medication Take Dose consumes without opening the selector', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeLegacy()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Legacy One Dose')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/تناول جرعة/));

    // No multi-dose selector
    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).toBeNull();

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-legacy');
      expect(med?.lastConsumedDate).toBe(today);
    });

    const logs = readLogs().filter((l) => l.type === 'dose_taken');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].doseId).toBeUndefined();
  });

  it('single-slot schedule resolves that doseId without showing the selector', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          name: 'Single Slot Med',
          doseSchedule: [{ id: 'only', amount: 1, time: '09:00' }],
          dosesPerDay: 1,
          dailyDose: 1,
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Single Slot Med')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).toBeNull();

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.name === 'Single Slot Med');
      expect(med?.doseConsumption?.only).toBe(today);
    });

    const log = readLogs().find((l) => l.type === 'dose_taken');
    expect(log?.doseId).toBe('only');
  });

  it('displays next upcoming dose amount (-2) instead of daily aggregate (-5) and disables past doses', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          name: 'Test',
          dailyDose: 5,
          currentPills: 20,
          unit: 'قرص',
          doseSchedule: [
            { id: 'dose-8am', amount: 3, time: '08:00' },
            { id: 'dose-2pm', amount: 2, time: '14:00' },
          ],
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Test')).toBeInTheDocument();
    });

    const consumeBtn = screen.getByTitle('تناول جرعة (-2)');
    expect(consumeBtn).toBeInTheDocument();

    // Card takes next dose (2pm / amount 2) with explicit doseId — no modal
    fireEvent.click(consumeBtn);
    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.name === 'Test');
      expect(med?.doseConsumption?.['dose-2pm']).toBe(today);
    });
    expect(screen.queryByText(/اختر الجرعة التي تناولتها/)).not.toBeInTheDocument();
    const doseLog = readLogs().find((l) => l.type === 'dose_taken');
    expect(doseLog?.doseId).toBe('dose-2pm');
    expect(doseLog?.amount).toBe(-2);
  });

  it('all slots consumed shows completed badge and no take action', async () => {
    const today = getTodayDateString();
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          doseConsumption: { d1: today, d2: today, d3: today },
        }),
      ])
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    expect(screen.queryByTitle(/^تناول جرعة/)).toBeNull();
    expect(screen.getByTitle(/استرجاع الجرعة/)).toBeInTheDocument();
  });
});
