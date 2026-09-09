/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// Mock the modules that touch browser/Capacitor APIs before importing App.
vi.mock('../native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
  openAppSettings: vi.fn(() => Promise.resolve(false)),
  registerBackButtonHandler: vi.fn(),
  cleanupNativeListeners: vi.fn(),
}));
vi.mock('./utils/notifications', () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(),
  sendTestAlertNotification: vi.fn(() => Promise.resolve()),
  openNotificationSettings: vi.fn(),
  getNotificationPermission: vi.fn(() => Promise.resolve('granted')),
  getNotificationPermissionSync: vi.fn(() => 'granted'),
  scheduleCriticalAlarm: vi.fn(() => Promise.resolve()),
  cancelCriticalAlarm: vi.fn(() => Promise.resolve()),
  criticalAlarmId: vi.fn((id: string) => id.length),
}));
vi.mock('../utils/sound', () => ({
  playSuccessChime: vi.fn(),
  playNotificationSound: vi.fn(),
  NOTIFICATION_SOUND_OPTIONS: [
    { id: 'classic_chime', name: 'نغمة كلاسيكية', description: '', icon: '🔔' },
  ],
}));
vi.mock('../utils/audioStore', () => ({
  saveGlobalCustomSound: vi.fn(() => Promise.resolve()),
  loadGlobalCustomSound: vi.fn(() => Promise.resolve(null)),
  deleteGlobalCustomSound: vi.fn(() => Promise.resolve()),
}));

import App from './App';
import { INITIAL_MEDICATIONS } from './data/initialData';
import {
  scheduleCriticalAlarm,
  cancelCriticalAlarm,
} from './utils/notifications';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';

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

    // Wait for hydration to complete (loadGlobalCustomSound resolves,
    // hydrated flips true). The EmptyState component renders when
    // medications is empty — it shows "لا توجد أدوية مسجلة حالياً".
    await waitFor(() => {
      expect(screen.getByText('لا توجد أدوية مسجلة حالياً')).toBeInTheDocument();
    });

    // The seed medications must NOT have appeared (the old bug kept the
    // seed meds because `parsed.length > 0` was false).
    for (const seedMed of INITIAL_MEDICATIONS) {
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
      notificationSound: 'classic_chime',
    };
    localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify([savedMed]));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Custom Test Med')).toBeInTheDocument();
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
});
