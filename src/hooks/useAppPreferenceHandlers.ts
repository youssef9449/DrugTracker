import {
  requestNotificationPermission,
  getNotificationPermission,
} from '../utils/notifications/notificationPermissions';
import { sendTestAlertNotification } from '../utils/notifications/doseReminderNotifications';
import { openExactAlarmSettings } from '../utils/exactAlarm';
import { playSuccessChime } from '../utils/sound';
import { TOAST_MESSAGES } from '../constants/uiStrings';

export interface AppPreferenceHandlersDeps {
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  criticalStockAlertsEnabled: boolean;
  globalAutoDeductEnabled: boolean;
  setSoundEnabled: (v: boolean) => void;
  setNotificationsEnabled: (v: boolean) => void;
  setCriticalStockAlertsEnabled: (v: boolean) => void;
  handleToggleGlobalAutoDeduct: () => void | Promise<void>;
  showToast: (message: string) => void;
}

/**
 * Focused lifecycle handlers for app preference toggles, notification
 * permission, test notification, and exact-alarm settings.
 * Extracted from useAppRuntime to keep the runtime composition facade thin.
 */
export function useAppPreferenceHandlers(deps: AppPreferenceHandlersDeps) {
  const {
    soundEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    globalAutoDeductEnabled,
    setSoundEnabled,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    handleToggleGlobalAutoDeduct,
    showToast,
  } = deps;

  const handleApplyAppPreferences = async (prefs: {
    soundEnabled: boolean;
    notificationsEnabled: boolean;
    criticalStockAlertsEnabled: boolean;
    autoDeductEnabled: boolean;
  }) => {
    if (prefs.soundEnabled !== soundEnabled) {
      setSoundEnabled(prefs.soundEnabled);
    }
    if (prefs.autoDeductEnabled !== globalAutoDeductEnabled) {
      await handleToggleGlobalAutoDeduct();
    }
    if (prefs.notificationsEnabled !== notificationsEnabled) {
      setNotificationsEnabled(prefs.notificationsEnabled);
      showToast(
        prefs.notificationsEnabled
          ? TOAST_MESSAGES.notificationsOn
          : TOAST_MESSAGES.notificationsOff
      );
    }
    if (prefs.criticalStockAlertsEnabled !== criticalStockAlertsEnabled) {
      setCriticalStockAlertsEnabled(prefs.criticalStockAlertsEnabled);
      showToast(
        prefs.criticalStockAlertsEnabled
          ? TOAST_MESSAGES.criticalAlertsOn
          : TOAST_MESSAGES.criticalAlertsOff
      );
    }
    if (prefs.soundEnabled) {
      playSuccessChime();
    }
  };

  const handleToggleNotifications = async () => {
    if (!notificationsEnabled) {
      let pushAllowed = false;
      try {
        const currentPerm = await getNotificationPermission();
        if (currentPerm === 'granted') pushAllowed = true;
        else if (currentPerm === 'default') pushAllowed = await requestNotificationPermission();
      } catch (err) {
        console.warn('[AppPreferenceHandlers] Notification permission error:', err);
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
      console.warn('[AppPreferenceHandlers] Failed to send test alert notification:', err);
      showToast('تعذّر إرسال الإشعار التجريبي');
    }
  };

  const handleOpenExactAlarmSettings = () => {
    openExactAlarmSettings()
      .then((result) => {
        if (!result.ok) {
          console.warn('[AppPreferenceHandlers] exact alarm settings failed:', result.error, result.errorCode);
          showToast('إعدادات المنبهات الدقيقة غير متاحة على هذا الجهاز');
        }
      })
      .catch((err) => {
        console.warn('[AppPreferenceHandlers] exact alarm settings failed:', err);
      });
  };

  return {
    handleToggleNotifications,
    handleApplyAppPreferences,
    handleSendTestNotification,
    handleOpenExactAlarmSettings,
  };
}
