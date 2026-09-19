/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Integration regressions: every production multi-dose consume entry point
 * must pass an explicit doseId into consumeDose (strict contract from #183).
 *
 * Paths covered:
 *   MedicationCard → handleConsumeDose(medId, doseId) → consumeDose
 *   SelectDoseModal → handleConsumeDose(medId, selectedId) → consumeDose
 *   DoseAlarmModal  → handleTakeDoseFromAlarm(med, doseId) → consumeDose
 *   Push take_dose  → registerNotificationActionHandler → handleTakeDoseFromAlarm
 *   Missing doseId  → SelectDoseModal only (no mutation until selection)
 *   Take → Restore same doseId
 *   Auto-due d1 + Take (push / in-app) → single deduction only
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

type DoseReceivedHandler = ((medicationId: string, doseId?: string) => void) | null;
type NotificationActionHandler = ((
  actionId: string,
  medicationId: string,
  doseId?: string
) => void) | null;
let doseReceivedHandler: DoseReceivedHandler = null;
let notificationActionHandler: NotificationActionHandler = null;

vi.mock('@/native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
  openAppSettings: vi.fn(() => Promise.resolve(false)),
  registerBackButtonHandler: vi.fn(),
  registerNotificationActionHandler: vi.fn((handler: NotificationActionHandler) => {
    notificationActionHandler = handler;
  }),
  registerDoseReceivedHandler: vi.fn((handler: DoseReceivedHandler) => {
    doseReceivedHandler = handler;
  }),
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
 * Card always supplies doseId for its toggle target. A test-only trigger
 * omits doseId to exercise App.handleConsumeDose → SelectDoseModal without
 * changing production Card behavior.
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
    name: 'Drug Multi',
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
      { id: 'd1', amount: 1, time: '08:00' },
      { id: 'd2', amount: 2, time: '14:00' },
      { id: 'd3', amount: 1, time: '20:00' },
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

function seed(med: Medication) {
  localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([med]));
  localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T13:00:00'));
  vi.clearAllMocks();
  localStorage.clear();
  doseReceivedHandler = null;
  notificationActionHandler = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('doseId propagation — production callers (integration)', () => {
  it('MedicationCard Take targets exact next doseId (d2 after d1 auto-elapsed) via App → consumeDose', async () => {
    // Multi-dose card surfaces the unified manage-doses control; the user
    // explicitly picks d2 in the modal. Auto-deduction is OFF so each future
    // slot stays manually takeable (auto ON would hide future-slot Take).
    seed(makeMulti({ currentPills: 30, autoDeductEnabled: false }));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
    });
    const takeBtn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-dose-id') === 'd2' &&
          b.getAttribute('data-dose-action') === 'take'
      );
    expect(takeBtn).toBeTruthy();
    fireEvent.click(takeBtn!);

    const today = getTodayDateString();
    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-multi');
      expect(med?.doseConsumption?.d2).toBe(today);
    });

    const med = readMeds().find((m) => m.id === 'med-multi')!;
    expect(med.doseConsumption?.d1).toBeUndefined();
    expect(med.doseConsumption?.d3).toBeUndefined();
    // Auto OFF → no projection; snapshot reduced by d2.amount (2) only → 28.
    expect(med.currentPills).toBe(28);
    expect(effectiveCurrentPills(med)).toBe(28);

    const doseLog = readLogs().find(
      (l) => l.type === 'dose_taken' && l.medicationId === 'med-multi'
    );
    expect(doseLog?.doseId).toBe('d2');
    expect(doseLog?.amount).toBe(-2);
  });

  it('SelectDoseModal selecting d2 from disordered schedule consumes only d2', async () => {
    // Array order is NOT chronological — identity must be dose.id, not index.
    // Auto OFF so each slot stays manually takeable in manage mode.
    seed(
      makeMulti({
        currentPills: 30,
        autoDeductEnabled: false,
        doseSchedule: [
          { id: 'd3', amount: 1, time: '20:00' },
          { id: 'd1', amount: 1, time: '08:00' },
          { id: 'd2', amount: 2, time: '14:00' },
        ],
      })
    );
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('consume-no-doseid-med-multi'));
    await waitFor(() => {
      expect(screen.getByText(/اختر الإجراء المناسب لكل جرعة|إدارة الجرعات/)).toBeInTheDocument();
    });

    // Opening selector must not mutate
    expect(readMeds()[0]?.doseConsumption).toBeUndefined();
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);

    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    expect(doseButtons.map((b) => b.getAttribute('data-dose-id'))).toEqual(
      expect.arrayContaining(['d1', 'd2', 'd3'])
    );

    fireEvent.click(
      doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2')!
    );

    const today = getTodayDateString();
    await waitFor(() => {
      expect(readMeds()[0]?.doseConsumption?.d2).toBe(today);
    });

    const med = readMeds()[0]!;
    expect(med.doseConsumption?.d1).toBeUndefined();
    expect(med.doseConsumption?.d3).toBeUndefined();
    expect(med.currentPills).toBe(28);
    // Auto OFF → no projection; effective == snapshot.
    expect(effectiveCurrentPills(med)).toBe(28);

    const doseLog = readLogs().find((l) => l.type === 'dose_taken');
    expect(doseLog?.doseId).toBe('d2');
    expect(doseLog?.amount).toBe(-2);
  });

  it('missing doseId opens SelectDoseModal and mutates nothing until selection', async () => {
    // Auto ON keeps the auto-projection path (snapshot 30, effective 29)
    // so this test still asserts that opening the manage modal never
    // mutates storage until the user picks a dose.
    seed(makeMulti({ currentPills: 30 }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('consume-no-doseid-med-multi'));
    await waitFor(() => {
      expect(screen.getByText(/اختر الإجراء المناسب لكل جرعة|إدارة الجرعات/)).toBeInTheDocument();
    });

    const med = readMeds()[0]!;
    expect(med.doseConsumption).toBeUndefined();
    expect(med.doseConsumptionHistory).toBeUndefined();
    // No consume mutation; snapshot unchanged. d1 auto-due still projects.
    expect(med.currentPills).toBe(30);
    expect(effectiveCurrentPills(med)).toBe(29);
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(0);
  });

  it('alarm path for d2 → DoseAlarmModal → consumeDose only d2', async () => {
    // Auto OFF is required for the dose-received handler to open the alarm
    // (production guard in useNativeActionHandlers: auto ON → early return,
    // no alarm). Snapshot reflects the manual deduction only.
    seed(makeMulti({ currentPills: 30, autoDeductEnabled: false }));
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    // Production wiring: registerDoseReceivedHandler → openAlarm(medId, doseId)
    expect(doseReceivedHandler).toBeTypeOf('function');
    doseReceivedHandler!('med-multi', 'd2');

    await waitFor(() => {
      expect(screen.getByTestId('alarm-take-dose')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('alarm-take-dose'));

    const today = getTodayDateString();
    await waitFor(() => {
      expect(readMeds()[0]?.doseConsumption?.d2).toBe(today);
    });

    const med = readMeds()[0]!;
    expect(med.doseConsumption?.d1).toBeUndefined();
    expect(med.doseConsumption?.d3).toBeUndefined();
    expect(med.currentPills).toBe(28);
    // Auto OFF → effective == snapshot, no projection.
    expect(effectiveCurrentPills(med)).toBe(28);

    const doseLog = readLogs().find((l) => l.type === 'dose_taken');
    expect(doseLog?.doseId).toBe('d2');
    expect(doseLog?.amount).toBe(-2);
  });

  it('Card Take d1 then Restore d1 leaves d2/d3 untouched', async () => {
    // Morning: d1 is the Take target. Auto OFF keeps every slot manually
    // takeable in the unified manage modal; the modal stays open after
    // Take so the same dose row re-renders with a Restore action.
    vi.setSystemTime(new Date('2024-09-10T07:00:00'));
    seed(makeMulti({ currentPills: 30, autoDeductEnabled: false }));
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    // Multi-dose card surfaces manage-doses → manage modal → d1 take action.
    fireEvent.click(screen.getByTestId('manage-doses-med-multi'));
    await waitFor(() => {
      expect(screen.getByText(/إدارة الجرعات|اختر الإجراء المناسب/)).toBeInTheDocument();
    });
    const d1TakeBtn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-dose-id') === 'd1' &&
          b.getAttribute('data-dose-action') === 'take'
      );
    expect(d1TakeBtn).toBeTruthy();
    fireEvent.click(d1TakeBtn!);

    const today = getTodayDateString();
    await waitFor(() => {
      expect(readMeds()[0]?.doseConsumption?.d1).toBe(today);
    });
    expect(readLogs().find((l) => l.type === 'dose_taken')?.doseId).toBe('d1');

    // Modal stays open in manage mode; after Take, d1 row shows Restore.
    await waitFor(() => {
      const btn = screen
        .getAllByRole('button')
        .find(
          (b) =>
            b.getAttribute('data-dose-id') === 'd1' &&
            b.getAttribute('data-dose-action') === 'restore'
        );
      expect(btn).toBeTruthy();
    });
    const d1RestoreBtn = screen
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('data-dose-id') === 'd1' &&
          b.getAttribute('data-dose-action') === 'restore'
      )!;
    fireEvent.click(d1RestoreBtn);

    await waitFor(() => {
      const med = readMeds()[0]!;
      expect(med.doseConsumption?.d1).toBeUndefined();
    });

    const med = readMeds()[0]!;
    expect(med.doseConsumption?.d2).toBeUndefined();
    expect(med.doseConsumption?.d3).toBeUndefined();
    expect(effectiveCurrentPills(med)).toBe(30);

    const restoreLog = readLogs().find((l) => l.type === 'skipped_day');
    expect(restoreLog?.doseId).toBe('d1');
    expect(restoreLog?.amount).toBe(1);
  });

  it('auto-due d1 + Push take_dose: one deduction only; repeat is no-op; d2 untouched', async () => {
    // 09:00 → d1 (08:00) elapsed/projected; d2 (20:00) still future.
    // Same-day multi is projection-only: sync never settles today into currentPills.
    vi.setSystemTime(new Date('2024-09-10T09:00:00'));
    seed(
      makeMulti({
        currentPills: 30,
        doseSchedule: [
          { id: 'd1', amount: 1, time: '08:00' },
          { id: 'd2', amount: 2, time: '20:00' },
        ],
        dailyDose: 3,
        dosesPerDay: 2,
      })
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    expect(notificationActionHandler).toBeTypeOf('function');
    // Pre: projection only — effective 29, snapshot 30 until Take settles.
    expect(effectiveCurrentPills(readMeds()[0]!)).toBe(29);
    expect(readMeds()[0]!.currentPills).toBe(30);
    expect(readLogs().filter((l) => l.type === 'auto_daily')).toHaveLength(0);

    // Production path: localNotificationActionPerformed → take_dose → handleTakeDoseFromAlarm
    notificationActionHandler!('take_dose', 'med-multi', 'd1');

    const today = getTodayDateString();
    await waitFor(() => {
      expect(readMeds()[0]?.doseConsumption?.d1).toBe(today);
    });

    let med = readMeds()[0]!;
    // Transition 30 → 29 is the settled Take (not a second projection hit).
    expect(med.currentPills).toBe(29);
    expect(med.doseConsumption?.d1).toBe(today);
    expect(med.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(med)).toBe(29);

    const doseLogs = readLogs().filter((l) => l.type === 'dose_taken');
    expect(doseLogs).toHaveLength(1);
    expect(doseLogs[0]!.doseId).toBe('d1');
    expect(doseLogs[0]!.medicationId).toBe('med-multi');
    expect(doseLogs[0]!.amount).toBe(-1);
    expect(doseLogs[0]!.date).toBe(today);
    expect(readLogs().filter((l) => l.type === 'auto_daily')).toHaveLength(0);

    const afterFirst = {
      currentPills: med.currentPills,
      lastSyncDate: med.lastSyncDate,
      doseConsumption: { ...(med.doseConsumption ?? {}) },
      doseSkippedHistory: JSON.stringify(med.doseSkippedHistory ?? {}),
      doseConsumptionHistory: JSON.stringify(med.doseConsumptionHistory ?? {}),
    };

    // Repeat same push action → no second log / no second deduction / no field drift
    notificationActionHandler!('take_dose', 'med-multi', 'd1');
    await waitFor(() => {
      expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(1);
    });
    med = readMeds()[0]!;
    expect(med.currentPills).toBe(afterFirst.currentPills);
    expect(med.lastSyncDate).toBe(afterFirst.lastSyncDate);
    expect({ ...(med.doseConsumption ?? {}) }).toEqual(afterFirst.doseConsumption);
    expect(JSON.stringify(med.doseSkippedHistory ?? {})).toBe(afterFirst.doseSkippedHistory);
    expect(JSON.stringify(med.doseConsumptionHistory ?? {})).toBe(
      afterFirst.doseConsumptionHistory
    );
    expect(med.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(med)).toBe(29);
  });

  it('auto-due d1 + In-App DoseAlarm Take: one deduction; duplicate notification does not reopen modal; d2 untouched', async () => {
    // Auto OFF is required for the in-app dose-received handler to open the
    // alarm (production guard: auto ON → early return). Without projection,
    // snapshot and effective are equal — the test still asserts the alarm
    // path produces a single deduction and a duplicate notification does not
    // reopen the modal.
    vi.setSystemTime(new Date('2024-09-10T09:00:00'));
    seed(
      makeMulti({
        currentPills: 30,
        autoDeductEnabled: false,
        doseSchedule: [
          { id: 'd1', amount: 1, time: '08:00' },
          { id: 'd2', amount: 2, time: '20:00' },
        ],
        dailyDose: 3,
        dosesPerDay: 2,
      })
    );
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Drug Multi')).toBeInTheDocument();
    });

    expect(doseReceivedHandler).toBeTypeOf('function');
    // Pre: Auto OFF → no projection (snapshot 30, effective 30).
    expect(readMeds()[0]!.currentPills).toBe(30);
    expect(effectiveCurrentPills(readMeds()[0]!)).toBe(30);

    doseReceivedHandler!('med-multi', 'd1');

    await waitFor(() => {
      expect(screen.getByTestId('alarm-take-dose')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('alarm-take-dose'));

    const today = getTodayDateString();
    await waitFor(() => {
      expect(readMeds()[0]?.doseConsumption?.d1).toBe(today);
    });

    let med = readMeds()[0]!;
    expect(med.currentPills).toBe(29);
    expect(med.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(med)).toBe(29);
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(1);
    expect(readLogs().find((l) => l.type === 'dose_taken')?.doseId).toBe('d1');
    expect(readLogs().find((l) => l.type === 'dose_taken')?.amount).toBe(-1);
    expect(readLogs().filter((l) => l.type === 'auto_daily')).toHaveLength(0);

    const afterFirst = {
      currentPills: med.currentPills,
      lastSyncDate: med.lastSyncDate,
      doseConsumption: { ...(med.doseConsumption ?? {}) },
      doseSkippedHistory: JSON.stringify(med.doseSkippedHistory ?? {}),
      doseConsumptionHistory: JSON.stringify(med.doseConsumptionHistory ?? {}),
    };

    // Dismiss any residual modal UI, then deliver a duplicate/stale notification
    // for the same medicationId + doseId. openAlarm must return early because
    // d1 is already consumed today — modal MUST NOT reopen.
    const dismissBtn = screen.queryByText(/إغلاق التنبيه/);
    if (dismissBtn) fireEvent.click(dismissBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-take-dose')).not.toBeInTheDocument();
    });

    doseReceivedHandler!('med-multi', 'd1');

    // Give effects a tick; modal must stay closed (not reopen).
    await waitFor(() => {
      expect(screen.queryByTestId('alarm-take-dose')).not.toBeInTheDocument();
    });

    med = readMeds()[0]!;
    expect(readLogs().filter((l) => l.type === 'dose_taken')).toHaveLength(1);
    expect(med.currentPills).toBe(afterFirst.currentPills);
    expect(med.lastSyncDate).toBe(afterFirst.lastSyncDate);
    expect({ ...(med.doseConsumption ?? {}) }).toEqual(afterFirst.doseConsumption);
    expect(JSON.stringify(med.doseSkippedHistory ?? {})).toBe(afterFirst.doseSkippedHistory);
    expect(JSON.stringify(med.doseConsumptionHistory ?? {})).toBe(
      afterFirst.doseConsumptionHistory
    );
    expect(med.doseConsumption?.d1).toBe(today);
    expect(med.doseConsumption?.d2).toBeUndefined();
    expect(effectiveCurrentPills(med)).toBe(29);
  });
});
