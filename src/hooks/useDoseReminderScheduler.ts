import { useEffect, useMemo, useRef } from 'react';
import type { Medication, CustomSoundFile } from '../types';
import { effectiveCurrentPills } from '../utils/dateCalculations';
import {
  scheduleDoseReminder,
  cancelDoseReminder,
  cancelSnoozedDoseReminder,
  cancelLegacySnoozedDoseReminder,
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
} from '../utils/notifications';

/**
 * Options for {@link useDoseReminderScheduler}.
 */
export interface UseDoseReminderSchedulerOptions {
  medications: Medication[];
  notificationsEnabled: boolean;
  hydrated: boolean;
  isFirstRun: boolean;
  /**
   * Whether exact-alarm permission is granted on Android 12+. When false,
   * the scheduler does NOT schedule dose reminders (they would be inexact
   * and fire at unpredictable times — unacceptable for medication
   * reminders). The caller must surface this to the user so they can
   * grant the permission via Android settings.
   *
   * On web / Android < 12 this is always true (no permission needed).
   */
  exactAlarmEnabled: boolean | null;
  appInForeground: boolean;
  /**
   * The global user-uploaded custom sound. When the user changes it, all
   * scheduled dose reminders are re-armed so the notification's `extra`
  * state is used by the foreground App handler; Android always uses the
  * bundled sound on the background channel.
   */
  globalCustomSound?: CustomSoundFile | null;
}

/**
 * Native recurring daily dose-reminder scheduler.
 *
 * For each medication with `reminderEnabled + reminderTime`, schedules a
 * RECURRING daily notification at the reminderTime via Android's
 * AlarmManager (or iOS's UNUserNotificationCenter). The reminder fires
 * EVERY DAY at the configured time — even when the app is killed, the
 * device is in Doze, or the user never opens the app. The user sees the
 * reminder in their notification drawer.
 *
 * This is the NATIVE complement to the in-app polling in useDoseReminders:
 *   - useDoseReminders (polling): fires the in-app DoseAlarmModal + chime
 *     when the app is in the FOREGROUND and `now >= reminderTime`.
 *   - useDoseReminderScheduler (this hook): schedules a native recurring
 *     notification that fires in the BACKGROUND/killed at reminderTime.
 *
 * The native notification uses a SEPARATE id band (doseAlarm = 6M) from
 * the immediate dose notification (dose = 3M) so the two never collide.
 *
 * Race protection — stale-async guard + per-med serialization:
 *   Same pattern as useCriticalAlarmScheduler. All cancel/schedule ops
 *   for a given med are chained onto a per-med Promise so they run in
 *   order. A generation counter lets a stale async bail before scheduling.
 *
 * Boot persistence: scheduled notifications are persisted by the
 * @capacitor/local-notifications plugin and re-armed on BOOT_COMPLETED.
 */
