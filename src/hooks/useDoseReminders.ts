import { useCallback, useEffect, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { stopAllSounds } from '../utils/sound';
import { loadJson, saveJson } from '../utils/storage';
import { DEFAULT_SNOOZE_MINUTES, MS_PER_MINUTE } from '../utils/time';
import { scheduleSnoozedDoseReminder } from '../utils/notifications';
import { SNOOZE_KEY } from '../utils/doseReminderStorage';

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';

function firedKey(medId: string, dateStr: string) {
  return `${medId}:${dateStr}`;
}

interface UseDoseRemindersOptions {
  medications: Medication[];
}

/**
 * In-app dose-reminder alarm UI controller.
 *
 * Owns the DoseAlarmModal state (which medication is currently
 * "alarming") and exposes `openAlarm` / `dismissAlarm` / `snoozeAlarm` /
 * `testAlarm` for the UI + the native notification listener to call.
 *
 * === Architecture ===
 * The recurring native reminder is scheduled by
 * {@link useDoseReminderScheduler} (Android's AlarmManager fires it every
 * day at reminderTime, foreground or killed). When the notification fires
 * while the app is open, the `localNotificationReceived` listener in
 * native.ts calls back here via `openAlarm`. This hook has NO polling
 * and NO sound playback — the native channel sound is the single sound.
 *
 * === Snooze ===
 * Snoozing schedules a ONE-SHOT native notification X minutes in the
 * future (via scheduleSnoozedDoseReminder). When it fires the listener
 * calls `openAlarm` again — so the snooze works even if the user
 * backgrounded the app after snoozing.
 *
 * === FIRED_KEY dedup ===
 * `openAlarm` writes FIRED_KEY[medId:today] = true so the recurring
 * native notification, if it happens to fire twice (e.g. snooze + the
 * daily one), doesn't re-open the modal the same day. `testAlarm` does
 * NOT write FIRED_KEY (so testing the alarm doesn't block the real
 * scheduled reminder later).
 *
 * All callbacks are stable (empty dep useCallback) so listener
 * registrations that depend on them don't re-subscribe on every render.
 */
export function useDoseReminders({
  medications,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  const alarmingIdRef = useRef<string | null>(null);
  const isTestAlarmRef = useRef(false);

  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  const dismissAlarm = useCallback(() => {
    stopAllSounds();
    const current = alarmingIdRef.current;
    if (current) {
      if (!isTestAlarmRef.current) {
        const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
        fired[firedKey(current, getTodayDateString())] = true;
        saveJson(FIRED_KEY, fired);
      }
      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      delete snooze[current];
      saveJson(SNOOZE_KEY, snooze);
    }
    isTestAlarmRef.current = false;
    alarmingIdRef.current = null;
    setAlarmingMedication(null);
  }, []);

  const snoozeAlarm = useCallback((medication: Medication, minutes: number = DEFAULT_SNOOZE_MINUTES) => {
    stopAllSounds();
    const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
    snooze[medication.id] = Date.now() + minutes * MS_PER_MINUTE;
    saveJson(SNOOZE_KEY, snooze);
    alarmingIdRef.current = null;
    setAlarmingMedication(null);
    // Schedule a ONE-SHOT native notification X minutes in the future.
    // When it fires, the localNotificationReceived listener calls
    // openAlarm again — so snooze works even if the user backgrounded
    // the app after snoozing.
    scheduleSnoozedDoseReminder(
      medication.id,
      medication.name,
      medication.dailyDose,
      medication.unit,
      medication.reminderTime,
      minutes,
    ).catch(() => void 0);
  }, []);

  // openAlarm is called by the native localNotificationReceived listener
  // when the recurring dose-reminder notification fires while the app is
  // in the foreground. It opens the DoseAlarmModal + writes FIRED_KEY
  // (dedup). Stable signature (no deps) so the listener registration in
  // App.tsx doesn't re-subscribe on every render.
  //
  // NO sound is played here. The native notification channel plays the
  // bundled sound ('dose_reminder.wav'). There is no JS sound path.
  const openAlarm = useCallback((medId: string) => {
    const med = medicationsRef.current.find((m) => m.id === medId);
    if (!med) return; // med was deleted between scheduling and firing.

    // Today's dose was already consumed (manual card action or the
    // notification's take-dose action): never re-open the alarm modal
    // for a taken dose. This is the foreground safety net behind the
    // scheduler's native suppression — if the pending recurring/snoozed
    // alarm could not be cancelled (e.g. a bridge error), the UI must
    // not ask the user to take the dose again. Legitimate snooze
    // re-fires are unaffected: in that flow the dose has NOT been
    // taken, so this guard does not hit.
    if (med.lastConsumedDate === getTodayDateString()) return;

    // Dedup: if already alarming this med, don't re-open.
    if (alarmingIdRef.current === med.id) return;

    // Dedup: if already fired today, don't re-open.
    const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
    if (fired[firedKey(med.id, getTodayDateString())]) return;

    // Snooze: if the user snoozed and the window hasn't elapsed yet,
    // don't re-open (the snoozed notification will fire when it ends).
    const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
    const snoozeUntil = snooze[med.id];
    if (snoozeUntil && Date.now() < snoozeUntil) return;

    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
  }, []);

  // testAlarm opens the modal for a manual test. It does NOT write
  // FIRED_KEY so it doesn't block the real scheduled reminder.
  // No sound is played — the test notification button in settings
  // sends a real native notification (which plays the channel sound).
  const testAlarm = useCallback((med: Medication) => {
    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
    isTestAlarmRef.current = true;
  }, []);

  return {
    alarmingMedication,
    openAlarm,
    dismissAlarm,
    snoozeAlarm,
    testAlarm,
  };
}
