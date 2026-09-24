import { useEffect } from 'react';
import type { AppRuntimeState } from './useAppRuntimeState';
import type { AppUiState } from './useAppUiState';
import { persist } from '../utils/storage';
import { PERSIST_FAILURE_MESSAGES } from '../constants/uiStrings';
import {
  STORAGE_PHARMACY_KEY, SOUND_KEY, NOTIFICATIONS_KEY, FONT_SIZE_KEY,
  CRITICAL_STOCK_ALERTS_KEY, COMPACT_VIEW_KEY,
} from '../constants/storageKeys';
import { PHARMACY_PERSIST_DEBOUNCE_MS } from '../utils/time';
import { usePersistentEffect } from './usePersistentEffect';
import { useStartupAutoDeduction } from './useStartupAutoDeduction';
import { useStockAlerts } from './useStockAlerts';
import { useCriticalAlarmScheduler } from './useCriticalAlarmScheduler';
import { useDoseReminderScheduler } from './useDoseReminderScheduler';
import { useMidnightTick } from './useMidnightTick';
import { useAutoDeductionScheduler } from './useAutoDeductionScheduler';
import { useExactAutoDeductionReconciliation } from './useExactAutoDeductionReconciliation';
import { useMedicationHandlers } from './useMedicationHandlers';
import { usePharmacyUserHandlers } from './usePharmacyUserHandlers';
import { useNativeActionHandlers } from './useNativeActionHandlers';
import { useAppHydration } from './useAppHydration';
import { useAppPreferenceHandlers } from './useAppPreferenceHandlers';

