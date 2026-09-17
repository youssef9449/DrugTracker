/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// Mock the modules that touch browser/Capacitor APIs before importing App.
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

}));
vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

// Phase 4: the gated stock mutations use the reconciliation result as the
// fresh durable state inside the critical section (reconcileExact-
// BeforeLegacySettlement). The mock must therefore honor the REAL identity
// contract for a reconciliation with no FIRED events: echo the input
// medications/logs unchanged (no FIRED events → no mutation). Returning
// empty arrays would wipe the durable state inside the gate and turn every
// gated mutation into missing_med.
vi.mock('@/utils/runAutoDeductionReconciliation', () => ({
  runAutoDeductionReconciliation: vi.fn(
    async (opts?: { medications?: unknown[]; logs?: unknown[] }) => ({
      medications: [...(opts?.medications ?? [])],
      logs: [...(opts?.logs ?? [])],
      toAcknowledge: [],
      details: [],
      mutated: false,
      newExactLogs: [],
      markedCount: 0,
      recoveredEnvelope: false,
      partialNativeAck: false,
    })
  ),
}));

import App from '@/App';
import { getTodayDateString } from '@/utils/dateCalculations';
import { runAutoDeductionReconciliation } from '@/utils/runAutoDeductionReconciliation';

import { getInitialMedications } from '@/data/initialData';
import {
  scheduleCriticalAlarm,
  cancelCriticalAlarm,
} from '@/utils/notifications';
import { initNativeBridge } from '@/native';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';

// Wave 13 #123: pin system time so the many `new Date().toISOString()`
// calls used by App's seed data + lastSyncDate defaults resolve to a
// known date (2024-09-10T12:00:00Z). Prevents midnight-UTC flake risk
// where the test process's wall-clock date rolls over mid-run. Only
// the Date object is faked so React/testing-library's setTimeout-based
// waitFor polling keeps working unchanged.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-10T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('App — hydration (#15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads an empty medications array from localStorage (does not fall back to seed)', async () => {
    // Persist an empty array — the user deleted all medications.
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([]));

    render(<App />);

    // Wait for hydration to complete (permission checks resolve,
    // hydrated flips true). The EmptyState component renders when
    // medications is empty — it shows "لا توجد أدوية مسجلة حالياً".
    await waitFor(() => {
      expect(screen.getByText('لا توجد أدوية مسجلة حالياً')).toBeInTheDocument();
    });

    // The seed medications must NOT have appeared (the old bug kept the
    // seed meds because `parsed.length > 0` was false).
    for (const seedMed of getInitialMedications()) {
      expect(screen.queryByText(seedMed.name)).toBeNull();
    }
  });

  it('loads saved medications from localStorage (non-empty)', async () => {
    const savedMed = {
      id: 'med-custom',
      name: 'Custom Test Med',
      currentPills: 5,
      dailyDose: 1,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: '2024-01-01',
      reminderEnabled: false,
    };
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([savedMed]));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Custom Test Med')).toBeInTheDocument();
    });
  });

  it('does not hydrate until initNativeBridge completes (ordering race guard)', async () => {
    // Regression: permissions must not set hydrated=true while initNativeBridge
    // is still in flight (scheduler / exact-reconcile effects are hydration-gated).
    // EmptyState is NOT a hydration marker — it renders whenever medications is [].
    // Observe a real hydration-gated side effect: Phase 3 reconciliation runner.
    let resolveBridge!: () => void;
    const bridgePending = new Promise<void>((resolve) => {
      resolveBridge = resolve;
    });
    vi.mocked(initNativeBridge).mockReturnValueOnce(bridgePending);
    vi.mocked(runAutoDeductionReconciliation).mockClear();

    // Explicit empty inventory (not first-run null key) so isFirstRun=false and
    // hydration-gated auto effects are eligible once hydrated flips true.
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([]));
    render(<App />);

    // Permissions / exact-alarm mocks resolve; bridge still pending → hydrated false
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(runAutoDeductionReconciliation).not.toHaveBeenCalled();

    resolveBridge();
    await waitFor(() => {
      expect(runAutoDeductionReconciliation).toHaveBeenCalled();
    });
  });
});

