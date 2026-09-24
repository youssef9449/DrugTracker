import { useEffect } from 'react';
import { usePersistentEffect } from './usePersistentEffect';
import { persist } from '../utils/storage';
import { PERSIST_FAILURE_MESSAGES } from '../constants/uiStrings';
import {
  STORAGE_PHARMACY_KEY,
  SOUND_KEY,
  NOTIFICATIONS_KEY,
  FONT_SIZE_KEY,
  CRITICAL_STOCK_ALERTS_KEY,
  COMPACT_VIEW_KEY,
} from '../constants/storageKeys';
import { PHARMACY_PERSIST_DEBOUNCE_MS } from '../utils/time';
import type { PharmacySettings } from '../types';

export interface AppPersistenceDeps {
  hydrated: boolean;
  pharmacySettings: PharmacySettings;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  fontScale: string;
  isCompactView: boolean;
  showToast: (message: string) => void;
}

/**
 * Focused persistence effects for app preferences and pharmacy settings.
 * Extracted from useAppRuntime so the runtime facade stays composition-only (#528).
 * Font-scale keeps its CSS side-effect here to preserve ordering with persistence.
 */
export function useAppPersistence(deps: AppPersistenceDeps): void {
  const {
    hydrated,
    pharmacySettings,
    soundEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    fontScale,
    isCompactView,
    showToast,
  } = deps;

  usePersistentEffect({
    storageKey: STORAGE_PHARMACY_KEY,
    value: pharmacySettings,
    enabled: hydrated,
    debounceMs: PHARMACY_PERSIST_DEBOUNCE_MS,
    failureMessage: PERSIST_FAILURE_MESSAGES.pharmacy,
    showToast,
  });
  usePersistentEffect({
    storageKey: SOUND_KEY,
    value: String(soundEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.sound,
    showToast,
  });
  usePersistentEffect({
    storageKey: NOTIFICATIONS_KEY,
    value: String(notificationsEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.notifications,
    showToast,
  });
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('font-scale-large', fontScale === 'large');
    }
    if (!hydrated) return;
    const err = persist(FONT_SIZE_KEY, fontScale, { json: false });
    if (err) console.warn('[AppPersistence] failed to persist font size:', err);
  }, [fontScale, hydrated]);
  usePersistentEffect({
    storageKey: CRITICAL_STOCK_ALERTS_KEY,
    value: String(criticalStockAlertsEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.critical,
    showToast,
  });
  usePersistentEffect({
    storageKey: COMPACT_VIEW_KEY,
    value: String(isCompactView),
    json: false,
    enabled: hydrated,
    failureMessage: 'تعذر حفظ خيار العرض',
    showToast,
  });
}
