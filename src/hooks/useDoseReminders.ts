import { useCallback, useEffect, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { playNotificationSound, stopAllSounds } from '../utils/sound';
import { loadJson, saveJson } from '../utils/storage';
import { DEFAULT_SNOOZE_MINUTES, MS_PER_MINUTE } from '../utils/time';
import { scheduleSnoozedDoseReminder } from '../utils/notifications';

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';
const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

function firedKey(medId: string, dateStr: string) {
  return `${medId}:${dateStr}`;
}

interface UseDoseRemindersOptions {
  medications: Medication[];
  soundEnabled: boolean;
}

/**
 * In-app dose-reminder alarm UI controller.
 *
 * Owns the DoseAlarmModal state (which medication is currently
 * "alarming") and exposes `openAlarm` / `dismissAlarm` / `snoozeAlarm` /
 * `testAlarm` for the UI + the native notification listener to call.
 *
 * === History ===
 * Previously this hook ran a JS polling interval (every 5s) that checked
 * `now >= reminderTime` and fired the alarm itself. That only worked while
 * the app was in the foreground — when killed, no reminder fired at all.
 *
 * The recurring native reminder is now scheduled by
 * {@link useDoseReminderScheduler} (Android's AlarmManager fires it every
 * day at reminderTime, foreground or killed). When the notification fires
 * while the app is open, the `localNotificationReceived` listener in
 * native.ts calls back here via `openAlarm`. This hook no longer polls.
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
 * They read the latest medications/sound/id via refs kept in sync by
 * small effects.
 */
export function useDoseReminders({
  medications,
  soundEnabled,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  // The currently-alarming med id, kept in a ref so the stable
  // dismissAlarm/snoozeAlarm callbacks can read/write it without deps.
  const alarmingIdRef = useRef<string | null>(null);
  // #13: set to true by testAlarm so dismissAlarm knows NOT to write
  // FIRED_KEY (which would block the real scheduled reminder for the
  // day). Reset to false at the start of every openAlarm call.
  const isTestAlarmRef = useRef(false);

  const soundEnabledRef = useRef(soundEnabled);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

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
    // the app after snoozing. (Replaces the old polling-based snooze.)
    scheduleSnoozedDoseReminder(
      medication.id,
      medication.name,
      medication.dailyDose,
      medication.unit,
      medication.reminderTime,
      minutes,
      medication.notificationSound || 'classic_chime'
    ).catch(() => void 0);
  }, []);

  // openAlarm is called by the native localNotificationReceived listener
  // when the recurring dose-reminder notification fires while the app is
  // in the foreground. It opens the DoseAlarmModal + plays the per-med
  // chime + writes FIRED_KEY (dedup). Stable signature (no deps) so the
  // listener registration in App.tsx doesn't re-subscribe on every render.
  const openAlarm = useCallback((medId: string) => {
    // Resolve the med from the latest medications array.
    const med = medicationsRef.current.find((m) => m.id === medId);
    if (!med) return; // med was deleted between scheduling and firing.

    // Dedup: if already alarming this med, don't re-open.
    if (alarmingIdRef.current === med.id) return;

    // Dedup: if already fired today (e.g. user took the dose already),
    // don't re-open. (The daily native schedule still fires tomorrow.)
    const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
    if (fired[firedKey(med.id, getTodayDateString())]) return;

    // Snooze: if the user snoozed and the window hasn't elapsed yet,
    // don't re-open (the snoozed notification will fire when it ends).
    const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
    const snoozeUntil = snooze[med.id];
    if (snoozeUntil && Date.now() < snoozeUntil) return;

    // Reset the test flag (a real alarm is not a test).
    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
    // NOTE: we do NOT play any sound here. The
    // localNotificationReceived listener in native.ts already played
    // the SINGLE authoritative sound (custom sound if set, otherwise
    // the per-med synthesized chime) before calling openAlarm. Playing
    // a second sound here would produce a double-sound bug. The
    // soundEnabled flag is respected by the listener (it reads the
    // per-med notificationSound from the notification's extra field).
  }, []);

  const testAlarm = useCallback((med: Medication) => {
    // Open the modal + play the chime for a manual test (the per-card
    // "تجربة صوت وتنبيه الدواء" button). Does NOT write FIRED_KEY.
    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
    if (soundEnabledRef.current) {
      playNotificationSound(med.notificationSound || 'classic_chime');
    }
    // #13: set the test flag AFTER opening (which resets it) so
    // dismissAlarm knows NOT to write FIRED_KEY for this alarm.
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
