import { __setExactAutoEnvelopeTestHooks } from './utils/autoStockTestHooks';
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
vi.mock('./utils/notificationTestFacade', () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(() => Promise.resolve(true)),
  sendTestAlertNotification: vi.fn(() => Promise.resolve()),
  openNotificationSettings: vi.fn(),
  getNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  getExactAlarmPermission: vi.fn(() => Promise.resolve('granted')),
  openExactAlarmSettings: vi.fn(() => Promise.resolve({ ok: true })),
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  verifyCriticalAlarmPending: vi.fn(() => Promise.resolve({ ok: true, pending: false })),
  criticalAlarmId: vi.fn((id: string) => id.length),

}));
vi.mock('@/utils/sound', () => ({
  playSuccessChime: vi.fn(),
  stopAllSounds: vi.fn(),
}));

// The scheduler consumes src/utils/criticalAlarmScheduling directly (the
// notificationTestFacade merely re-exports it, so mocking the facade does
// NOT intercept the App's scheduling calls). Mock the production module
// itself and assert on those doubles.
vi.mock('@/utils/criticalAlarmScheduling', () => ({
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve({ ok: true })),
  verifyCriticalAlarmPending: vi.fn(() => Promise.resolve({ ok: true, pending: false })),
}));

// Hydration probes the REAL permission module (the facade re-export is not
// consumed by production). Return 'granted' so a persisted
// notificationsEnabled=true survives launch, per the current contract.
vi.mock('@/utils/notifications/notificationPermissions', () => ({
  getNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  requestNotificationPermission: vi.fn(() => Promise.resolve(true)),
  openNotificationSettings: vi.fn(),
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
  __setExactAutoEnvelopeTestHooks: vi.fn(),
}));

import App from '@/App';
import { getTodayDateString } from '@/utils/dateCalculations';



import { scheduleCriticalAlarm, cancelCriticalAlarm } from '@/utils/criticalAlarmScheduling';



// Wave 13 #123: pin system time so the many `new Date().toISOString()`
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


describe('App — one-shot critical-alarm reschedule effect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('schedules a critical alarm for each saved medication when alerts are enabled', async () => {
    // Current hydration defaults criticalStockAlertsEnabled to false — the
    // feature is opt-in via its persisted preference.
    localStorage.setItem('android_med_tracker_critical_alerts_v1', 'true');
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
        autoDeductEnabled: true,
        reminderEnabled: false,
        // Policy contract: delivery needs BOTH the global master switch and
        // the per-medication criticalStockAlertsEnabled === true, and the
        // crossing projection requires a dose schedule (Auto + schedule rows
        // are what make stock decline into the critical zone).
        criticalStockAlertsEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
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
    localStorage.setItem('android_med_tracker_critical_alerts_v1', 'true');
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
        autoDeductEnabled: true,
        reminderEnabled: false,
        criticalStockAlertsEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
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
    // After a device reboot, the shared
    // DrugTrackerAlarmSystemReceiver dispatches native alarm recovery
    // through ExactAlarmLifecycle. If the app also resumes, the normal
    // JS scheduler/reconciliation paths remain idempotent.
    // the app triggers the reschedule effect to re-arm all alarms
    // from the current medication state. This test verifies that
    // re-arming works for multiple meds on app launch.
    localStorage.setItem('android_med_tracker_critical_alerts_v1', 'true');
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
        autoDeductEnabled: true,
        reminderEnabled: false,
        criticalStockAlertsEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
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
        autoDeductEnabled: true,
        reminderEnabled: false,
        criticalStockAlertsEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 2, time: '08:00' }],
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
        autoDeductEnabled: true,
        reminderEnabled: false,
        criticalStockAlertsEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
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
    localStorage.setItem('android_med_tracker_critical_alerts_v1', 'true');
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
        autoDeductEnabled: true,
        reminderEnabled: false,
        criticalStockAlertsEnabled: true,
        doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
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
    // Explicit single-slot schedule + per-dose consume marker + durable deduction log.
    // Logs-tab restore UI stays intentionally removed; restore is via MedicationCard.
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
      autoDeductEnabled: true,
      reminderEnabled: false,
      doseSchedule: [{ id: 'd1', amount: 2, time: '09:00' }],
      dosesPerDay: 1,
      doseConsumptionHistory: { d1: [today] },
    }]));
    localStorage.setItem('android_med_tracker_logs_v2', JSON.stringify([{
      id: 'take-d1',
      medicationId: 'med-restore',
      medicationName: 'Restore Med',
      type: 'dose_taken',
      amount: -2,
      date: today,
      timestamp: today + 'T09:00:00.000Z',
      description: 'manual take',
      doseId: 'd1',
    }]));

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

    // After successful restore, per-dose consume is cleared → canRestore false →
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
    // Current header bell labels:
    //   enabled  → "تذكيرات مواعيد الجرعات مفعّلة — انقر للإيقاف"
    //   disabled → "تذكيرات مواعيد الجرعات متوقفة — انقر للتفعيل"
    await waitFor(() => {
      const bellBtn = screen.getByRole('button', { name: /تذكيرات مواعيد الجرعات متوقفة/ });
      expect(bellBtn).toBeInTheDocument();
      expect(bellBtn).toHaveAttribute('aria-pressed', 'false');
    });

    expect(localStorage.getItem('android_med_tracker_notifications_v1')).toBe('false');
  });

  it('persists notificationsEnabled=true across app launch', async () => {
    localStorage.setItem('android_med_tracker_notifications_v1', 'true');

    render(<App />);

    await waitFor(() => {
      const bellBtn = screen.getByRole('button', { name: /تذكيرات مواعيد الجرعات مفعّلة/ });
      expect(bellBtn).toBeInTheDocument();
      expect(bellBtn).toHaveAttribute('aria-pressed', 'true');
    });

    expect(localStorage.getItem('android_med_tracker_notifications_v1')).toBe('true');
  });

  it('clicking the notifications button toggles state and persists new value to localStorage', async () => {
    localStorage.setItem('android_med_tracker_notifications_v1', 'true');

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /تذكيرات مواعيد الجرعات مفعّلة/ })).toBeInTheDocument();
    });

    const bellBtn = screen.getByRole('button', { name: /تذكيرات مواعيد الجرعات مفعّلة/ });
    fireEvent.click(bellBtn);

    await waitFor(() => {
      expect(localStorage.getItem('android_med_tracker_notifications_v1')).toBe('false');
      expect(screen.getByRole('button', { name: /تذكيرات مواعيد الجرعات متوقفة/ })).toBeInTheDocument();
    });
  });
});
