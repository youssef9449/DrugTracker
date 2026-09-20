/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Auto-deduct Restore button on MedicationCard — real App wiring.
 *
 * Contract (Issue #267):
 * - isAutoActive → no Manual Take button
 * - Restore requires durable deduction evidence (no pure-projection Auto Restore)
 * - manual Take/Restore when auto inactive
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';

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

import App from '@/App';
import type { ConsumptionLog, Medication } from '@/types';
import {
  getTodayDateString,
  isDoseSkippedOnDate,
  isDoseConsumedOnDate } from '@/utils/dateCalculations';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_GLOBAL_AUTO_DEDUCT_KEY = 'android_med_tracker_auto_deduct_v1';
const COMPACT_VIEW_KEY = 'android_med_tracker_compact_view_v1';

const TEST_DATE = '2024-09-10';
const MED_ID = 'med-auto-restore';

function readMeds(): Medication[] {
  return JSON.parse(localStorage.getItem(STORAGE_MEDS_KEY) || '[]');
}


/** Single-dose med with optional durable evidence via overrides. */
function makeSingleAuto(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Auto Restore Single',
    currentPills: 20,
    dailyDose: 2,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    category: 'مزمن',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: TEST_DATE,
    autoDeductEnabled: true,
    reminderEnabled: false,
    doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
    dosesPerDay: 1,
    ...overrides,
  };
}

/** Multi-dose fixture retained for layout/non-restore coverage if needed. */
function makeMultiAuto(overrides: Partial<Medication> = {}): Medication {
  return {
    id: MED_ID,
    name: 'Auto Restore Multi',
    currentPills: 30,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    category: 'مزمن',
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

/** Durable Exact Auto deduction for s1 (amount may differ from current schedule). */
function durableS1AutoLog(amount = -2): ConsumptionLog {
  return {
    id: `exact-auto:${MED_ID}:s1:${TEST_DATE}`,
    medicationId: MED_ID,
    medicationName: 'Test',
    doseId: 's1',
    amount,
    type: 'exact_auto',
    timestamp: `${TEST_DATE}T08:00:00.000Z`,
    date: TEST_DATE,
    description: 'Exact Auto',
  };
}

async function clickRestore(medId: string = MED_ID): Promise<void> {
  fireEvent.click(screen.getByTestId(`restore-dose-${medId}`));
}

function cardRoot(name: string): HTMLElement {
  const title = screen.getByText(name);
  // Walk up to the card container (id starts with med-card-)
  let el: HTMLElement | null = title;
  while (el && !el.id?.startsWith('med-card-')) {
    el = el.parentElement;
  }
  if (!el) throw new Error(`card root not found for ${name}`);
  return el;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 16:00 — morning and afternoon slots elapsed.
  vi.setSystemTime(new Date(`${TEST_DATE}T16:00:00`));
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true');
  localStorage.setItem(COMPACT_VIEW_KEY, 'false');
  window.history.replaceState({}, '', '/?tab=stock');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Durable evidence Restore (Issue #267 — no pure-projection Auto Restore)
// ---------------------------------------------------------------------------
describe('MedicationCard Restore — durable Exact evidence', () => {
  it('Compact: shows restore from durable log; amount is historical; stock reverses', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'true');
    // Schedule amount edited to 5; historical Exact log still -2.
    const med = makeSingleAuto({
      currentPills: 18,
      doseConsumptionHistory: { s1: [TEST_DATE] },
      doseSchedule: [{ id: 's1', amount: 5, time: '08:00' }],
    });
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([med]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([durableS1AutoLog(-2)]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.getByTestId(`restore-dose-${MED_ID}`)).toBeInTheDocument();
    expect(screen.queryAllByTitle(/تناول جرعة/)).toHaveLength(0);

    const pillsBefore = readMeds()[0].currentPills;
    await clickRestore();

    await waitFor(() => {
      const m = readMeds()[0];
      expect(m.currentPills).toBe(pillsBefore + 2);
      expect(isDoseConsumedOnDate(m, 's1', getTodayDateString())).toBe(false);
    });
  });

  it('Detailed: same durable restore path', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'false');
    const med = makeSingleAuto({
      currentPills: 18,
      doseConsumptionHistory: { s1: [TEST_DATE] },
    });
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([med]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([durableS1AutoLog(-2)]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.getByTestId(`restore-dose-${MED_ID}`)).toBeInTheDocument();

    const pillsBefore = readMeds()[0].currentPills;
    await clickRestore();

    await waitFor(() => {
      expect(readMeds()[0].currentPills).toBe(pillsBefore + 2);
    });
  });

  it('elapsed projection without durable evidence: no Restore UI, stock unchanged', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'true');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).toBeNull();
    expect(readMeds()[0].currentPills).toBe(20);
  });
});

describe('MedicationCard Auto ON → no Manual Take', () => {
  it('when isAutoActive, Take button is never shown (even before slot time)', async () => {
    vi.setSystemTime(new Date(`${TEST_DATE}T07:00:00`));
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true');
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeSingleAuto({ autoDeductEnabled: true })])
    );
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryAllByTitle(/تناول جرعة/)).toHaveLength(0);
    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).toBeNull();
  });
});

describe('MedicationCard Manual Take → Restore (auto OFF)', () => {
  it('Take then manual Restore works; pure-projection auto-restore never appears', async () => {
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'false');
    vi.setSystemTime(new Date(`${TEST_DATE}T10:00:00`));

    const med = makeSingleAuto({
      autoDeductEnabled: false,
      doseSchedule: [{ id: 's1', amount: 2, time: '08:00' }],
    });
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([med]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();

    const takeBtn = screen.getByTitle(/تناول جرعة/);
    const pillsBefore = readMeds()[0].currentPills;
    fireEvent.click(takeBtn);

    await waitFor(() => {
      const m = readMeds()[0];
      expect(isDoseConsumedOnDate(m, 's1', getTodayDateString())).toBe(true);
      expect(m.currentPills).toBe(pillsBefore - 2);
    });

    const restoreBtn = await screen.findByTestId(`restore-dose-${MED_ID}`);
    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    fireEvent.click(restoreBtn);

    await waitFor(() => {
      const m = readMeds()[0];
      expect(isDoseConsumedOnDate(m, 's1', getTodayDateString())).toBe(false);
      expect(isDoseSkippedOnDate(m, 's1', getTodayDateString())).toBe(true);
      expect(m.currentPills).toBe(pillsBefore);
      expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
describe('MedicationCard layout — Name / Category+Status / Actions separation', () => {
  it('Compact: name is independent of category/status row', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'true');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    const root = cardRoot('Auto Restore Single');
    const nameEl = within(root).getByText('Auto Restore Single');
    expect(nameEl.tagName.toLowerCase()).toBe('h3');

    // Category text exists and is NOT inside the name heading
    const category = within(root).getByText('مزمن');
    expect(nameEl.contains(category)).toBe(false);

    // Status badge text (آمن or days) is also outside the name heading
    // Name heading children should be only the name text
    expect(nameEl.textContent?.trim()).toBe('Auto Restore Single');
  });

  it('Detailed: name is independent of category/status row', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'false');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    const root = cardRoot('Auto Restore Single');
    const nameEl = within(root).getByText('Auto Restore Single');
    expect(nameEl.tagName.toLowerCase()).toBe('h3');

    const category = within(root).getByText('مزمن');
    expect(nameEl.contains(category)).toBe(false);
    expect(nameEl.textContent?.trim()).toBe('Auto Restore Single');
  });
});