/**
 * #27 — handleToggleAutoDeduct must turn OFF a med whose
 * autoDeductEnabled is undefined (default-true). Previously the first
 * click was a no-op because `!undefined === true`.
 *
 * This is hard to test through the full App (the toggle is in the
 * MedicationCard dropdown menu), so we test the pure toggle logic via
 * a small inline reproduction. The real handler lives in App.tsx but
 * the logic is: `const newState = m.autoDeductEnabled === false`.
 */
describe('handleToggleAutoDeduct logic (#27)', () => {
  it('undefined → false (turns OFF the default-true)', () => {
    const m = { autoDeductEnabled: undefined };
    const newState = m.autoDeductEnabled === false;
    expect(newState).toBe(false);
  });

  it('true → false (turns OFF)', () => {
    const m = { autoDeductEnabled: true };
    const newState = m.autoDeductEnabled === false;
    expect(newState).toBe(false);
  });

  it('false → true (turns ON)', () => {
    const m = { autoDeductEnabled: false };
    const newState = m.autoDeductEnabled === false;
    expect(newState).toBe(true);
  });
});

/**
 * handleToggleAutoDeduct — purity of the setMedications updater.
 *
 * The settlement calculation + all side effects (setLogs, showToast)
 * must run OUTSIDE the setMedications updater. React updater
 * functions must be pure; React may invoke them more than once in
 * Strict Mode (which ships in src/main.tsx). If the updater itself
 * calls setLogs/showToast/settleAutoDeductToggle, Strict Mode's
 * double-invoke would create DUPLICATE settlement calls, logs, and
 * toasts.
 *
 * The fix: handleToggleAutoDeduct computes the settle result OUTSIDE
 * the updater (using `medications.find`), fires setLogs + showToast
 * once from the handler body, and passes the pre-computed `updatedMed`
 * into the updater as a closure value (which the updater only READS).
 *
 * These tests verify the structural property: ONE toggle click calls
 * the pure `settleAutoDeductToggle` helper EXACTLY ONCE — even under
 * <StrictMode> (which double-invokes the setMedications updater). If
 * the settle call were inside the updater, StrictMode would call it
 * twice; the fix ensures it's called once regardless.
 *
 * We also verify the toast side effect fires exactly once per click.
 */
