import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString, effectiveCurrentPills } from '../utils/dateCalculations';
import { playNotificationSound } from '../utils/sound';
import { sendMedicationDoseReminder } from '../utils/notifications';
import { loadJson, saveJson } from '../utils/storage';

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';
const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

function getNowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Convert a "HH:MM" 24-hour string to minutes-since-midnight.
 *
 * Returns -1 for malformed input (NaN, wrong shape, or out-of-range
 * hour/minute — #25). Used by the polling effect to compare the current
 * time against a medication's `reminderTime`; a -1 return causes the
 * reminder to be skipped rather than firing at an unreachable time.
 *
 * Exported so the validation contract can be unit-tested directly.
 */
export function timeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':').map((n) => parseInt(n, 10));
  const [h, m] = parts;
  // Missing hour or minute (no colon, or empty side) → NaN or undefined.
  if (parts.length < 2 || Number.isNaN(h) || Number.isNaN(m)) return -1;
  // #25: reject out-of-range hours/minutes so a corrupted reminderTime
  // (e.g. "25:99") doesn't produce an unreachable minute count that
  // silently never fires.
  if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
  return h * 60 + m;
}

function firedKey(medId: string, dateStr: string) {
  return `${medId}:${dateStr}`;
}

interface UseDoseRemindersOptions {
  medications: Medication[];
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  /**
   * #24: when false (before App has hydrated persisted state from
   * localStorage/IndexedDB), the polling effect does NOT run `checkDue`,
   * so phantom alarms for the SEED medications don't fire before the
   * user's real saved medications are loaded.
   */
  hydrated: boolean;
  globalCustomSound?: { fileName: string; mimeType: string; dataUrl: string } | null;
}

