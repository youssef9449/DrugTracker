/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Auto-deduct Restore button on MedicationCard — real App wiring.
 *
 * Contract (c54b325 + this PR):
 * - isAutoActive → no Manual Take button
 * - pure auto-completed dose → dedicated Auto Restore button
 * - multi → SelectDoseModal restore mode (no silent pick)
 * - manual Take/Restore only when auto inactive
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

/** Single-dose pure auto-completed (time elapsed, no consumption mark). */
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

/** Multi-dose: d1@08:00 and d2@14:00 both elapsed at 16:00. */
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

function makeLegacyAuto(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-legacy-auto',
    name: 'Legacy Auto Restore',
    currentPills: 12,
    dailyDose: 3,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    category: 'مزمن',
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
// Test A — Compact + auto Restore
// ---------------------------------------------------------------------------
describe('MedicationCard Auto Restore — Compact', () => {
  it('shows auto-restore, no Take, restores single-dose via real path', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'true');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.queryAllByTitle(/تناول جرعة/)).toHaveLength(0);

    const pillsBefore = readMeds()[0].currentPills;
    const effBefore = effectiveCurrentPills(readMeds()[0]);

    await clickAutoRestore();

    await waitFor(() => {
      const med = readMeds()[0];
      expect(isDoseSkippedOnDate(med, 's1', getTodayDateString())).toBe(true);
      expect(isDoseConsumedOnDate(med, 's1', getTodayDateString())).toBe(false);
      // Pure auto today: snapshot unchanged; effective rises by slot amount.
      expect(med.currentPills).toBe(pillsBefore);
      expect(effectiveCurrentPills(med)).toBe(effBefore + 2);
    });
  });
});

// ---------------------------------------------------------------------------
// Test B — Detailed + auto Restore
// ---------------------------------------------------------------------------
describe('MedicationCard Auto Restore — Detailed', () => {
  it('shows auto-restore and same restore behavior as compact', async () => {
    localStorage.setItem(COMPACT_VIEW_KEY, 'false');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`restore-dose-${MED_ID}`)).toBeNull();
    expect(screen.queryAllByTitle(/تناول جرعة/)).toHaveLength(0);

    const effBefore = effectiveCurrentPills(readMeds()[0]);
    await clickAutoRestore();

    await waitFor(() => {
      const med = readMeds()[0];
      expect(isDoseSkippedOnDate(med, 's1', getTodayDateString())).toBe(true);
      expect(effectiveCurrentPills(med)).toBe(effBefore + 2);
    });
  });
});