describe('handleToggleAutoDeduct — pure updater, no duplicate side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** Click the MedicationMenu auto-deduct icon button (no dropdown). */
  function clickToggleFor(): void {
    // Phase 4 menu redesign: toggle is a direct icon button, not a
    // "خيارات" dropdown item. aria-label switches with state:
    //   - auto active → "إيقاف الخصم التلقائي"
    //   - auto paused → "تفعيل الخصم التلقائي"
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
  }

  /** Seed a single med in localStorage so App renders one MedicationCard. */
  function seedMed(overrides: Record<string, unknown> = {}): void {
    localStorage.setItem(
      'android_med_tracker_items_v2',
      JSON.stringify([
        {
          id: 'med-toggle',
          name: 'Toggle Med',
          currentPills: 60,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          // lastSyncDate = today so the app-open sync effect is a no-op
          // (daysPassed = 0). This isolates the test to the toggle's
          // own settle behavior.
          lastSyncDate: new Date().toISOString().slice(0, 10),
          autoDeductEnabled: true,
          reminderEnabled: false,
          ...overrides,
        },
      ])
    );
  }

  it('one toggle click calls settleAutoDeductToggle EXACTLY ONCE (not twice, not zero)', async () => {
    seedMed();

    // Spy on the pure settle helper. The spy returns a no-op result
    // (no deduction, no log) so the test doesn't depend on the
    // sync effect's state — we ONLY care about the call count.
    const dateCalcModule = await import('@/utils/dateCalculations');
    const settleSpy = vi
      .spyOn(dateCalcModule, 'settleAutoDeductToggle')
      .mockReturnValue({
        updatedMed: {
          id: 'med-toggle',
          name: 'Toggle Med',
          currentPills: 60,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSyncDate: new Date().toISOString().slice(0, 10),
          autoDeductEnabled: false,
        },
        log: null,
      });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // Phase 4: the toggle runs inside the async durable stock gate, so the
    // settle call happens on a later microtask — await it. The handler
    // calls settleAutoDeductToggle exactly once per click (outside the
    // updater, so StrictMode cannot double it).
    await waitFor(() => {
      expect(settleSpy).toHaveBeenCalledTimes(1);
    });

    // Verify the call args: the med id matches, newState is false
    // (was true → false), todayStr is today, now is a Date (the gated
    // wrapper always passes all four).
    expect(settleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'med-toggle', autoDeductEnabled: true }),
      false,
      expect.any(String),
      expect.any(Date)
    );
  });

  it('one toggle click under <StrictMode> still calls settleAutoDeductToggle EXACTLY ONCE', async () => {
    // StrictMode double-invokes updater functions in development.
    // If settleAutoDeductToggle were called INSIDE the setMedications
    // updater, StrictMode would call it TWICE. The fix ensures the
    // settle call is OUTSIDE the updater, so it's called once even
    // under StrictMode.
    seedMed();

    const dateCalcModule = await import('@/utils/dateCalculations');
    const settleSpy = vi
      .spyOn(dateCalcModule, 'settleAutoDeductToggle')
      .mockReturnValue({
        updatedMed: {
          id: 'med-toggle',
          name: 'Toggle Med',
          currentPills: 60,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSyncDate: new Date().toISOString().slice(0, 10),
          autoDeductEnabled: false,
        },
        log: null,
      });

    const { StrictMode } = await import('react');
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // Exactly ONE call — StrictMode's double-invoke of the updater
    // did NOT double the settle call (it's outside the updater, and
    // the Phase 4 gated handler runs once per click). Await the async
    // durable gate before asserting.
    await waitFor(() => {
      expect(settleSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('one toggle (OFF → ON) calls settleAutoDeductToggle EXACTLY ONCE and produces no log', async () => {
    // Frozen med → toggle to ON. The settle helper is called once
    // (with newState=true) and returns no log (no retroactive deduction).
    seedMed({ autoDeductEnabled: false });

    const dateCalcModule = await import('@/utils/dateCalculations');
    const settleSpy = vi
      .spyOn(dateCalcModule, 'settleAutoDeductToggle')
      .mockReturnValue({
        updatedMed: {
          id: 'med-toggle',
          name: 'Toggle Med',
          currentPills: 60,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSyncDate: new Date().toISOString().slice(0, 10),
          autoDeductEnabled: true,
        },
        log: null,
      });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // Await the async durable stock gate (Phase 4) before asserting.
    await waitFor(() => {
      expect(settleSpy).toHaveBeenCalledTimes(1);
    });
    // newState=true (false→true transition); 4th arg is the gate's now.
    expect(settleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'med-toggle', autoDeductEnabled: false }),
      true,
      expect.any(String),
      expect.any(Date)
    );
  });

  it('one toggle click shows the toast EXACTLY ONCE (no duplicate toasts under StrictMode)', async () => {
    // The toast is also a side effect that was inside the updater in
    // the buggy version. Verify it fires exactly once per click by
    // counting the toast message in the DOM. (Toasts auto-dismiss
    // after 3s, but we check immediately after the click.)
    seedMed();

    const { StrictMode } = await import('react');
    render(
      <StrictMode>
        <App />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText('Toggle Med')).toBeInTheDocument();
    });

    clickToggleFor();

    // The toast message for "turn OFF" is "تم إيقاف الخصم التلقائي مؤقتاً لـ ...".
    // It should appear exactly once (not twice — which would happen if
    // showToast were inside the updater under StrictMode).
    await waitFor(() => {
      const toasts = screen.getAllByText(/تم إيقاف الخصم التلقائي مؤقتاً لـ/);
      expect(toasts.length).toBe(1);
    });
  });
});

