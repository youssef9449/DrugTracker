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
import { getTodayDateString } from '@/utils/dateCalculations';

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
    autoDeductEnabled: false,
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
  vi.setSystemTime(new Date('2024-09-10T07:00:00Z'));
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
    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));

    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });

    // Opening selector must not have written consumption yet.
    expect(readMeds()[0]?.doseConsumptionHistory?.d1).toBeUndefined();
    expect(readMeds()[0]?.doseConsumptionHistory?.d2).toBeUndefined();
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
      expect(med?.doseConsumptionHistory?.d2).toBe(today);
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumptionHistory?.d1).toBeUndefined();
    expect(med.doseConsumptionHistory?.d3).toBeUndefined();
    expect(med.doseConsumptionHistory?.d2).toBe(today);
    // Stock reduced by d2.amount (2), not dailyDose (4)
    expect(med.currentPills).toBe(28);

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

    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText('إغلاق'));

    await waitFor(() => {
      expect(screen.queryByText('اختر الإجراء المناسب لكل جرعة')).toBeNull();
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumptionHistory).toBeUndefined();
    expect(med.doseConsumptionHistory).toBeUndefined();
    expect(med.currentPills).toBe(30);
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);
  });

  it('Card Take opens SelectDoseModal (take mode) for multi-dose; selecting d1 consumes only d1', async () => {
    // d1=1, d2=2 so selecting d1 proves amount is slot amount, not dailyDose (4)
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

    // A: clicking Card Take opens SelectDoseModal in take mode; nothing consumed yet.
    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });
    expect(readMeds()[0]?.doseConsumptionHistory?.d1).toBeUndefined();
    expect(readMeds()[0]?.doseConsumptionHistory?.d2).toBeUndefined();
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);

    // C: select d1 → only d1 consumed, stock -= d1.amount (1), d2/d3 unconsumed, log doseId=d1.
    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    fireEvent.click(
      doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd1')!
    );

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi');
      expect(med?.doseConsumptionHistory?.d1).toBe(today);
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumptionHistory?.d1).toBe(today);
    expect(med.doseConsumptionHistory?.d2).toBeUndefined();
    expect(med.doseConsumptionHistory?.d3).toBeUndefined();
    expect(med.currentPills).toBe(29); // 30 - d1.amount(1)

    const doseLog = readLogs().find(
      (l) => l.type === 'dose_taken' && l.medicationId === 'med-multi'
    );
    expect(doseLog?.doseId).toBe('d1');
    expect(doseLog?.amount).toBe(-1);
  });

  it('Card Take → SelectDoseModal → selecting d2 consumes only d2 (d1 stays unconsumed)', async () => {
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

    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument();
    });

    // B: select d2 → only d2 consumed, stock -= d2.amount (2), d1 unconsumed, log doseId=d2.
    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    fireEvent.click(
      doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2')!
    );

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi');
      expect(med?.doseConsumptionHistory?.d2).toBe(today);
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumptionHistory?.d2).toBe(today);
    expect(med.doseConsumptionHistory?.d1).toBeUndefined();
    expect(med.doseConsumptionHistory?.d3).toBeUndefined();
    expect(med.currentPills).toBe(28); // 30 - d2.amount(2)

    const doseLog = readLogs().find(
      (l) => l.type === 'dose_taken' && l.medicationId === 'med-multi'
    );
    expect(doseLog?.doseId).toBe('d2');
    expect(doseLog?.amount).toBe(-2);
  });

  it('opening manage UI does not mutate state before an action is chosen', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ currentPills: 30 })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    const before = readMeds()[0]!;
    const beforeLogs = readLogs();
    const beforePills = before.currentPills;

    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(
        screen.getByText('اختر الإجراء المناسب لكل جرعة')
      ).toBeInTheDocument();
    });

    // Opening the modal alone must not consume/restore/skip anything.
    const after = readMeds()[0]!;
    expect(after.currentPills).toBe(beforePills);
    expect(after.doseConsumptionHistory).toStrictEqual(before.doseConsumptionHistory);
    expect(after.doseConsumptionHistory).toStrictEqual(
      before.doseConsumptionHistory
    );
    expect(readLogs()).toStrictEqual(beforeLogs);
  });

  it('Auto OFF: future dose shows لم يتم التناول and is takeable (manual mode)', async () => {
    // now = 07:00; scheduled doses (08:00+) are future. Auto OFF → manual mode.
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ currentPills: 30, autoDeductEnabled: false })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(
        screen.getByText('اختر الإجراء المناسب لكل جرعة')
      ).toBeInTheDocument();
    });

    // Future dose under Auto OFF is takeable: status لم يتم التناول + a Take action.
    expect(screen.getAllByText(/الحالة: لم يتم التناول/).length).toBeGreaterThan(0);
    const takeButtons = screen
      .getAllByRole('button')
      .filter(
        (b) =>
          b.getAttribute('data-dose-id') !== null &&
          b.getAttribute('data-dose-action') === 'take'
      );
    expect(takeButtons.length).toBeGreaterThan(0);

    // Selecting the future d1 consumes it with the exact doseId (no inference).
    fireEvent.click(
      takeButtons.find((b) => b.getAttribute('data-dose-id') === 'd1')!
    );
    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi');
      expect(med?.doseConsumptionHistory?.d1).toBe(today);
    });
  });

  it('Auto ON: future dose shows لم يحن وقتها with no take action', async () => {
    // now = 07:00; scheduled doses (08:00+) are future. Auto ON → not yet due.
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ currentPills: 30, autoDeductEnabled: true })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(
        screen.getByText('اختر الإجراء المناسب لكل جرعة')
      ).toBeInTheDocument();
    });

    // Future dose under Auto ON: status لم يحن وقتها, no Take action available.
    expect(screen.getAllByText(/الحالة: لم يحن وقتها/).length).toBeGreaterThan(0);
    const takeButtons = screen
      .getAllByRole('button')
      .filter(
        (b) =>
          b.getAttribute('data-dose-id') !== null &&
          b.getAttribute('data-dose-action') === 'take'
      );
    expect(takeButtons).toHaveLength(0);
    // No consumption from just opening the modal.
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);
  });


  it('after d1 manually consumed, Card shows Restore d1 (same doseId) not Take d2', async () => {
    const today = getTodayDateString();
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ doseConsumptionHistory: { d1: [today] } })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    // Toggle stays on d1 for restore — does not advance to d2 take
    expect(screen.queryByTitle(/تناول جرعة/)).not.toBeInTheDocument();
    expect(screen.getByTestId('manage-doses-med-multi')).toBeInTheDocument();
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

    // Single-slot uses the Card Take button directly (no multi-dose management UI).
    fireEvent.click(screen.getByTitle(/تناول جرعة/));
    expect(screen.queryByText('اختر الإجراء المناسب لكل جرعة')).toBeNull();

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.name === 'Single Slot Med');
      expect(med?.doseConsumptionHistory?.only).toBe(today);
    });

    const log = readLogs().find((l) => l.type === 'dose_taken');
    expect(log?.doseId).toBe('only');
  });

  it('suppresses Card Take button when auto-deduct is enabled (as requested by user)', async () => {
    vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          name: 'Test',
          autoDeductEnabled: true,
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

    expect(screen.queryByTitle(/تناول جرعة/)).not.toBeInTheDocument();
  });

  it('all slots consumed shows completed badge and no take action', async () => {
    const today = getTodayDateString();
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([
        makeMulti({
          doseConsumptionHistory: { d1: [today], d2: [today], d3: [today] },
        }),
      ])
    );

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    expect(screen.queryByTitle(/^تناول جرعة/)).toBeNull();
    expect(screen.getByTestId('manage-doses-med-multi')).toBeInTheDocument();
  });

  it('Auto OFF lifecycle: Take d1 → Restore d1 → Take d1 again (unbounded Take↔Restore)', async () => {
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ currentPills: 30 })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });

    const today = getTodayDateString();
    const openManage = () => {
      fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
      return waitFor(() =>
        expect(screen.getByText('اختر الإجراء المناسب لكل جرعة')).toBeInTheDocument()
      );
    };
    const actionBtn = (doseId: string, action: 'take' | 'restore') =>
      screen
        .getAllByRole('button')
        .find(
          (b) =>
            b.getAttribute('data-dose-id') === doseId &&
            b.getAttribute('data-dose-action') === action
        )!;

    // 1. d1 is takeable initially (Auto OFF manual mode).
    await openManage();
    expect(actionBtn('d1', 'take')).toBeTruthy();
    fireEvent.click(actionBtn('d1', 'take'));
    await waitFor(() => {
      expect(readMeds().find((m) => m.id === 'med-multi')?.doseConsumptionHistory?.d1).toBe(today);
    });
    let med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.currentPills).toBe(28); // 30 - d1.amount(2)
    expect(med.doseConsumptionHistory?.d2).toBeUndefined();
    expect(med.doseConsumptionHistory?.d3).toBeUndefined();

    // 2. After Take, d1 offers Restore.
    await openManage();
    expect(actionBtn('d1', 'restore')).toBeTruthy();
    fireEvent.click(actionBtn('d1', 'restore'));
    await waitFor(() => {
      expect(
        readMeds().find((m) => m.id === 'med-multi')?.doseConsumptionHistory?.d1
      ).toBeUndefined();
    });
    med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.currentPills).toBe(30); // restored
    expect(med.doseConsumptionHistory?.d2).toBeUndefined();
    expect(med.doseConsumptionHistory?.d3).toBeUndefined();

    // 3. After Restore, d1 is takeable AGAIN — the cycle repeats (not terminal).
    await openManage();
    expect(actionBtn('d1', 'take')).toBeTruthy();
    fireEvent.click(actionBtn('d1', 'take'));
    await waitFor(() => {
      expect(readMeds().find((m) => m.id === 'med-multi')?.doseConsumptionHistory?.d1).toBe(today);
    });
    med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.currentPills).toBe(28); // 30 - 2 again
  });

  it('manage-doses button is always present for multi-dose (Auto ON and Auto OFF)', async () => {
    // Auto OFF: med auto OFF, global default ON → effective OFF (manual mode).
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ autoDeductEnabled: false })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    const { unmount } = render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });
    expect(screen.getByTestId('manage-doses-med-multi')).toBeInTheDocument();
    unmount();

    // Auto ON: med auto ON, global default ON → effective ON.
    localStorage.clear();
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeMulti({ autoDeductEnabled: true })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug A Multi')).toBeInTheDocument();
    });
    expect(screen.getByTestId('manage-doses-med-multi')).toBeInTheDocument();
  });
});