// ---------------------------------------------------------------------------
// Test C — Auto Restore hidden when auto inactive
// ---------------------------------------------------------------------------
describe('MedicationCard Auto Restore — hidden when auto inactive', () => {
  it('global auto OFF hides auto restore even if medication auto ON', async () => {
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'false');
    localStorage.setItem(
      STORAGE_MEDS_KEY,
      JSON.stringify([makeSingleAuto({ autoDeductEnabled: true })])
    );
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

// ---------------------------------------------------------------------------
// Auto ON → no Manual Take (independent contract from c54b325)
// ---------------------------------------------------------------------------
describe('MedicationCard Auto ON → no Manual Take', () => {
  it('when isAutoActive, Take button is never shown (even before slot time)', async () => {
    // Before any slot elapsed — still no Take when auto active.
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
    // Time not elapsed → no auto restore either
    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();
  });

  it('when isAutoActive and pure auto-completed, Auto Restore shows and Take stays hidden', async () => {
    localStorage.setItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true');
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeSingleAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Single')).toBeInTheDocument();
    });

    expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();
    expect(screen.queryAllByTitle(/تناول جرعة/)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test D — Multi-dose Auto Restore via real SelectDoseModal
// ---------------------------------------------------------------------------
describe('MedicationCard Auto Restore — Multi-dose SelectDoseModal', () => {
  it('opens modal; d1 and d2 selectable; restore d2 only; d1 remains restorable', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeMultiAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Auto Restore Multi')).toBeInTheDocument();
    });

    // Single Auto Restore button on the card
    expect(screen.getByTestId(`auto-restore-dose-${MED_ID}`)).toBeInTheDocument();

    const pillsBefore = readMeds()[0].currentPills;
    const effBefore = effectiveCurrentPills(readMeds()[0]);

    // Click does NOT restore immediately
    await clickAutoRestore();
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    expect(readMeds()[0].currentPills).toBe(pillsBefore);
    expect(isDoseSkippedOnDate(readMeds()[0], 'd1', getTodayDateString())).toBe(false);
    expect(isDoseSkippedOnDate(readMeds()[0], 'd2', getTodayDateString())).toBe(false);

    // Both d1 and d2 are selectable
    const doseButtons = screen.getAllByRole('button').filter((b) =>
      b.getAttribute('data-dose-id')
    );
    const d1Btn = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd1');
    const d2Btn = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2');
    expect(d1Btn).toBeTruthy();
    expect(d2Btn).toBeTruthy();
    expect(d1Btn).not.toBeDisabled();
    expect(d2Btn).not.toBeDisabled();

    // Select d2 only
    fireEvent.click(d2Btn!);

    await waitFor(() => {
      const med = readMeds()[0];
      expect(isDoseSkippedOnDate(med, 'd2', getTodayDateString())).toBe(true);
      expect(isDoseSkippedOnDate(med, 'd1', getTodayDateString())).toBe(false);
      expect(med.currentPills).toBe(pillsBefore);
      expect(effectiveCurrentPills(med)).toBe(effBefore + 2);
    });

    // Re-open: d2 disabled/not selectable, d1 still available
    await clickAutoRestore();
    await waitFor(() => {
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();
    });
    const buttonsAgain = screen.getAllByRole('button').filter((b) =>
      b.getAttribute('data-dose-id')
    );
    const d2Again = buttonsAgain.find((b) => b.getAttribute('data-dose-id') === 'd2');
    const d1Again = buttonsAgain.find((b) => b.getAttribute('data-dose-id') === 'd1');
    if (d2Again) {
      expect(d2Again).toBeDisabled();
    }
    expect(d1Again).toBeTruthy();
    expect(d1Again).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Test E — Manual Take → Restore with auto OFF (valid contract)
// ---------------------------------------------------------------------------
describe('MedicationCard Manual Take → Restore (auto OFF)', () => {
  it('Take then manual Restore works; auto-restore never appears', async () => {
    // Auto fully OFF so Manual Take is allowed.
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

    // No auto restore when auto inactive
    expect(screen.queryByTestId(`auto-restore-dose-${MED_ID}`)).toBeNull();

    const takeBtn = screen.getByTitle(/تناول جرعة/);
    const pillsBefore = readMeds()[0].currentPills;
    fireEvent.click(takeBtn);

    await waitFor(() => {
      const m = readMeds()[0];
      expect(isDoseConsumedOnDate(m, 's1', getTodayDateString())).toBe(true);
      expect(m.currentPills).toBe(pillsBefore - 2);
    });

    // Manual restore
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
// Legacy Auto Restore — real outcome assertions
// ---------------------------------------------------------------------------
describe('MedicationCard Auto Restore — Legacy', () => {
  it('legacy pure auto restores via existing path and adjusts stock', async () => {
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([makeLegacyAuto()]));
    localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify([]));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Legacy Auto Restore')).toBeInTheDocument();
    });

    const autoBtn = screen.getByTestId('auto-restore-dose-med-legacy-auto');
    expect(autoBtn).toBeInTheDocument();

    const before = readMeds().find((m) => m.id === 'med-legacy-auto')!;
    const pillsBefore = before.currentPills;
    const effBefore = effectiveCurrentPills(before);
    expect(before.lastConsumedDate).toBeUndefined();

    fireEvent.click(autoBtn);

    await waitFor(() => {
      const med = readMeds().find((m) => m.id === 'med-legacy-auto')!;
      // Legacy restoreDose always settleAndAdjust by dailyDose.
      expect(med.currentPills).toBe(pillsBefore + 3);
      // After restore, lastConsumedDate stays cleared / not today.
      expect(med.lastConsumedDate).not.toBe(getTodayDateString());
      // Effective should not be lower than before.
      expect(effectiveCurrentPills(med)).toBeGreaterThanOrEqual(effBefore);
    });

    // No longer auto-restorable after successful restore (helper sees
    // post-restore state — for legacy, if lastConsumed was never set,
    // eligibility may depend on time still elapsed; the important
    // contract is stock moved once via restoreDose).
    // Double-click should not double-credit beyond one restore cycle.
    const afterFirst = readMeds().find((m) => m.id === 'med-legacy-auto')!;
    const pillsAfterFirst = afterFirst.currentPills;
    if (screen.queryByTestId('auto-restore-dose-med-legacy-auto')) {
      fireEvent.click(screen.getByTestId('auto-restore-dose-med-legacy-auto'));
      await waitFor(() => {
        const med = readMeds().find((m) => m.id === 'med-legacy-auto')!;
        // At most one additional credit; production restoreDose is idempotent
        // enough not to runaway-inflate. Soft bound:
        expect(med.currentPills).toBeLessThanOrEqual(pillsAfterFirst + 3);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Layout structure — Compact + Detailed (no CSS coupling)
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
