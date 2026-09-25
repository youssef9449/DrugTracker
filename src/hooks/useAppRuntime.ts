import type { AppRuntimeState } from './useAppRuntimeState';
import type { AppUiState } from './useAppUiState';
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
import { useAppPersistence } from './useAppPersistence';

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

  useAppPersistence({
    hydrated,
    pharmacySettings,
    soundEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    fontScale,
    isCompactView,
    showToast,
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
  // #502: the scheduler's explicit runtime status (including the
  // "Auto enabled + missing/invalid doseSchedule" unsupported state) is
  // consumed here so the application can surface it through the UI status
  // path instead of silently showing a healthy-looking zero-occurrence
  // medication.
  const autoDeductionStatus = useAutoDeductionScheduler({
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
    // #502: Auto-enabled medication IDs with no usable explicit doseSchedule.
    // Canonical Auto definition is the sole source of truth (no hidden
    // fallbacks from dailyDose/reminderTime, no synthesized dose IDs).
    medicationIdsMissingDoseSchedule: autoDeductionStatus.medicationIdsMissingDoseSchedule,
  };
}
