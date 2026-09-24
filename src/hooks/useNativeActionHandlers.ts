import { useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  registerNotificationActionHandler,
  registerDoseReceivedHandler,
  registerAppResumeHandler,
} from '../native';
import { getExactAlarmPermission, type ExactAlarmPermission } from '../utils/exactAlarm';
import { getNotificationPermission } from '../utils/notifications/notificationPermissions';
import { NOTIFICATIONS_KEY } from '../constants/storageKeys';
import { isNotificationChannelEnabled, retryPersistedNotificationDeliveries } from '../utils/notificationRuntime';
import { isDoseReminderOccurrenceOwned } from '../utils/doseReminderNative';
import {
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
} from '../utils/notifications/doseReminderNotifications';
import { playSuccessChime } from '../utils/sound';
import { runAsyncCommand } from '../utils/async/runAsyncCommand';
/**
 * Registers native notification-action, dose-received, and app-resume
 * handlers. Cleanup unregisters on unmount / dependency change.
 * Semantics match the previous inline effects in App.tsx.
 */
export function useNativeActionHandlers(opts: {
  allowManualTakeActionByMedicationId: ReadonlyMap<string, boolean>;
  handleTakeDoseFromAlarmById: (medicationId: string, doseId?: string) => void;
  openAlarm: (medId: string, doseId: string) => void;
  soundEnabled: boolean;
  setDoseLifecycleTick: Dispatch<SetStateAction<number>>;
  setCriticalAlarmResumeTick: Dispatch<SetStateAction<number>>;
  setDoseAlarmResumeTick: Dispatch<SetStateAction<number>>;
  setExactAlarmPermission: Dispatch<SetStateAction<ExactAlarmPermission | null>>;
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>;
}): void {
  const {
    allowManualTakeActionByMedicationId,
    handleTakeDoseFromAlarmById,
    openAlarm,
    soundEnabled,
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
    setExactAlarmPermission,
    setNotificationsEnabled,
  } = opts;
  useEffect(() => {
    registerNotificationActionHandler((actionId, medicationId, doseId) => {
      const separator = actionId.indexOf('|');
      const baseActionId = separator >= 0 ? actionId.slice(0, separator) : actionId;
      const operationVersion = separator >= 0 ? actionId.slice(separator + 1) : '';
      if (baseActionId !== 'take_dose') return;
      // Android Dose Reminder actions carry the exact operation version that
      // created the displayed occurrence. Reject stale actions after a
      // schedule replacement/cancellation before any durable Take mutation.
      if (operationVersion) {
        runAsyncCommand(
          'notification-action.ownership',
          async () => {
            const owned = await isDoseReminderOccurrenceOwned(
              medicationId,
              doseId ?? '',
              operationVersion
            );
            if (owned) handleTakeDoseFromAlarmById(medicationId, doseId);
          }
        );
        return;
      }
      // Notification actions carry durable identity. Never require the React
      // medication list to be present/correct before starting the gated Take.
      handleTakeDoseFromAlarmById(medicationId, doseId);
    });
    return () => registerNotificationActionHandler(null);
  }, [handleTakeDoseFromAlarmById]);
  // Register the dose-received handler: when a native dose-reminder
  // notification fires while the app is in the foreground, the
  // localNotificationReceived listener in native.ts calls this handler
  // with the medicationId, which opens the DoseAlarmModal via openAlarm.
  // The notification was scheduled on the SILENT foreground channel
  // (dose-reminder-foreground-v1), so Android produces no sound. The
  // in-app chime (playSuccessChime) is the ONLY sound — gated by the
  // existing soundEnabled setting, exactly like all other UI feedback.
  useEffect(() => {
    registerDoseReceivedHandler((medicationId, doseId) => {
      // interactive alarm requires explicit doseSchedule doseId.
      if (!doseId || !String(doseId).trim()) return;
      if (allowManualTakeActionByMedicationId.get(medicationId) === false) {
        return;
      }
      openAlarm(medicationId, String(doseId).trim());
      if (soundEnabled) playSuccessChime();
    });
    return () => registerDoseReceivedHandler(null);
  }, [openAlarm, soundEnabled, allowManualTakeActionByMedicationId]);
  // ─────────────────────────────────────────────────────────────
  // App-resume handler: re-check exact-alarm permission when the app
  // returns to the foreground. The user may have just granted/denied
  // SCHEDULE_EXACT_ALARM in the Android settings screen (opened via the
  // "السماح بالمنبهات الدقيقة" button in AppSettingsModal). When the
  // permission state changes, the useDoseReminderScheduler effect
  // (which depends on exactAlarmPermission) re-runs and reschedules all
  // dose reminders with the correct (exact or cancelled) policy.
  //
  // The resume also reconciles the CRITICAL alarms: every resume bumps
  // criticalAlarmResumeTick → useCriticalAlarmScheduler re-runs and
  // verifies each matching claim against the platform's actual pending
  // notifications, re-arming any alarm the OS dropped (exact-alarm
  // permission revoked, scheduled notification removed, …).
  //
  // …and the DOSE reminders: every resume bumps doseAlarmResumeTick →
  // useDoseReminderScheduler's consumption-suppression effect re-runs,
  // so a dose consumed today (manually or via the notification action)
  // can never produce today's reminder after a resume — repairing any
  // suppression attempt that failed.
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    registerAppResumeHandler((isActive) => {
      // Always bump the lifecycle tick on BOTH foreground and background
      // transitions so useDoseReminderScheduler re-arms all pending dose
      // reminders on the correct channel (silent foreground / system-sound
      // background). native.ts already called setAppInForeground(isActive)
      // before this handler runs, so getDoseReminderChannelId() returns
      // the right channel when the scheduler re-schedules.
      setDoseLifecycleTick((tick) => tick + 1);
      if (isActive) {
        runAsyncCommand(
          'app-resume.notification-delivery-retry',
          async () => {
            await retryPersistedNotificationDeliveries();
          }
        );
        setCriticalAlarmResumeTick((tick) => tick + 1);
        setDoseAlarmResumeTick((tick) => tick + 1);
        getExactAlarmPermission()
          .then((state) => {
            setExactAlarmPermission(state);
          })
          .catch((err) => {
            console.warn('[App] Resume exact-alarm re-check failed:', err);
          });
        Promise.all([
          getNotificationPermission(),
          isNotificationChannelEnabled(DOSE_REMINDER_CHANNEL_ID),
          isNotificationChannelEnabled(DOSE_REMINDER_FOREGROUND_CHANNEL_ID),
        ])
          .then(([permission, backgroundChannel, foregroundChannel]) => {
            const storedPreference = localStorage.getItem(NOTIFICATIONS_KEY);
            const desired = storedPreference === null || storedPreference === 'true';
            setNotificationsEnabled(
              desired
                && permission === 'granted'
                && backgroundChannel
                && foregroundChannel
            );
          })
          .catch((err) => {
            console.warn('[App] Resume notification capability re-check failed:', err);
          });
      }
    });
    return () => registerAppResumeHandler(null);
  }, [
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
    setExactAlarmPermission,
    setNotificationsEnabled,
  ]);
}