export function useDoseReminders({
  medications,
  soundEnabled,
  notificationsEnabled,
  hydrated,
  globalCustomSound,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  const queueRef = useRef<string[]>([]);
  const alarmingIdRef = useRef<string | null>(null);
  // #13: set to true by testAlarm so dismissAlarm knows NOT to write
  // FIRED_KEY (which would block the real scheduled reminder for the
  // day). Reset to false at the start of every triggerAlarm call so
  // subsequent real alarms still mark themselves fired.
  const isTestAlarmRef = useRef(false);

  // Keep the latest sound/notify flags + global custom sound in refs so
  // the stable `triggerAlarm` callback can read them without being
  // recreated on every change (which would re-run the polling effect
  // and reset timers). This fixes the H5 stale-closure bug where the
  // polling interval kept using an outdated `globalCustomSound`.
  const soundEnabledRef = useRef(soundEnabled);
  const notificationsEnabledRef = useRef(notificationsEnabled);
  const globalCustomSoundRef = useRef(globalCustomSound);
  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);
  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);
  useEffect(() => {
    globalCustomSoundRef.current = globalCustomSound;
  }, [globalCustomSound]);

  // #90: keep the latest medications in a ref so the polling effect +
  // dismissAlarm can read the current array without depending on the
  // array reference (which changes on every App render, even unrelated
  // state changes like typing in a search field).
  const medicationsRef = useRef(medications);
  useEffect(() => {
    medicationsRef.current = medications;
  }, [medications]);

  // #90: stable signature capturing ONLY the fields checkDue actually
  // reads (reminderEnabled, reminderTime, id). The polling effect is
  // gated on this string instead of the raw `medications` array ref,
  // so the 5s interval is NOT torn down/recreated on every App state
  // change — only when a med's reminder config actually changes.
  const reminderSignature = useMemo(
    () =>
      medications
        .map((m) => `${m.id}|${m.reminderEnabled ? 1 : 0}|${m.reminderTime ?? ''}`)
        .sort()
        .join('\n'),
    [medications]
  );

  const dismissAlarm = useCallback(() => {
    const current = alarmingIdRef.current;
    if (current) {
      // #13: only mark the reminder as "fired for today" if this alarm
      // was a REAL scheduled reminder, not a test alarm triggered by
      // the user clicking "تجربة الصوت". A test alarm would otherwise
      // poison FIRED_KEY and block the real reminder later that day.
      if (!isTestAlarmRef.current) {
        const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
        fired[firedKey(current, getTodayDateString())] = true;
        saveJson(FIRED_KEY, fired);
      }

      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      delete snooze[current];
      saveJson(SNOOZE_KEY, snooze);
    }
    // Reset the test flag so the next alarm (real or test) starts clean.
    isTestAlarmRef.current = false;
    alarmingIdRef.current = null;
    setAlarmingMedication(null);

    const nextId = queueRef.current.shift();
    if (nextId) {
      // #90: read from the ref so dismissAlarm doesn't depend on the
      // medications array reference.
      const next = medicationsRef.current.find((m) => m.id === nextId);
      if (next) {
        triggerAlarm(next, false);
      }
    }
    // triggerAlarm is stable (useCallback with [] deps) so it's safe to
    // omit from the dep array. eslint-disable for the missing dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snoozeAlarm = useCallback((minutes: number = 10) => {
    const current = alarmingIdRef.current;
    if (current) {
      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      snooze[current] = Date.now() + minutes * 60 * 1000;
      saveJson(SNOOZE_KEY, snooze);
    }
    alarmingIdRef.current = null;
    setAlarmingMedication(null);
  }, []);

  // triggerAlarm is intentionally a useCallback with a stable signature
  // (no deps) so it can be referenced by dismissAlarm and the polling
  // effect without causing re-subscriptions. It reads the latest
  // sound/notification/global-custom-sound state from refs.
  const triggerAlarm = useCallback((med: Medication, enqueueIfBusy: boolean) => {
    if (alarmingIdRef.current && alarmingIdRef.current !== med.id) {
      if (enqueueIfBusy && !queueRef.current.includes(med.id)) {
        queueRef.current.push(med.id);
      }
      return;
    }
    // #13: reset the test flag at the start of every alarm so a real
    // scheduled alarm (from the polling effect) doesn't inherit a stale
    // `true` from a previous test alarm. testAlarm sets it back to true
    // AFTER calling triggerAlarm (see below).
    isTestAlarmRef.current = false;
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
    if (soundEnabledRef.current) {
      // In-app chime plays the per-medication synthesized tone (so the
      // user can tell which med is due). The global custom sound, if
      // set, is attached to the push notification (background) below.
      // #18/#19: this is the SINGLE source of the in-app chime — the
      // DoseAlarmModal useEffect chime was removed (it played twice and
      // ignored soundEnabled).
      playNotificationSound(med.notificationSound || 'classic_chime');
    }
    if (notificationsEnabledRef.current) {
      sendMedicationDoseReminder(
        med.id,
        med.name,
        med.dailyDose,
        med.unit,
        // Use the dynamic balance so the dose-reminder body shows the
        // projected live inventory (not the stale stored snapshot).
        effectiveCurrentPills(med),
        med.reminderTime,
        // Global custom sound — applies to all medications, played by
        // the system when the notification fires in the background.
        globalCustomSoundRef.current
      );
    }
  }, []);

  const testAlarm = useCallback((med: Medication) => {
    triggerAlarm(med, false);
    // #13: set the test flag AFTER triggerAlarm (which resets it to
    // false at the start) so dismissAlarm knows NOT to write FIRED_KEY
    // for this alarm. Without this, testing an alarm earlier in the day
    // would mark the reminder as fired and block the real scheduled
    // reminder from firing later that day.
    isTestAlarmRef.current = true;
  }, [triggerAlarm]);

  useEffect(() => {
    const checkDue = () => {
      const now = getNowHHMM();
      const today = getTodayDateString();
      const nowMins = timeToMinutes(now);
      const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      const nowTs = Date.now();

      // #90: read from the ref so the interval doesn't need to be
      // recreated when the medications array reference changes.
      medicationsRef.current.forEach((med) => {
        if (!med.reminderEnabled || !med.reminderTime) return;
        if (alarmingIdRef.current === med.id) return;
        if (queueRef.current.includes(med.id)) return;

        const snoozeUntil = snooze[med.id];
        if (snoozeUntil && nowTs < snoozeUntil) return;

        if (snoozeUntil && nowTs >= snoozeUntil) {
          triggerAlarm(med, true);
          return;
        }

        const key = firedKey(med.id, today);
        if (fired[key]) return;

        const reminderMins = timeToMinutes(med.reminderTime);
        if (reminderMins < 0) return;
        if (nowMins >= reminderMins) {
          triggerAlarm(med, true);
        }
      });
    };

    // #24: do NOT poll before App has hydrated persisted state, or the
    // SEED medications (all reminderEnabled:true) would fire phantom
    // alarms for meds the user doesn't have. Once `hydrated` flips true
    // the effect re-runs and starts polling with the user's real meds.
    if (!hydrated) return;

    checkDue();
    // Poll every 5s (down from 15s) so a reminder scheduled for, say,
    // 09:00 fires within ~5s of the minute rather than up to ~15s late.
    // 5s is cheap (the check is pure, no network / no DOM), and a
    // 5-second granularity is imperceptible to the user while still
    // avoiding the perceived "the alarm was late" lag of 15s.
    const timer = window.setInterval(checkDue, 5000);
    return () => window.clearInterval(timer);
    // #90: gate on the stable reminderSignature instead of the raw
    // `medications` array ref. The interval is only torn down/recreated
    // when a med's reminder config actually changes, not on every App
    // state update (e.g. typing in a search field).
  }, [reminderSignature, triggerAlarm, hydrated]);

  return {
    alarmingMedication,
    dismissAlarm,
    snoozeAlarm,
    testAlarm,
  };
}
