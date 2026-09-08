import { useEffect, useRef, useState } from 'react';
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
}

export function useDoseReminders({
  medications,
  soundEnabled,
  notificationsEnabled,
}: UseDoseRemindersOptions) {
  const [alarmingMedication, setAlarmingMedication] = useState<Medication | null>(null);
  const queueRef = useRef<string[]>([]);
  const alarmingIdRef = useRef<string | null>(null);

  const dismissAlarm = () => {
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
  };

  const snoozeAlarm = (minutes: number = 10) => {
    const current = alarmingIdRef.current;
    if (current) {
      const snooze = loadJson<Record<string, number>>(SNOOZE_KEY, {});
      snooze[current] = Date.now() + minutes * 60 * 1000;
      saveJson(SNOOZE_KEY, snooze);
    }
    alarmingIdRef.current = null;
    setAlarmingMedication(null);
  };

  const triggerAlarm = (med: Medication, enqueueIfBusy: boolean) => {
    if (alarmingIdRef.current && alarmingIdRef.current !== med.id) {
      if (enqueueIfBusy && !queueRef.current.includes(med.id)) {
        queueRef.current.push(med.id);
      }
      return;
    }
    alarmingIdRef.current = med.id;
    setAlarmingMedication(med);
    if (soundEnabled) {
      playNotificationSound(med.notificationSound || 'classic_chime');
    }
    if (notificationsEnabled) {
      sendMedicationDoseReminder(
        med.name,
        med.dailyDose,
        med.unit,
        med.currentPills,
        med.reminderTime
      );
    }
  };

  const testAlarm = (med: Medication) => {
    triggerAlarm(med, false);
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medications, soundEnabled, notificationsEnabled]);

  return {
    alarmingMedication,
    dismissAlarm,
    snoozeAlarm,
    testAlarm,
  };
}