/**
 * One-shot critical-alarm reschedule effect (App.tsx).
 *
 * When notificationsEnabled + criticalStockAlertsEnabled are both true
 * and the app has hydrated, the effect must call scheduleCriticalAlarm
 * for each medication. When either flag flips off, the effect must
 * cancel all previously-scheduled alarms.
 */
describe('App — one-shot critical-alarm reschedule effect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('schedules a critical alarm for each saved medication when alerts are enabled', async () => {
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([
      {
        id: 'med-alarm-1',
        name: 'Alarm Test Med',
        currentPills: 30,
        dailyDose: 1,
        unit: 'قرص',
        warningThresholdDays: 5,
        colorTag: 'teal',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSyncDate: new Date().toISOString().slice(0, 10),
        autoDeductEnabled: true,
        reminderEnabled: false,
      },
    ]));

    render(<App />);

    await waitFor(() => {
      expect(scheduleCriticalAlarm).toHaveBeenCalled();
    });
    expect(cancelCriticalAlarm).toHaveBeenCalledWith('med-alarm-1');
    expect(scheduleCriticalAlarm).toHaveBeenCalledWith(
      'med-alarm-1',
      'Alarm Test Med',
      expect.any(Number),
      'قرص'
    );
  });

  it('cancels all alarms when the user opts out of critical alerts', async () => {
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([
      {
        id: 'med-alarm-2',
        name: 'Alarm Test Med 2',
        currentPills: 30,
        dailyDose: 1,
        unit: 'قرص',
        warningThresholdDays: 5,
        colorTag: 'teal',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSyncDate: new Date().toISOString().slice(0, 10),
        autoDeductEnabled: true,
        reminderEnabled: false,
      },
    ]));

    render(<App />);

    // Wait for the initial schedule to happen.
    await waitFor(() => {
      expect(scheduleCriticalAlarm).toHaveBeenCalled();
    });

    // The critical-alerts toggle button in AppHeader has the title
    // "تنبيه النفاذ الحرج مفعّل ..." when enabled. Find and click it.
    // This actually performs the state transition
    // (criticalStockAlertsEnabled: true → false), which triggers the
    // reschedule effect to cancel all alarms.
    const toggle = screen.getByTitle(/تنبيه النفاذ الحرج مفعّل/);
    fireEvent.click(toggle);

    // The reschedule effect must run with the new state and cancel
    // the previously-scheduled alarm for the med.
    await waitFor(() => {
      expect(cancelCriticalAlarm).toHaveBeenCalledWith('med-alarm-2');
    });
  });

  it('re-arms all critical alarms when the app is launched (e.g., after a device reboot)', async () => {
    // After a device reboot, the Capacitor plugin's BootReceiver
    // re-arms already-scheduled notifications from its persisted
    // store. But if for some reason the boot receiver doesn't fire
    // (e.g., the app was force-stopped before the reboot), opening
    // the app triggers the reschedule effect to re-arm all alarms
    // from the current medication state. This test verifies that
    // re-arming works for multiple meds on app launch.
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([
      {
        id: 'med-reboot-1',
        name: 'Reboot Med 1',
        currentPills: 30,
        dailyDose: 1,
        unit: 'قرص',
        warningThresholdDays: 5,
        colorTag: 'teal',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSyncDate: new Date().toISOString().slice(0, 10),
        autoDeductEnabled: true,
        reminderEnabled: false,
      },
      {
        id: 'med-reboot-2',
        name: 'Reboot Med 2',
        currentPills: 20,
        dailyDose: 2,
        unit: 'قرص',
        warningThresholdDays: 5,
        colorTag: 'teal',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSyncDate: new Date().toISOString().slice(0, 10),
        autoDeductEnabled: true,
        reminderEnabled: false,
      },
      {
        id: 'med-reboot-3',
        name: 'Reboot Med 3',
        currentPills: 14,
        dailyDose: 1,
        unit: 'قرص',
        warningThresholdDays: 7,
        colorTag: 'teal',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSyncDate: new Date().toISOString().slice(0, 10),
        autoDeductEnabled: true,
        reminderEnabled: false,
      },
    ]));

    render(<App />);

    // All three meds must have a critical alarm scheduled on launch.
    await waitFor(() => {
      expect(scheduleCriticalAlarm).toHaveBeenCalledWith(
        'med-reboot-1',
        'Reboot Med 1',
        expect.any(Number),
        'قرص'
      );
      expect(scheduleCriticalAlarm).toHaveBeenCalledWith(
        'med-reboot-2',
        'Reboot Med 2',
        expect.any(Number),
        'قرص'
      );
      expect(scheduleCriticalAlarm).toHaveBeenCalledWith(
        'med-reboot-3',
        'Reboot Med 3',
        expect.any(Number),
        'قرص'
      );
    });
  });

  it('does NOT schedule a critical alarm for an already-critical med on app launch (no repeated immediate alerts)', async () => {
    // An already-critical med (daysLeft <= critical threshold) must
    // NOT trigger an immediate alarm on every app launch. The one-shot
    // alarm is only for FUTURE crossings. The existing alert effect
    // (which runs when the app is open and tracks already-alerted
    // statuses) handles the immediate notification once.
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([
      {
        id: 'med-already-critical',
        name: 'Already Critical Med',
        currentPills: 1, // dose 1, threshold 5 (critical 2) → daysLeft 1 → already critical
        dailyDose: 1,
        unit: 'قرص',
        warningThresholdDays: 5,
        colorTag: 'teal',
        createdAt: '2024-01-01T00:00:00.000Z',
        lastSyncDate: new Date().toISOString().slice(0, 10),
        autoDeductEnabled: true,
        reminderEnabled: false,
      },
    ]));

    render(<App />);

    // Give the effect a moment to (incorrectly) schedule, then assert
    // it did NOT. scheduleCriticalAlarm should never be called for
    // an already-critical med.
    await waitFor(() => {
      // The cancelCriticalAlarm might be called (no-op on web, but
      // the mock is wired), so we wait for any notification-module
      // activity to settle. Use a microtask flush.
      expect(cancelCriticalAlarm).not.toHaveBeenCalledWith('med-already-critical');
    });
    expect(scheduleCriticalAlarm).not.toHaveBeenCalled();
  });

  // Undo refill was removed from the card UI per user request, logic retained for future usage
  it.skip('undoes only the latest refill and persists the reversal marker', async () => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([{
      id: 'med-undo',
      name: 'Undo Med',
      currentPills: 60,
      dailyDose: 0,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: today,
      autoDeductEnabled: false,
      reminderEnabled: false,
    }]));
    localStorage.setItem('android_med_tracker_logs_v2', JSON.stringify([
      // Logs are stored newest-first in the app (every setLogs prepends),
      // so the seed must match that convention for logs.find() to target
      // the latest non-reversed refill.
      { id: 'refill-latest', medicationId: 'med-undo', medicationName: 'Undo Med', type: 'refill', amount: 20, date: today, timestamp: '2024-01-02T00:00:00.000Z', description: 'latest' },
      { id: 'refill-old', medicationId: 'med-undo', medicationName: 'Undo Med', type: 'refill', amount: 30, date: today, timestamp: '2024-01-01T00:00:00.000Z', description: 'old' },
    ]));

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'تراجع عن التعبئة' })).toBeInTheDocument());
    const undoButton = screen.getByRole('button', { name: 'تراجع عن التعبئة' });
    fireEvent.click(undoButton);
    fireEvent.click(undoButton);

    await waitFor(() => {
      const savedMedications = JSON.parse(localStorage.getItem('android_med_tracker_items_v2') || '[]');
      expect(savedMedications[0].currentPills).toBe(40);
    });
    const savedLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
    expect(savedLogs.find((log: { id: string }) => log.id === 'refill-latest').reversedAt).toBeTruthy();
    expect(savedLogs.find((log: { type: string }) => log.type === 'refill_undo').relatedLogId).toBe('refill-latest');
    expect(savedLogs.filter((log: { type: string }) => log.type === 'refill_undo')).toHaveLength(1);
    // The older +30 refill is now the only remaining undoable refill.
    expect(screen.getByText('آخر تعبئة: +30 قرص')).toBeInTheDocument();

    // Refill the same medication through the UI, then undo that new refill.
    fireEvent.click(screen.getByRole('button', { name: /تعبئة رصيد/ }));
    fireEvent.click(screen.getByRole('button', { name: /تأكيد إضافة المخزون/ }));
    await waitFor(() => expect(screen.getByText(/آخر تعبئة: \+/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'تراجع عن التعبئة' }));

    await waitFor(() => {
      const finalLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
      expect(finalLogs.filter((log: { type: string }) => log.type === 'refill_undo')).toHaveLength(2);
    });
  });

  // Undo refill was removed from the card UI per user request, logic retained for future usage
  it.skip('allows undoing multiple refills sequentially (regression: undo only worked once)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([{
      id: 'med-seq',
      name: 'Seq Med',
      currentPills: 60,
      dailyDose: 0,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: today,
      autoDeductEnabled: false,
      reminderEnabled: false,
    }]));
    localStorage.setItem('android_med_tracker_logs_v2', JSON.stringify([
      { id: 'refill-newest', medicationId: 'med-seq', medicationName: 'Seq Med', type: 'refill', amount: 20, date: today, timestamp: '2024-01-03T00:00:00.000Z', description: 'newest' },
      { id: 'refill-middle', medicationId: 'med-seq', medicationName: 'Seq Med', type: 'refill', amount: 15, date: today, timestamp: '2024-01-02T00:00:00.000Z', description: 'middle' },
      { id: 'refill-oldest', medicationId: 'med-seq', medicationName: 'Seq Med', type: 'refill', amount: 25, date: today, timestamp: '2024-01-01T00:00:00.000Z', description: 'oldest' },
    ]));

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'تراجع عن التعبئة' })).toBeInTheDocument());

    // 1st undo: reverses the newest refill (+20). 60 - 20 = 40.
    fireEvent.click(screen.getByRole('button', { name: 'تراجع عن التعبئة' }));
    await waitFor(() => {
      const savedMeds = JSON.parse(localStorage.getItem('android_med_tracker_items_v2') || '[]');
      expect(savedMeds[0].currentPills).toBe(40);
    });
    // Only 1 refill_undo log so far.
    let savedLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
    expect(savedLogs.filter((log: { type: string }) => log.type === 'refill_undo')).toHaveLength(1);
    // The +15 refill is now the latest undoable one.
    expect(screen.getByText('آخر تعبئة: +15 قرص')).toBeInTheDocument();

    // 2nd undo (sequential — after the first completed): reverses the
    // middle refill (+15). 40 - 15 = 25. This is the regression: the
    // guard must be cleared so a legitimate second undo works.
    fireEvent.click(screen.getByRole('button', { name: 'تراجع عن التعبئة' }));
    await waitFor(() => {
      const savedMeds = JSON.parse(localStorage.getItem('android_med_tracker_items_v2') || '[]');
      expect(savedMeds[0].currentPills).toBe(25);
    });
    savedLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
    expect(savedLogs.filter((log: { type: string }) => log.type === 'refill_undo')).toHaveLength(2);
    // The +25 (oldest) refill is now the only remaining undoable one.
    expect(screen.getByText('آخر تعبئة: +25 قرص')).toBeInTheDocument();

    // 3rd undo: reverses the oldest refill (+25). 25 - 25 = 0.
    fireEvent.click(screen.getByRole('button', { name: 'تراجع عن التعبئة' }));
    await waitFor(() => {
      const savedMeds = JSON.parse(localStorage.getItem('android_med_tracker_items_v2') || '[]');
      expect(savedMeds[0].currentPills).toBe(0);
    });
    savedLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
    expect(savedLogs.filter((log: { type: string }) => log.type === 'refill_undo')).toHaveLength(3);

    // No more undoable refills — the undo button should be gone.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'تراجع عن التعبئة' })).not.toBeInTheDocument();
    });
  });

  it('restores a dose once per day via MedicationCard (logs restore UI removed)', async () => {
    // Legacy (no doseSchedule): MedicationCard canRestore when lastConsumedDate === today
    // (local calendar, same as getTodayDateString). Real restore-dose-* then appears.
    // Logs-tab restore UI stays intentionally removed.
    const today = getTodayDateString();
    localStorage.setItem('android_med_tracker_items_v2', JSON.stringify([{
      id: 'med-restore',
      name: 'Restore Med',
      currentPills: 10,
      dailyDose: 2,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      createdAt: '2024-01-01T00:00:00.000Z',
      lastSyncDate: today,
      lastConsumedDate: today,
      autoDeductEnabled: true,
      reminderEnabled: false,
    }]));
    localStorage.setItem('android_med_tracker_logs_v2', '[]');

    render(<App />);
    await waitFor(() => expect(screen.getByText('Restore Med')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId('restore-dose-med-restore')).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId('restore-dose-med-restore'));

    await waitFor(() => {
      const savedLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
      expect(
        savedLogs.filter(
          (log: { type: string; date: string }) =>
            log.type === 'skipped_day' && log.date === today
        )
      ).toHaveLength(1);
    });

    // After successful restore, lastConsumedDate is cleared → canRestore false →
    // real restore control is no longer rendered. A second restore must not add logs.
    expect(screen.queryByTestId('restore-dose-med-restore')).not.toBeInTheDocument();
    const savedLogs = JSON.parse(localStorage.getItem('android_med_tracker_logs_v2') || '[]');
    expect(
      savedLogs.filter(
        (log: { type: string; date: string }) =>
          log.type === 'skipped_day' && log.date === today
      )
    ).toHaveLength(1);
  });

  it('persists notificationsEnabled=false across app launch and respects saved state over OS permission', async () => {
    localStorage.setItem('android_med_tracker_notifications_v1', 'false');

    render(<App />);

    // Even though getNotificationPermission mock returns 'granted',
    // the saved preference 'false' must be preserved.
    await waitFor(() => {
      const bellBtn = screen.getByRole('button', { name: /التنبيهات متوقفة/ });
      expect(bellBtn).toBeInTheDocument();
      expect(bellBtn).toHaveAttribute('aria-pressed', 'false');
    });

    expect(localStorage.getItem('android_med_tracker_notifications_v1')).toBe('false');
  });

  it('persists notificationsEnabled=true across app launch', async () => {
    localStorage.setItem('android_med_tracker_notifications_v1', 'true');

    render(<App />);

    await waitFor(() => {
      const bellBtn = screen.getByRole('button', { name: /التنبيهات مفعلة/ });
      expect(bellBtn).toBeInTheDocument();
      expect(bellBtn).toHaveAttribute('aria-pressed', 'true');
    });

    expect(localStorage.getItem('android_med_tracker_notifications_v1')).toBe('true');
  });

  it('clicking the notifications button toggles state and persists new value to localStorage', async () => {
    localStorage.setItem('android_med_tracker_notifications_v1', 'true');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /التنبيهات مفعلة/ })).toBeInTheDocument();
    });

    const bellBtn = screen.getByRole('button', { name: /التنبيهات مفعلة/ });
    fireEvent.click(bellBtn);

    await waitFor(() => {
      expect(localStorage.getItem('android_med_tracker_notifications_v1')).toBe('false');
      expect(screen.getByRole('button', { name: /التنبيهات متوقفة/ })).toBeInTheDocument();
    });
  });
});


