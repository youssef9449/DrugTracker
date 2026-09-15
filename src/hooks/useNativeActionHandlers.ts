import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { Medication } from '../types';
import {
  registerNotificationActionHandler,
  registerDoseReceivedHandler,
  registerAppResumeHandler,
} from '../native';
import { getExactAlarmPermission } from '../utils/notifications';
import { playSuccessChime } from '../utils/sound';

/**
 * Registers native notification-action, dose-received, and app-resume
 * handlers. Cleanup unregisters on unmount / dependency change.
 * Semantics match the previous inline effects in App.tsx.
 */
export function useNativeActionHandlers(opts: {
  medications: Medication[];
  handleTakeDoseFromAlarm: (med: Medication, doseId?: string) => void;
  openAlarm: (medId: string, doseId?: string) => void;
  soundEnabled: boolean;
  setDoseLifecycleTick: Dispatch<SetStateAction<number>>;
  setCriticalAlarmResumeTick: Dispatch<SetStateAction<number>>;
  setDoseAlarmResumeTick: Dispatch<SetStateAction<number>>;
  setExactAlarmEnabled: Dispatch<SetStateAction<boolean | null>>;
}): void {
  const {
    medications,
    handleTakeDoseFromAlarm,
    openAlarm,
    soundEnabled,
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
    setExactAlarmEnabled,
  } = opts;

  useEffect(() => {
    registerNotificationActionHandler((actionId, medicationId, doseId) => {
      if (actionId !== 'take_dose') return;
      const medication = medications.find((med) => med.id === medicationId);
      if (medication) handleTakeDoseFromAlarm(medication, doseId);
    });
    return () => registerNotificationActionHandler(null);
  }, [medications, handleTakeDoseFromAlarm]);

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
      const med = medications.find((m) => m.id === medicationId);
      if (med && med.autoDeductEnabled !== false) {
        return;
      }
      openAlarm(medicationId, doseId);
      if (soundEnabled) playSuccessChime();
    });
    return () => registerDoseReceivedHandler(null);
  }, [openAlarm, soundEnabled, medications]);

  // ─────────────────────────────────────────────────────────────
  // App-resume handler: re-check exact-alarm permission when the app
  // returns to the foreground. The user may have just granted/denied
  // SCHEDULE_EXACT_ALARM in the Android settings screen (opened via the
  // "السماح بالمنبهات الدقيقة" button in AppSettingsModal). When the
  // permission state changes, the useDoseReminderScheduler effect
  // (which depends on exactAlarmEnabled) re-runs and reschedules all
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
        setCriticalAlarmResumeTick((tick) => tick + 1);
        setDoseAlarmResumeTick((tick) => tick + 1);
        getExactAlarmPermission()
          .then((state) => {
            setExactAlarmEnabled(state === 'granted');
          })
          .catch((err) => {
            console.warn('[App] Resume exact-alarm re-check failed:', err);
          });
      }
    });
    return () => registerAppResumeHandler(null);
  }, []);

}
