import { useCallback } from 'react';
import {
  requestNotificationPermission,
  getNotificationPermission,
} from '../utils/notifications/notificationPermissions';
import { playSuccessChime } from '../utils/sound';
import { TOAST_MESSAGES, STORAGE_ERRORS } from '../constants/uiStrings';
import { runGatedMedicationNotificationToggle } from '../utils/manualStockMutation';
import { runAsyncCommand } from '../utils/async/runAsyncCommand';
import type { MedicationHandlerState, MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationNotificationHandlers(deps: MedicationHandlersDeps, state: MedicationHandlerState) {
  const {
    soundEnabled,
    criticalStockAlertsEnabled,
    setMedications,
    setLogs,
    setCriticalStockAlertsEnabled,
    showToast,
  } = deps;

  const handleToggleMedicationNotification = useCallback(
    (medicationId: string, field: 'reminderEnabled' | 'criticalStockAlertsEnabled') => {
      runAsyncCommand(
        'medication-notification.toggle',
        async () => {
        const result = await runGatedMedicationNotificationToggle({ medicationId, field });
        if (result.outcome === 'applied') {
          setMedications(result.medications);
          state.medicationsRef.current = result.medications;
          setLogs(result.logs);
          const label = field === 'reminderEnabled' ? 'تذكير موعد الجرعة' : 'تنبيه المخزون الحرج';
          showToast(
            result.enabled
              ? `تم تفعيل ${label} لدواء "${result.medicationName ?? medicationId}"`
              : `تم إيقاف ${label} لدواء "${result.medicationName ?? medicationId}"`
          );
          if (soundEnabled) playSuccessChime();
          return;
        }
        if (result.outcome === 'missing_med') {
          showToast('تعذر العثور على الدواء المطلوب.');
        } else if (result.outcome === 'persist_failed' || result.outcome === 'native_list_failed') {
          showToast(STORAGE_ERRORS.generic);
        }
          }
        },
        () => {
          showToast(STORAGE_ERRORS.generic);
        }
      );
    },
    [setMedications, setLogs, showToast, soundEnabled, state.medicationsRef]
  );

  const handleToggleCriticalStockAlerts = useCallback(async () => {
    const next = !criticalStockAlertsEnabled;
    if (!next) {
      setCriticalStockAlertsEnabled(false);
      showToast(TOAST_MESSAGES.criticalAlertsOff);
      return;
    }
    let pushAllowed = false;
    try {
      const currentPerm = await getNotificationPermission();
      if (currentPerm === 'granted') pushAllowed = true;
      else if (currentPerm === 'default') pushAllowed = await requestNotificationPermission();
    } catch (err) {
      console.warn('[App] Notification permission error (critical toggle):', err);
    }
    if (!pushAllowed) {
      showToast(TOAST_MESSAGES.notificationsPermissionDenied);
      return;
    }
    setCriticalStockAlertsEnabled(true);
    if (soundEnabled) playSuccessChime();
    showToast(TOAST_MESSAGES.criticalAlertsOn);
  }, [criticalStockAlertsEnabled, soundEnabled, showToast, setCriticalStockAlertsEnabled]);

  return {
    handleToggleCriticalStockAlerts,
    handleToggleMedicationReminder: (medicationId: string) =>
      handleToggleMedicationNotification(medicationId, 'reminderEnabled'),
    handleToggleMedicationCriticalStockAlerts: (medicationId: string) =>
      handleToggleMedicationNotification(medicationId, 'criticalStockAlertsEnabled'),
  };
}
