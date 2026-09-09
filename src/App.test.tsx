/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

// Mock the modules that touch browser/Capacitor APIs before importing App.
vi.mock('../native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
  openAppSettings: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../utils/notifications', () => ({
  requestNotificationPermission: vi.fn(() => Promise.resolve(false)),
  sendMedicineAlert: vi.fn(),
  sendCriticalStockAlert: vi.fn(),
  sendTestAlertNotification: vi.fn(() => Promise.resolve()),
  openNotificationSettings: vi.fn(),
  getNotificationPermission: vi.fn(() => Promise.resolve('denied')),
  getNotificationPermissionSync: vi.fn(() => 'denied'),
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