export function useDoseReminderScheduler({
  medications,
  notificationsEnabled,
  hydrated,
  isFirstRun,
  exactAlarmEnabled,
  appInForeground,
  globalCustomSound,
}: UseDoseReminderSchedulerOptions): void {
  const scheduledDoseIdsRef = useRef<Set<string>>(new Set());
  const doseGenerationRef = useRef<Map<string, number>>(new Map());
  const doseChainRef = useRef<Map<string, Promise<void>>>(new Map());

  // Keep the latest medications in a ref so the effect reads the current
  // array without depending on the array reference (which changes on every
  // App render — even unrelated state like typing in a search field).
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  const customSoundRef = useRef(globalCustomSound);
  useEffect(() => {
    customSoundRef.current = globalCustomSound;
  }, [globalCustomSound]);

  // Stable signature capturing ONLY the fields that affect the dose
  // reminder schedule (id, reminderEnabled, reminderTime, name, dailyDose,
  // unit, currentPills, lastSyncDate) + the global custom sound identity
  // (fileName + dataUrl length, to re-arm when the user uploads a new
  // sound or deletes it). The effect is gated on this string so the full
  // cancel+schedule chain only re-runs when a med's reminder config
  // actually changes.
  const doseSignature = useMemo(
    () =>
      medications
        .map((m) =>
          [
            m.id,
            m.reminderEnabled ? 1 : 0,
            m.reminderTime ?? '',
            m.name,
            m.dailyDose,
            m.unit ?? '',
            m.currentPills,
            m.lastSyncDate ?? '',
          ].join('|')
        )
        .sort()
        .join('\n'),
    [medications]
  );

  // Separate signature for the custom sound so a sound change doesn't
  // require stringifying the (potentially large) data URL into the med
  // signature. A sound change triggers a full re-schedule.
  const soundSignature = useMemo(
    () => (globalCustomSound ? `${globalCustomSound.fileName}:${globalCustomSound.dataUrl.length}` : ''),
    [globalCustomSound]
  );

  /**
   * Append an async operation to the per-med chain and return the new
   * chain tail. The operation runs only after any previously-chained
   * operation for this med completes.
   */
  const enqueue = (medId: string, op: () => Promise<void>): Promise<void> => {
    const prev = doseChainRef.current.get(medId) ?? Promise.resolve();
    const next = prev.then(op, op);
    doseChainRef.current.set(medId, next);
    next.catch(() => void 0);
    return next;
  };

  useEffect(() => {
    if (!hydrated || isFirstRun) return;

    // User disabled notifications OR exact-alarm permission is missing →
    // cancel all previously-scheduled dose reminders and clear the
    // tracker. Exact-alarm is MANDATORY for medication dose reminders:
    // an inexact alarm could fire minutes or hours late, which is
    // unacceptable. Bump generations so any in-flight schedule from a
    // prior effect run is stale.
    if (!notificationsEnabled || exactAlarmEnabled !== true) {
      scheduledDoseIdsRef.current.forEach((id) => {
        doseGenerationRef.current.set(
          id,
          (doseGenerationRef.current.get(id) ?? 0) + 1
        );
        enqueue(id, () => cancelDoseReminder(id).then(() => cancelSnoozedDoseReminder(id)));
      });
      scheduledDoseIdsRef.current.clear();
      return;
    }

    const stillScheduled = new Set<string>();

    for (const med of medicationsRef.current) {
      // Bump generation for this med — any in-flight cancel+schedule
      // from a previous effect run is now stale.
      const gen = (doseGenerationRef.current.get(med.id) ?? 0) + 1;
      doseGenerationRef.current.set(med.id, gen);

      // Only schedule for meds with reminder enabled + a valid time.
      if (!med.reminderEnabled || !med.reminderTime) {
        // Reminder disabled / no time → cancel any previously-scheduled
        // alarm for this med, but don't schedule a new one.
        if (scheduledDoseIdsRef.current.has(med.id)) {
          enqueue(med.id, () => cancelDoseReminder(med.id).then(() => cancelSnoozedDoseReminder(med.id)));
        }
        continue;
      }

      const unit = med.unit || 'قرص';
      const name = med.name;
      const reminderTime = med.reminderTime;
      const dailyDose = med.dailyDose;
      const pills = effectiveCurrentPills(med);
      const perMedSound = med.notificationSound || 'classic_chime';
      // Capture the custom sound identity at schedule time so the closure
      // has the value the effect ran with (it won't change during the
      // async chain even if the ref updates).
      const customSound = customSoundRef.current ?? null;

      enqueue(med.id, () =>
        cancelDoseReminder(med.id)
          .then(() => {
            // Stale-guard: if a newer effect run bumped the generation,
            // bail — don't schedule a stale alarm.
            if (doseGenerationRef.current.get(med.id) !== gen) return;
            return cancelLegacySnoozedDoseReminder(med.id).then(() => scheduleDoseReminder(
              med.id,
              name,
              reminderTime,
              dailyDose,
              unit,
              pills,
              customSound,
              perMedSound,
              appInForeground
                ? DOSE_REMINDER_FOREGROUND_CHANNEL_ID
                : DOSE_REMINDER_CHANNEL_ID
            )).then(() => {
              // Post-schedule stale-guard: re-check the gen after the
              // await. If a newer run bumped it during the schedule(),
              // run a compensating cancel. Serialization guarantees this
              // runs BEFORE any newer schedule (newer chain appended after).
              if (doseGenerationRef.current.get(med.id) !== gen) {
                return cancelDoseReminder(med.id);
              }
            });
          })
      );
      stillScheduled.add(med.id);
    }

    // Cancel alarms for meds no longer in the list (deleted).
    for (const prevId of scheduledDoseIdsRef.current) {
      if (!stillScheduled.has(prevId)) {
        doseGenerationRef.current.set(
          prevId,
          (doseGenerationRef.current.get(prevId) ?? 0) + 1
        );
        enqueue(prevId, () => cancelDoseReminder(prevId).then(() => cancelSnoozedDoseReminder(prevId)));
      }
    }
    scheduledDoseIdsRef.current = stillScheduled;
  }, [
    doseSignature,
    soundSignature,
    notificationsEnabled,
    exactAlarmEnabled,
    appInForeground,
    hydrated,
    isFirstRun,
  ]);
}
