import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { Medication, ConsumptionLog, PharmacySettings } from '../types';
import type { ExactAlarmPermission } from '../utils/exactAlarm';
import {
  requestNotificationPermission,
  getNotificationPermission,
} from '../utils/notifications/notificationPermissions';
import { sendTestAlertNotification } from '../utils/notifications/doseReminderNotifications';
import { openExactAlarmSettings } from '../utils/exactAlarm';
import { playSuccessChime } from '../utils/sound';
import { persist } from '../utils/storage';
import { PERSIST_FAILURE_MESSAGES, TOAST_MESSAGES } from '../constants/uiStrings';
import {
  STORAGE_PHARMACY_KEY,
  SOUND_KEY,
  NOTIFICATIONS_KEY,
  FONT_SIZE_KEY,
  CRITICAL_STOCK_ALERTS_KEY,
  COMPACT_VIEW_KEY,
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

export interface AppRuntimeDeps {
  medications: Medication[];
  logs: ConsumptionLog[];
  pharmacySettings: PharmacySettings;
  hydrated: boolean;
  isFirstRun: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  exactAlarmPermission: ExactAlarmPermission | null;
  criticalAlarmResumeTick: number;
  doseAlarmResumeTick: number;
  doseLifecycleTick: number;
  globalAutoDeductEnabled: boolean;
  selectDoseMode: 'take' | 'restore' | 'manage';
  settingsModalMode: 'all' | 'pharmacy';
  allowManualTakeActionByMedicationId: Map<string, boolean>;
  setMedications: Dispatch<SetStateAction<Medication[]>>;
  setLogs: Dispatch<SetStateAction<ConsumptionLog[]>>;
  setPharmacySettings: Dispatch<SetStateAction<PharmacySettings>>;
  setHydrated: Dispatch<SetStateAction<boolean>>;
  setIsFirstRun: Dispatch<SetStateAction<boolean>>;
  setIsAutoDeductPromptOpen: Dispatch<SetStateAction<boolean>>;
  setSoundEnabled: Dispatch<SetStateAction<boolean>>;
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>;
  setCriticalStockAlertsEnabled: Dispatch<SetStateAction<boolean>>;
  setExactAlarmPermission: Dispatch<SetStateAction<ExactAlarmPermission | null>>;
  setGlobalAutoDeductEnabled: Dispatch<SetStateAction<boolean>>;
  setFontScale: Dispatch<SetStateAction<'normal' | 'large'>>;
  setIsCompactView: Dispatch<SetStateAction<boolean>>;
  setSelectDoseMed: Dispatch<SetStateAction<Medication | null>>;
  setSelectDoseMode: Dispatch<SetStateAction<'take' | 'restore' | 'manage'>>;
  setEditingMedication: Dispatch<SetStateAction<Medication | null>>;
  setDoseLifecycleTick: Dispatch<SetStateAction<number>>;
  setCriticalAlarmResumeTick: Dispatch<SetStateAction<number>>;
  setDoseAlarmResumeTick: Dispatch<SetStateAction<number>>;
  showToast: (message: string) => void;
  dismissAlarm: () => void;
  snoozeAlarm: (minutes?: number) => void;
  openAlarm: (medication: Medication, doseId?: string) => void;
}

export function useAppRuntime(deps: AppRuntimeDeps) {
  const {
    medications, logs, pharmacySettings, hydrated, isFirstRun, soundEnabled,
    notificationsEnabled, criticalStockAlertsEnabled, exactAlarmPermission,
    criticalAlarmResumeTick, doseAlarmResumeTick, doseLifecycleTick,
    globalAutoDeductEnabled, selectDoseMode, settingsModalMode,
    allowManualTakeActionByMedicationId, setMedications, setLogs,
    setPharmacySettings, setHydrated, setIsFirstRun, setIsAutoDeductPromptOpen,
    setSoundEnabled, setNotificationsEnabled, setCriticalStockAlertsEnabled,
    setExactAlarmPermission, setGlobalAutoDeductEnabled, setFontScale,
    setIsCompactView, setSelectDoseMed, setSelectDoseMode, setEditingMedication,
    setDoseLifecycleTick, setCriticalAlarmResumeTick, setDoseAlarmResumeTick,
    showToast, dismissAlarm, snoozeAlarm, openAlarm,
  } = deps;

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
    setSelectDoseMode, setEditingMedication, showToast, dismissAlarm, snoozeAlarm,
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

  const handleToggleNotifications = async () => {
    if (!notificationsEnabled) {
      let pushAllowed = false;
      try {
        const currentPerm = await getNotificationPermission();
        if (currentPerm === 'granted') pushAllowed = true;
        else if (currentPerm === 'default') pushAllowed = await requestNotificationPermission();
      } catch (err) {
        console.warn('[AppRuntime] Notification permission error:', err);
      }
      if (!pushAllowed) {
        showToast(TOAST_MESSAGES.notificationsPermissionDenied);
        return;
      }
      setNotificationsEnabled(true);
      if (soundEnabled) playSuccessChime();
      showToast(TOAST_MESSAGES.notificationsOn);
      return;
    }
    setNotificationsEnabled(false);
    showToast(TOAST_MESSAGES.notificationsOff);
  };

  const handleSendTestNotification = async () => {
    if (soundEnabled) playSuccessChime();
    try {
      await sendTestAlertNotification();
      showToast(TOAST_MESSAGES.testNotificationSent);
    } catch (err) {
      console.warn('[AppRuntime] Failed to send test alert notification:', err);
      showToast('تعذّر إرسال الإشعار التجريبي');
    }
  };

  const handleOpenExactAlarmSettings = () => {
    openExactAlarmSettings()
      .then((result) => {
        if (!result.ok) {
          console.warn('[AppRuntime] exact alarm settings failed:', result.error, result.errorCode);
          showToast('إعدادات المنبهات الدقيقة غير متاحة على هذا الجهاز');
        }
      })
      .catch((err) => {
        console.warn('[AppRuntime] exact alarm settings failed:', err);
      });
  };

  return {
    ...medicationHandlers,
    ...pharmacyHandlers,
    handleToggleNotifications,
    handleSendTestNotification,
    handleOpenExactAlarmSettings,
  };
}
