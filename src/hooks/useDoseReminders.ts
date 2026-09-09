import { useCallback, useEffect, useRef, useState } from 'react';
import { Medication } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { playNotificationSound } from '../utils/sound';
import { sendMedicationDoseReminder } from '../utils/notifications';

const FIRED_KEY = 'android_med_tracker_fired_reminders_v1';
const SNOOZE_KEY = 'android_med_tracker_snooze_v1';

function getNowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return -1;
  return h * 60 + m;
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function firedKey(medId: string, dateStr: string) {
  return `${medId}:${dateStr}`;
}

interface UseDoseRemindersOptions {
  medications: Medication[];
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  globalCustomSound?: { fileName: string; mimeType: string; dataUrl: string } | null;
}

export function useDoseReminders({
  medications,
  soundEnabled,
  notificationsEnabled,
  globalCustomSound,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  const queueRef = useRef<string[]>([]);
  const alarmingIdRef = useRef<string | null>(null);

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

  const dismissAlarm = useCallback(() => {
    const current = alarmingIdRef.current;
    if (current) {
      const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
      fired[firedKey(current, getTodayDateString())] = true;
      saveJson(FIRED_KEY, fired);

      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      delete snooze[current];
      saveJson(SNOOZE_KEY, snooze);
    }
    alarmingIdRef.current = null;
    setAlarmingMedication(null);

    const nextId = queueRef.current.shift();
    if (nextId) {
      const next = medications.find((m) => m.id === nextId);
      if (next) {
        triggerAlarm(next, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medications]);

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
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
    if (soundEnabledRef.current) {
      // In-app chime plays the per-medication synthesized tone (so the
      // user can tell which med is due). The global custom sound, if
      // set, is attached to the push notification (background) below.
      playNotificationSound(med.notificationSound || 'classic_chime');
    }
    if (notificationsEnabledRef.current) {
      sendMedicationDoseReminder(
        med.id,
        med.name,
        med.dailyDose,
        med.unit,
        med.currentPills,
        med.reminderTime,
        // Global custom sound — applies to all medications, played by
        // the system when the notification fires in the background.
        globalCustomSoundRef.current
      );
    }
  }, []);

  const testAlarm = useCallback((med: Medication) => {
    triggerAlarm(med, false);
  }, [triggerAlarm]);

  useEffect(() => {
    const checkDue = () => {
      const now = getNowHHMM();
      const today = getTodayDateString();
      const nowMins = timeToMinutes(now);
      const fired = loadJson<Record<string, boolean>>(FIRED_KEY, {});
      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      const nowTs = Date.now();

      medications.forEach((med) => {
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

    checkDue();
    const timer = window.setInterval(checkDue, 15000);
    return () => window.clearInterval(timer);
  }, [medications, triggerAlarm]);

  return {
    alarmingMedication,
    dismissAlarm,
    snoozeAlarm,
    testAlarm,
  };
}