/**
 * Success chime on UI toggle actions (Medication Auto-Deduct, Global Auto-Deduct, Display/Compact view).
 * Each successful click must call playSuccessChime exactly once when soundEnabled is true,
 * and never when soundEnabled is false. No duplicates from re-renders or dual branches.
 */
describe('Success chime on toggle actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  function seedMed(overrides: Record<string, unknown> = {}): void {
    localStorage.setItem(
      'android_med_tracker_items_v2',
      JSON.stringify([
        {
          id: 'med-chime',
          name: 'Chime Med',
          currentPills: 60,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'teal',
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSyncDate: new Date().toISOString().slice(0, 10),
          autoDeductEnabled: true,
          reminderEnabled: false,
          ...overrides,
        },
      ])
    );
  }

  it('Medication Auto-Deduct ON→OFF plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed({ autoDeductEnabled: true });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Medication Auto-Deduct OFF→ON plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed({ autoDeductEnabled: false });
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Global Auto-Deduct ON→OFF plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_auto_deduct_v1', 'true');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    // Global toggle is labeled for all meds
    const globalToggle = screen.getByLabelText(/تبديل الخصم التلقائي لجميع الأدوية/);
    fireEvent.click(globalToggle);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Global Auto-Deduct OFF→ON plays success chime once', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed({ autoDeductEnabled: false });
    localStorage.setItem('android_med_tracker_auto_deduct_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const globalToggle = screen.getByLabelText(/تبديل الخصم التلقائي لجميع الأدوية/);
    fireEvent.click(globalToggle);
    // Phase 4: chime fires after the async durable gate resolves.
    await waitFor(() => expect(playSuccessChime).toHaveBeenCalledTimes(1));
  });

  it('Display toggle OFF shows "العرض الطبيعي"; ON shows "العرض المختصر" (no شبكة)', async () => {
    seedMed();
    localStorage.setItem('android_med_tracker_compact_view_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    expect(screen.getByText('العرض الطبيعي')).toBeInTheDocument();
    expect(screen.queryByText(/شبكة/)).toBeNull();
    const displayToggle = screen.getByLabelText(/تبديل العرض بين المختصر والعرض الطبيعي/);
    fireEvent.click(displayToggle);
    await waitFor(() => {
      expect(screen.getByText('العرض المختصر')).toBeInTheDocument();
    });
    expect(screen.queryByText(/شبكة/)).toBeNull();
    // Toggle back to OFF
    fireEvent.click(displayToggle);
    await waitFor(() => {
      expect(screen.getByText('العرض الطبيعي')).toBeInTheDocument();
    });
  });

  it('Display (compact view) OFF→ON plays success chime once and toast "تم تفعيل العرض المختصر"', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_compact_view_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const displayToggle = screen.getByLabelText(/تبديل العرض بين المختصر والعرض الطبيعي/);
    fireEvent.click(displayToggle);
    expect(playSuccessChime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('تم تفعيل العرض المختصر')).toBeInTheDocument();
    });
    expect(screen.queryByText(/شبكة/)).toBeNull();
  });

  it('Display (compact view) ON→OFF plays success chime once and toast "تم إرجاع العرض الطبيعي"', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_compact_view_v1', 'true');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const displayToggle = screen.getByLabelText(/تبديل العرض بين المختصر والعرض الطبيعي/);
    fireEvent.click(displayToggle);
    expect(playSuccessChime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByText('تم إرجاع العرض الطبيعي')).toBeInTheDocument();
    });
    expect(screen.queryByText(/شبكة/)).toBeNull();
  });

  it('soundEnabled === false → no sound call on Medication Auto-Deduct toggle', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    localStorage.setItem('android_med_tracker_sound_v1', 'false');
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    expect(playSuccessChime).not.toHaveBeenCalled();
  });

  it('Medication Auto-Deduct toggle does not produce duplicate sound', async () => {
    const { playSuccessChime } = await import('@/utils/sound');
    seedMed();
    render(<App />);
    await waitFor(() => expect(screen.getByText('Chime Med')).toBeInTheDocument());
    const toggleBtn = screen.getByRole('button', {
      name: /إيقاف الخصم التلقائي|تفعيل الخصم التلقائي/,
    });
    fireEvent.click(toggleBtn);
    // Allow any re-renders
    await waitFor(() => {});
    expect(playSuccessChime).toHaveBeenCalledTimes(1);
  });
});
