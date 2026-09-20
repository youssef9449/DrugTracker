import { Capacitor, registerPlugin } from '@capacitor/core';

import {
  DOSE_REMINDER_CHANNEL_ID,
  DOSE_REMINDER_FOREGROUND_CHANNEL_ID,
  isAndroidNotificationRuntime,
} from './notificationRuntime';

interface DoseReminderPlugin {
  schedule(options: {
    medicationId: string;
    doseId: string;
    reminderTime: string;
    amount: number;
    medicationName: string;
    unit: string;
    autoDeductEnabled?: boolean;
    triggerAtEpochMs: number;
  }): Promise<{ ok: boolean; error?: string }>;
  cancel(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{
    ok: boolean;
    status?: 'SUCCESS' | 'ALREADY_ABSENT' | 'FAILED';
    error?: string;
  }>;
  scheduleSnooze(options: {
    medicationId: string;
    doseId: string;
    reminderTime?: string;
    amount: number;
    medicationName: string;
    unit: string;
    autoDeductEnabled?: boolean;
    triggerAtEpochMs: number;
  }): Promise<{ ok: boolean; error?: string }>;
  cancelSnooze(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{ ok: boolean }>;
  isScheduled(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{ scheduled: boolean; triggerAtEpochMs?: number }>;
  listScheduled(): Promise<{ keys: string[] }>;
}

const DoseReminder = registerPlugin<DoseReminderPlugin>('DoseReminder');

function isAndroid(): boolean {
  try {
    return (
      typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android'
    );
  } catch {
    return false;
  }
}

function nextOccurrence(
  reminderTime: string,
  skipToday: boolean
): Date | null {
  const [hour, minute] = reminderTime.split(':').map((value) =>
    Number.parseInt(value, 10)
  );
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const now = new Date();
  const fire = new Date(now);
  fire.setHours(hour, minute, 0, 0);
  if (skipToday || fire.getTime() <= now.getTime()) {
    fire.setDate(fire.getDate() + 1);
  }
  return fire;
}

export async function scheduleDoseReminderNative(
  medId: string,
  medName: string,
  reminderTime: string,
  doseAmount: number,
  unit: string,
  doseId: string,
  skipToday: boolean,
  autoDeductEnabled: boolean
): Promise<void> {
  if (!isAndroid()) return;

  const fire = nextOccurrence(reminderTime, skipToday);
  if (!fire || !(doseAmount > 0) || !doseId.trim()) return;

  const result = await DoseReminder.schedule({
    medicationId: medId,
    doseId: doseId.trim(),
    reminderTime,
    amount: Number(doseAmount),
    medicationName: medName,
    unit,
    autoDeductEnabled,
    triggerAtEpochMs: fire.getTime(),
  });
  if (!result?.ok) {
    throw new Error(result?.error || 'dose_reminder_schedule_failed');
  }
}

export async function cancelDoseReminderNative(
  medId: string,
  doseId: string
): Promise<void> {
  if (!isAndroid()) return;
  const result = await DoseReminder.cancel({
    medicationId: medId,
    doseId: doseId.trim(),
  });
  if (result?.ok !== true) {
    throw new Error(result?.error || 'dose_reminder_cancel_failed');
  }
}

export async function scheduleDoseSnoozeNative(
  medId: string,
  medName: string,
  doseAmount: number,
  unit: string,
  reminderTime: string | undefined,
  minutes: number,
  doseId: string,
  autoDeductEnabled: boolean
): Promise<void> {
  if (!isAndroid()) return;
  const result = await DoseReminder.scheduleSnooze({
    medicationId: medId,
    doseId: doseId.trim(),
    reminderTime,
    amount: Number(doseAmount),
    medicationName: medName,
    unit,
    autoDeductEnabled,
    triggerAtEpochMs: Date.now() + minutes * 60_000,
  });
  if (!result?.ok) {
    throw new Error(result?.error || 'dose_snooze_schedule_failed');
  }
}

export async function cancelDoseSnoozeNative(
  medId: string,
  doseId: string
): Promise<void> {
  if (!isAndroid()) return;
  const result = await DoseReminder.cancelSnooze({
    medicationId: medId,
    doseId: doseId.trim(),
  });
  if (result?.ok !== true) {
    throw new Error('dose_snooze_cancel_failed');
  }
}

export async function isDoseReminderScheduledNative(
  medId: string,
  doseId: string
): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    const result = await DoseReminder.isScheduled({
      medicationId: medId,
      doseId: doseId.trim(),
    });
    return (
      result?.scheduled === true &&
      (result.triggerAtEpochMs == null ||
        result.triggerAtEpochMs > Date.now() - 60_000)
    );
  } catch {
    return false;
  }
}

export async function listDoseReminderScheduledKeysNative(): Promise<string[]> {
  if (!isAndroid()) return [];
  try {
    const result = await DoseReminder.listScheduled();
    return Array.isArray(result?.keys) ? result.keys : [];
  } catch {
    return [];
  }
}

export async function cancelStaleDoseReminderAlarmsNative(
  keepKeys: ReadonlySet<string>
): Promise<void> {
  if (!isAndroid()) return;
  const scheduled = await listDoseReminderScheduledKeysNative();
  for (const key of scheduled) {
    if (!keepKeys.has(key)) {
      const separator = key.indexOf('::');
      if (separator <= 0) continue;
      const medId = key.slice(0, separator);
      const doseId = key.slice(separator + 2);
      await cancelDoseReminderNative(medId, doseId);
    }
  }
}
