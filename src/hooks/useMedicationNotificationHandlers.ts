import { useCallback } from 'react';
import {
  requestNotificationPermission,
  getNotificationPermission,
} from '../utils/notifications/notificationPermissions';
import { getExactAlarmPermission } from '../utils/exactAlarm';
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
    // #487: explicit concept separation — the Android notification grant is
    // a PLATFORM capability, criticalStockAlertsEnabled is the FEATURE
    // preference. One never stands in for the other.
    let platformNotificationsGranted = false;
    try {
      const currentPerm = await getNotificationPermission();
      if (currentPerm === 'granted') platformNotificationsGranted = true;
      else if (currentPerm === 'default') platformNotificationsGranted = await requestNotificationPermission();
    } catch (err) {
      console.warn('[App] Notification permission error (critical toggle):', err);
    }
    if (!platformNotificationsGranted) {
      showToast(TOAST_MESSAGES.notificationsPermissionDenied);
      return;
    }
    setCriticalStockAlertsEnabled(true);
    if (soundEnabled) playSuccessChime();
    showToast(TOAST_MESSAGES.criticalAlertsOn);
    // #504: surface the shared Exact Alarm prerequisite for Critical Stock
    // SCHEDULED background delivery. The preference stays enabled (denial is
    // not a disable) and foreground delivery remains available, but the
    // runtime contract must not present background delivery as armed when the
    // shared capability layer reports denial. The shared
    // getExactAlarmPermission() is the only platform probe.
    try {
      const exactAlarmState = await getExactAlarmPermission();
      if (exactAlarmState === 'denied') {
        showToast(
          'لعمل تنبيهات المخزون الحرج في الخلفية، يجب السماح بالمنبهات الدقيقة في إعدادات النظام.'
        );
      }
    } catch (err) {
      console.warn('[App] Exact-alarm capability check failed (critical toggle):', err);
    }
  }, [criticalStockAlertsEnabled, soundEnabled, showToast, setCriticalStockAlertsEnabled]);

  return {
    handleToggleCriticalStockAlerts,
    handleToggleMedicationReminder: (medicationId: string) =>
      handleToggleMedicationNotification(medicationId, 'reminderEnabled'),
    handleToggleMedicationCriticalStockAlerts: (medicationId: string) =>
      handleToggleMedicationNotification(medicationId, 'criticalStockAlertsEnabled'),
  };
}
