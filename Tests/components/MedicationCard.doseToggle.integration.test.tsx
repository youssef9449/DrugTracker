/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * MedicationCard Take↔Restore toggle — same doseId lifecycle via real App.
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
import { getTodayDateString, effectiveCurrentPills } from '@/utils/dateCalculations';
import { getNextScheduledDose } from '@/utils/doseSchedule';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';

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
    autoDeductEnabled: false,
    reminderEnabled: false,
    reminderTime: '20:00',
    ...overrides,
  };
}

function makeSingle(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-single',
    name: 'Single Schedule',
    currentPills: 20,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-09-10',
    autoDeductEnabled: false,
    reminderEnabled: false,
    reminderTime: '08:00',
    doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
    dosesPerDay: 1,
    ...overrides,
  };
}

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
    autoDeductEnabled: false,
    reminderEnabled: false,
    reminderTime: '08:00',
    doseSchedule: [
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 2, time: '20:00' },
    ],
    dosesPerDay: 3,
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
  vi.setSystemTime(new Date('2024-09-10T06:00:00'));
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MedicationCard dose toggle — same doseId Take→Restore', () => {
  it('legacy: Take then Restore returns stock; second click is Restore not second Take', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeLegacy({ currentPills: 10 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Legacy One Dose')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-legacy')!;
      expect(med.lastConsumedDate).toBe(getTodayDateString());
      expect(effectiveCurrentPills(med)).toBe(9);
    });

    await waitFor(() => expect(screen.getByTitle(/استرجاع الجرعة/)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/استرجاع الجرعة/));

    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-legacy')!;
      expect(effectiveCurrentPills(med)).toBe(10);
      const restoreLog = readLogs().find((l) => l.type === 'skipped_day');
      expect(restoreLog?.amount).toBe(1);
    });
  });

  it('single-slot: Take and Restore use amount 2 not dailyDose 4', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingle({ currentPills: 20 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Single Schedule')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/تناول جرعة \(-2\)/));
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-single')!;
      expect(effectiveCurrentPills(med)).toBe(18);
      expect(med.doseConsumption?.s1).toBe(getTodayDateString());
    });
    const doseLog = readLogs().find((l) => l.type === 'dose_taken');
    expect(doseLog?.amount).toBe(-2);
    expect(doseLog?.doseId).toBe('s1');

    await waitFor(() => expect(screen.getByTitle(/استرجاع الجرعة \(\+2\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/استرجاع الجرعة \(\+2\)/));

    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-single')!;
      expect(effectiveCurrentPills(med)).toBe(20);
      const restoreLog = readLogs().find((l) => l.type === 'skipped_day');
      expect(restoreLog?.amount).toBe(2);
      expect(restoreLog?.doseId).toBe('s1');
    });
  });

  it('multi: first click Take d1; second click Restore d1 (NOT Take d2)', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMulti({ currentPills: 20 })]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Drug A Multi')).toBeInTheDocument());

    // Multi-dose Card Take opens SelectDoseModal (take mode); select d1 to consume it.
    fireEvent.click(screen.getByTitle(/تناول جرعة \(-1\)/));
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة التي تناولتها/)).toBeInTheDocument();
    });
    const takeD1Btn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd1');
    expect(takeD1Btn).toBeTruthy();
    fireEvent.click(takeD1Btn!);
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi')!;
      expect(med.doseConsumption?.d1).toBe(getTodayDateString());
      expect(effectiveCurrentPills(med)).toBe(19);
    });
    const takeLog = readLogs().find((l) => l.type === 'dose_taken');
    expect(takeLog?.doseId).toBe('d1');
    expect(takeLog?.amount).toBe(-1);

    // Second click must be Restore (not Take d2) — multi-dose opens selector
    await waitFor(() => expect(screen.getByTitle(/استرجاع الجرعة \(\+1\)/)).toBeInTheDocument());
    expect(screen.queryByTitle(/تناول جرعة/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/استرجاع الجرعة \(\+1\)/));
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    const d1Btn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd1');
    expect(d1Btn).toBeTruthy();
    expect(d1Btn).not.toBeDisabled();
    fireEvent.click(d1Btn!);

    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi')!;
      expect(effectiveCurrentPills(med)).toBe(20);
      const restoreLog = readLogs().find((l) => l.type === 'skipped_day');
      expect(restoreLog?.doseId).toBe('d1');
      expect(restoreLog?.amount).toBe(1);
      // d1 no longer marked consumed
      expect(med.doseConsumption?.d1).toBeUndefined();
    });

    // After restore lifecycle, next-dose resolution can still identify d1 as next
    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(getNextScheduledDose(med, new Date('2024-09-10T06:00:00'))?.id).toBe('d1');
  });

  it('multi: restoring d3 via selector uses amount 2 not dailyDose 4', async () => {
    const today = getTodayDateString();
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          currentPills: 16,
          // earlier slots auto-completed by time; only d3 manual
          doseConsumption: { d3: today },
          lastSyncDate: today,
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    // Late evening so d1/d2 are auto-completed
    vi.setSystemTime(new Date('2024-09-10T22:00:00'));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Drug A Multi')).toBeInTheDocument());

    await waitFor(() => expect(screen.getByTitle(/استرجاع الجرعة/)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/استرجاع الجرعة/));

    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    const d3Btn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd3');
    expect(d3Btn).toBeTruthy();
    expect(d3Btn).not.toBeDisabled();
    fireEvent.click(d3Btn!);

    await waitFor(() => {
      const restoreLog = readLogs().find((l) => l.type === 'skipped_day');
      expect(restoreLog?.doseId).toBe('d3');
      expect(restoreLog?.amount).toBe(2);
    });
  });

  it('auto-deduct-only does NOT offer Restore; card is non-interactive when only auto-elapsed', async () => {
    // PR #196: auto-elapsed-only is not Card Restore. Single slot fully auto-completed
    // → canTake false, canRestore false → no Take/Restore title on the card.
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          autoDeductEnabled: true,
          currentPills: 20,
          doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
          dosesPerDay: 1,
          dailyDose: 1,
          // no doseConsumption — elapsed only via auto
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    vi.setSystemTime(new Date('2024-09-10T20:00:00'));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Drug A Multi')).toBeInTheDocument());

    expect(screen.queryByTitle(/استرجاع الجرعة/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/^تناول جرعة/)).not.toBeInTheDocument();
  });

  it('suppresses Card Take button when auto-deduct is active (as requested)', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          autoDeductEnabled: true,
          currentPills: 30,
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 2, time: '14:00' },
          ],
          dosesPerDay: 2,
          dailyDose: 3,
        }),
      ])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    vi.setSystemTime(new Date('2024-09-10T12:00:00'));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Drug A Multi')).toBeInTheDocument());

    expect(screen.queryByTitle(/استرجاع الجرعة/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/تناول جرعة/)).not.toBeInTheDocument();
  });
});

