import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  NativeBoundaryError,
  classifyNativeError,
  toNativeBoundaryError,
  type NativeBoundaryFailure,
} from './nativeErrors';
import { getTodayDateString, tomorrowDateString, localEpochMs } from './dateCalculations';


interface DoseReminderPlugin {
  schedule(options: {
    medicationId: string;
    doseId: string;
    reminderTime: string;
    amount: number;
    medicationName: string;
    unit: string;
    doseDescription?: string;
    allowManualTakeAction?: boolean;
    triggerAtEpochMs: number;
    treatmentEndDate?: string;
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
    allowManualTakeAction?: boolean;
    triggerAtEpochMs: number;
    doseDescription?: string;
  }): Promise<{ ok: boolean; error?: string }>;
  cancelSnooze(options: {
    medicationId: string;
    doseId: string;
  }): Promise<{ ok: boolean; status?: string; error?: string }>;
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
  const today = getTodayDateString();
  const todayEpoch = localEpochMs(today, reminderTime);
  if (todayEpoch == null) return null;

  const now = new Date();
  const fireEpoch =
    !skipToday && todayEpoch > now.getTime()
      ? todayEpoch
      : localEpochMs(tomorrowDateString(today), reminderTime);

  return fireEpoch == null ? null : new Date(fireEpoch);
}

export async function scheduleDoseReminderNative(
  medId: string,
  medName: string,
  reminderTime: string,
  doseAmount: number,
  unit: string,
  doseId: string,
  skipToday: boolean,
  allowManualTakeAction: boolean = true,
  doseDescription?: string,
  treatmentEndDate?: string
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
    allowManualTakeAction,
    triggerAtEpochMs: fire.getTime(),
    doseDescription: doseDescription?.trim() || undefined,
    treatmentEndDate: treatmentEndDate?.trim() || undefined,
  });
  if (!result?.ok) {
    const message = result?.error || 'dose_reminder_schedule_failed';
    throw new NativeBoundaryError(classifyNativeError(message), message);
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
    const message = result?.error || 'dose_reminder_cancel_failed';
    throw new NativeBoundaryError(classifyNativeError(message), message);
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
  allowManualTakeAction: boolean = true,
  doseDescription?: string
): Promise<void> {
  if (!isAndroid()) return;
  const result = await DoseReminder.scheduleSnooze({
    medicationId: medId,
    doseId: doseId.trim(),
    reminderTime,
    amount: Number(doseAmount),
    medicationName: medName,
    unit,
    allowManualTakeAction,
    triggerAtEpochMs: Date.now() + minutes * 60_000,
    doseDescription: doseDescription?.trim() || undefined,
  });
  if (!result?.ok) {
    const message = result?.error || 'dose_snooze_schedule_failed';
    throw new NativeBoundaryError(classifyNativeError(message), message);
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
    const message =
      result?.error || 'dose_snooze_cancel_failed';
    throw new NativeBoundaryError(
      classifyNativeError(message),
      message
    );
  }
}

export type DoseReminderScheduledResult =
  | {
      ok: true;
      scheduled: boolean;
      triggerAtEpochMs?: number;
    }
  | NativeBoundaryFailure;

export type DoseReminderScheduledKeysResult =
  | { ok: true; keys: string[] }
  | NativeBoundaryFailure;

export async function isDoseReminderScheduledNative(
  medId: string,
  doseId: string
): Promise<DoseReminderScheduledResult> {
  if (!isAndroid()) return { ok: true, scheduled: false };
  try {
    const result = await DoseReminder.isScheduled({
      medicationId: medId,
      doseId: doseId.trim(),
    });
    if (!result || typeof result.scheduled !== 'boolean') {
      return {
        ok: false,
        error: 'dose_reminder_schedule_state_invalid',
        errorCode: 'platform_failure',
      };
    }
    const scheduled =
      result.scheduled === true &&
      (result.triggerAtEpochMs == null ||
        result.triggerAtEpochMs > Date.now() - 60_000);
    return {
      ok: true,
      scheduled,
      triggerAtEpochMs: result.triggerAtEpochMs,
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function listDoseReminderScheduledKeysNative(): Promise<DoseReminderScheduledKeysResult> {
  if (!isAndroid()) return { ok: true, keys: [] };
  try {
    const result = await DoseReminder.listScheduled();
    if (!Array.isArray(result?.keys)) {
      return {
        ok: false,
        error: 'dose_reminder_list_invalid',
        errorCode: 'platform_failure',
      };
    }
    return { ok: true, keys: result.keys };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export type CancelStaleDoseReminderResult =
  | { ok: true }
  | NativeBoundaryFailure;

export async function cancelStaleDoseReminderAlarmsNative(
  keepKeys: ReadonlySet<string>
): Promise<CancelStaleDoseReminderResult> {
  if (!isAndroid()) return { ok: true };
  const scheduledResult = await listDoseReminderScheduledKeysNative();
  if (!scheduledResult.ok) return scheduledResult;
  try {
    for (const key of scheduledResult.keys) {
      if (!keepKeys.has(key)) {
        const separator = key.indexOf('::');
        if (separator <= 0) continue;
        const medId = key.slice(0, separator);
        const doseId = key.slice(separator + 2);
        await cancelDoseReminderNative(medId, doseId);
      }
    }
    return { ok: true };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}
