import { createElement, StrictMode, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  NOTIFICATIONS_KEY,
  STORAGE_PHARMACY_KEY,
} from '@/constants/storageKeys';

const permissionMocks = vi.hoisted(() => ({
  get: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@/utils/notifications/notificationPermissions', () => ({
  getNotificationPermission: permissionMocks.get,
  requestNotificationPermission: permissionMocks.request,
}));
vi.mock('@/utils/exactAlarm', () => ({
  getExactAlarmPermission: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/native', () => ({
  initNativeBridge: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/utils/notificationRuntime', () => ({
  ensureNotificationChannel: vi.fn(() => Promise.resolve(true)),
  getNotificationChannelState: vi.fn(() => Promise.resolve('enabled')),
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
import {
  applyNotificationPermissionResultIfUnset,
  initializeAppPermissions,
  loadPersistedAppState,
} from '@/utils/appHydrationPhases';

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
  permissionMocks.get.mockResolvedValue('unsupported');
  permissionMocks.request.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const StrictModeWrapper = ({ children }: PropsWithChildren) =>
  createElement(StrictMode, null, children);

describe('pharmacy settings hydration', () => {
  it.each([30, 60])(
    'accepts supported defaultDurationDays=%s without reporting invalid persisted settings',
    (defaultDurationDays) => {
      localStorage.setItem(
        STORAGE_PHARMACY_KEY,
        JSON.stringify({ defaultDurationDays })
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const setters = makeSetters();

      loadPersistedAppState(setters);

      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes('Persisted pharmacy settings unusable')
        )
      ).toHaveLength(0);
      expect(setters.setPharmacySettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultDurationDays })
      );
    }
  );

  it('runs hydration only once under React StrictMode, so one real storage warning is logged once', async () => {
    localStorage.setItem(
      STORAGE_PHARMACY_KEY,
      JSON.stringify({ defaultDurationDays: 45 })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setters = makeSetters();

    renderHook(() => useAppHydration(setters), {
      wrapper: StrictModeWrapper,
    });

    await waitFor(() => {
      expect(setters.setHydrated).toHaveBeenCalledWith(true);
    });

    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('Persisted pharmacy settings unusable (invalid)')
      )
    ).toHaveLength(1);
  });
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

  it('waits for a first-open OS decision before permission initialization resolves', async () => {
    permissionMocks.get.mockResolvedValue('default');
    let resolveRequest!: (granted: boolean) => void;
    permissionMocks.request.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveRequest = resolve;
      })
    );

    const setNotificationsEnabled = vi.fn();
    const initialization = initializeAppPermissions({
      setNotificationsEnabled,
      setExactAlarmPermission: vi.fn(),
    });

    await Promise.resolve();
    expect(setNotificationsEnabled).not.toHaveBeenCalled();

    resolveRequest(true);
    await initialization;

    expect(setNotificationsEnabled).toHaveBeenCalledWith(true);
  });
});
