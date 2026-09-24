import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { NOTIFICATIONS_KEY } from '@/constants/storageKeys';

vi.mock('@/utils/notifications/notificationPermissions', () => ({
  getNotificationPermission: vi.fn(() => Promise.resolve('unsupported')),
  requestNotificationPermission: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('@/utils/exactAlarm', () => ({
  getExactAlarmPermission: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/utils/notificationRuntime', () => ({
  isNotificationChannelEnabled: vi.fn(() => Promise.resolve(true)),
  retryPersistedNotificationDeliveries: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('@/utils/notifications/doseReminderNotifications', () => ({
  DOSE_REMINDER_CHANNEL_ID: 'dose-reminder',
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID: 'dose-reminder-foreground',
}));
vi.mock('@/utils/autoDeductionNativeStock', () => ({
  convergeAutoDeductionStock: vi.fn(),
}));

import { useAppHydration } from '@/hooks/useAppHydration';
import { applyNotificationPermissionResultIfUnset } from '@/utils/appHydrationPhases';

function makeSetters() {
  return {
    setMedications: vi.fn(),
    setLogs: vi.fn(),
    setPharmacySettings: vi.fn(),
    setHydrated: vi.fn(),
    setIsFirstRun: vi.fn(),
    setIsAutoDeductPromptOpen: vi.fn(),
    setSoundEnabled: vi.fn(),
    setNotificationsEnabled: vi.fn(),
    setCriticalStockAlertsEnabled: vi.fn(),
    setExactAlarmPermission: vi.fn(),
    setGlobalAutoDeductEnabled: vi.fn(),
    setFontScale: vi.fn(),
    setIsCompactView: vi.fn(),
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAppHydration — storage failures', () => {
  it('always reaches hydrated=true when the earliest localStorage reads throw', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setters = makeSetters();

    try {
      renderHook(() => useAppHydration(setters));
      await waitFor(() => {
        expect(setters.setHydrated).toHaveBeenCalledWith(true);
      });
      expect(setters.setMedications).not.toHaveBeenCalled();
      expect(setters.setIsAutoDeductPromptOpen).not.toHaveBeenCalledWith(true);
    } finally {
      getItem.mockRestore();
    }
  });

  it('does not treat a persisted empty medication array as first run', async () => {
    localStorage.setItem('android_med_tracker_items_v2', '[]');
    const setters = makeSetters();

    renderHook(() => useAppHydration(setters));
    await waitFor(() => {
      expect(setters.setHydrated).toHaveBeenCalledWith(true);
    });
    expect(setters.setIsFirstRun).not.toHaveBeenCalledWith(true);
  });
});

describe('notification permission result application', () => {
  it('applies a first-open grant while the persisted preference is unset', () => {
    const setNotificationsEnabled = vi.fn();

    applyNotificationPermissionResultIfUnset(true, setNotificationsEnabled);

    expect(setNotificationsEnabled).toHaveBeenCalledWith(true);
  });

  it('applies a first-open denial while the persisted preference is unset', () => {
    const setNotificationsEnabled = vi.fn();

    applyNotificationPermissionResultIfUnset(false, setNotificationsEnabled);

    expect(setNotificationsEnabled).toHaveBeenCalledWith(false);
  });

  it('never overwrites an explicit persisted preference', () => {
    localStorage.setItem(NOTIFICATIONS_KEY, 'true');
    const setNotificationsEnabled = vi.fn();

    applyNotificationPermissionResultIfUnset(false, setNotificationsEnabled);

    expect(setNotificationsEnabled).not.toHaveBeenCalled();

    localStorage.setItem(NOTIFICATIONS_KEY, 'false');
    applyNotificationPermissionResultIfUnset(true, setNotificationsEnabled);

    expect(setNotificationsEnabled).not.toHaveBeenCalled();
  });

  it('does not overwrite state when the preference read itself fails', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setNotificationsEnabled = vi.fn();

    try {
      applyNotificationPermissionResultIfUnset(true, setNotificationsEnabled);
      expect(setNotificationsEnabled).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
    }
  });
});