export interface AppRuntimeDeps {
  state: AppRuntimeState;
  ui: Pick<AppUiState, 'selectDoseMode' | 'settingsModalMode'>;
  uiActions: Pick<AppUiState, 'setSelectDoseMed' | 'setSelectDoseMode' | 'setEditingMedication'>;
  services: {
    showToast: (message: string) => void;
    dismissAlarm: () => boolean;
    snoozeAlarm: (minutes?: number) => void;
    openAlarm: (medId: string, doseId: string) => void;
  };
}
export function useAppRuntime(deps: AppRuntimeDeps) {
  const { state, ui, uiActions, services } = deps;
  const {
    medications, logs, pharmacySettings, hydrated, isFirstRun, soundEnabled,
    fontScale, isCompactView, notificationsEnabled, criticalStockAlertsEnabled, exactAlarmPermission,
    criticalAlarmResumeTick, doseAlarmResumeTick, doseLifecycleTick,
    globalAutoDeductEnabled, allowManualTakeActionByMedicationId,
    setMedications, setLogs, setPharmacySettings, setHydrated, setIsFirstRun,
    setIsAutoDeductPromptOpen, setSoundEnabled, setNotificationsEnabled,
    setCriticalStockAlertsEnabled, setExactAlarmPermission, setGlobalAutoDeductEnabled,
    setFontScale, setIsCompactView, setDoseLifecycleTick, setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
  } = state;
  const { selectDoseMode, settingsModalMode } = ui;
  const { setSelectDoseMed, setSelectDoseMode, setEditingMedication } = uiActions;
  const { showToast, dismissAlarm, snoozeAlarm, openAlarm } = services;

  useAppHydration({
    setMedications, setLogs, setPharmacySettings, setHydrated, setIsFirstRun,
    setIsAutoDeductPromptOpen, setSoundEnabled, setNotificationsEnabled,
    setCriticalStockAlertsEnabled, setExactAlarmPermission,
    setGlobalAutoDeductEnabled, setFontScale, setIsCompactView,
  });

  usePersistentEffect({
    storageKey: STORAGE_PHARMACY_KEY, value: pharmacySettings, enabled: hydrated,
    debounceMs: PHARMACY_PERSIST_DEBOUNCE_MS, failureMessage: PERSIST_FAILURE_MESSAGES.pharmacy, showToast,
  });
  usePersistentEffect({
    storageKey: SOUND_KEY, value: String(soundEnabled), json: false, enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.sound, showToast,
  });
  usePersistentEffect({
    storageKey: NOTIFICATIONS_KEY, value: String(notificationsEnabled), json: false, enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.notifications, showToast,
  });
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('font-scale-large', fontScale === 'large');
    }
    if (!hydrated) return;
    const err = persist(FONT_SIZE_KEY, fontScale, { json: false });
    if (err) console.warn('[AppRuntime] failed to persist font size:', err);
  }, [fontScale, hydrated]);
  usePersistentEffect({
    storageKey: CRITICAL_STOCK_ALERTS_KEY, value: String(criticalStockAlertsEnabled), json: false,
    enabled: hydrated, failureMessage: PERSIST_FAILURE_MESSAGES.critical, showToast,
  });
  usePersistentEffect({
    storageKey: COMPACT_VIEW_KEY, value: String(isCompactView), json: false,
    enabled: hydrated, failureMessage: 'تعذر حفظ خيار العرض', showToast,
  });

  useStartupAutoDeduction({ hydrated, isFirstRun, setMedications, setLogs, setGlobalAutoDeductEnabled, showToast });
  useStockAlerts({ medications, criticalStockAlertsEnabled, hydrated, isFirstRun });
  useCriticalAlarmScheduler({
    medications, criticalStockAlertsEnabled, hydrated, isFirstRun, exactAlarmPermission,
    resumeTick: criticalAlarmResumeTick,
  });
  useDoseReminderScheduler({
    medications, allowManualTakeActionByMedicationId, notificationsEnabled, hydrated, isFirstRun,
    exactAlarmPermission, resumeTick: doseAlarmResumeTick, lifecycleTick: doseLifecycleTick,
  });

  const autoDeductMidnightTick = useMidnightTick();
  useAutoDeductionScheduler({
    medications, globalAutoDeductEnabled, hydrated, isFirstRun, exactAlarmPermission,
    resumeTick: doseAlarmResumeTick, midnightTick: autoDeductMidnightTick,
  });
  useExactAutoDeductionReconciliation({
    setMedications, setLogs, setGlobalAutoDeductEnabled, globalAutoDeductEnabled,
    hydrated, isFirstRun, resumeTick: doseAlarmResumeTick, midnightTick: autoDeductMidnightTick,
  });

  const medicationHandlers = useMedicationHandlers({
    medications, logs, soundEnabled, globalAutoDeductEnabled, notificationsEnabled,
    criticalStockAlertsEnabled, selectDoseMode, setMedications, setLogs,
    setGlobalAutoDeductEnabled, setIsAutoDeductPromptOpen, setIsFirstRun,
    setNotificationsEnabled, setCriticalStockAlertsEnabled, setSelectDoseMed,
    setSelectDoseMode, setEditingMedication, showToast, dismissAlarm: () => { dismissAlarm(); return true; }, snoozeAlarm,
  });
  const pharmacyHandlers = usePharmacyUserHandlers({
    soundEnabled, settingsModalMode, pharmacySettings, setPharmacySettings, showToast,
  });
  useNativeActionHandlers({
    allowManualTakeActionByMedicationId,
    handleTakeDoseFromAlarmById: medicationHandlers.handleTakeDoseFromAlarmById,
    openAlarm, soundEnabled, setDoseLifecycleTick, setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick, setExactAlarmPermission, setNotificationsEnabled,
  });

  const preferenceHandlers = useAppPreferenceHandlers({
    soundEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    globalAutoDeductEnabled,
    setSoundEnabled,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    handleToggleGlobalAutoDeduct: medicationHandlers.handleToggleGlobalAutoDeduct,
    showToast,
  });

  return {
    ...medicationHandlers,
    ...pharmacyHandlers,
    ...preferenceHandlers,
  };
}
