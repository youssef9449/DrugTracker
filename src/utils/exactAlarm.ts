import { Capacitor, registerPlugin } from '@capacitor/core';
import { classifyNativeError, toNativeBoundaryError, type NativeErrorCode } from './nativeErrors';

interface ExactAlarmRuntimePlugin {
  canScheduleExactAlarms(): Promise<{ granted: boolean }>;
  openSettings(): Promise<{ opened: boolean; error?: string }>;
}

const ExactAlarmRuntime = registerPlugin<ExactAlarmRuntimePlugin>(
  'ExactAlarmRuntime'
);

/**
 * Single application-wide exact-alarm permission contract.
 *
 * granted means Android exact alarms are currently usable.
 * denied means Android exact alarms are applicable but not allowed.
 * unsupported means this app/platform does not expose the Android
 * exact-alarm capability (for example web/iOS) or the native capability
 * check could not be completed reliably.
 */
export type ExactAlarmPermission =
  | 'granted'
  | 'denied'
  | 'unsupported';

function isAndroid(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

/**
 * The single source of truth for the application's exact-alarm capability.
 * Feature schedulers must consume this status instead of performing their
 * own Android exact-alarm checks.
 */
export async function getExactAlarmPermission(): Promise<ExactAlarmPermission> {
  if (!isAndroid()) return 'unsupported';
  try {
    const result = await ExactAlarmRuntime.canScheduleExactAlarms();
    return result?.granted === true ? 'granted' : 'denied';
  } catch (error) {
    console.warn('[exact-alarm] capability check failed:', error);
    // Android is an applicable exact-alarm platform; an indeterminate
    // capability check must therefore fail closed as denied, not become
    // unsupported/not-applicable.
    return 'denied';
  }
}

export interface ExactAlarmSettingsResult {
  ok: boolean;
  error?: string;
  errorCode?: NativeErrorCode;
}

export async function openExactAlarmSettings(): Promise<ExactAlarmSettingsResult> {
  if (!isAndroid()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const result = await ExactAlarmRuntime.openSettings();
    if (result?.opened === true) return { ok: true };
    const message = result?.error || 'open_settings_failed';
    return {
      ok: false,
      error: message,
      errorCode: classifyNativeError(message),
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    console.warn('[exact-alarm] openSettings failed:', boundaryError.message);
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function canScheduleExactAlarms(): Promise<boolean> {
  return (await getExactAlarmPermission()) === 'granted';
}
