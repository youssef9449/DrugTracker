import { scheduleCriticalAlarmNative, cancelCriticalAlarmNative, verifyCriticalAlarmPendingNative } from './criticalAlarmNative';
import { getNativePlatform, isNativePlatform } from './notifications/notificationPlatform';
import { areNotificationsEnabled, cancelNotification, getPendingNotification, scheduleNotification } from './notificationRuntime';
import { scheduleWebNotification } from './notifications/webNotifications';
import { classifyNativeError, type NativeErrorCode } from './nativeErrors';

export interface CriticalAlarmOperationResult {
  ok: boolean;
  error?: string;
  errorCode?: NativeErrorCode;
}

export interface CriticalAlarmVerifyResult {
  ok: true;
  pending: boolean;
}

export type CriticalAlarmVerifyOutcome =
  | CriticalAlarmVerifyResult
  | {
      ok: false;
      error: string;
      errorCode: NativeErrorCode;
    };

export async function cancelCriticalAlarm(
  medId: string
): Promise<CriticalAlarmOperationResult> {
  if (getNativePlatform() === 'android') {
    return cancelCriticalAlarmNative(medId);
  }
  if (!isNativePlatform()) {
    return { ok: false, error: 'unsupported_platform', errorCode: 'platform_failure' };
  }
  try {
    const ok = await cancelNotification('critical-stock', medId);
    return ok
      ? { ok: true }
      : { ok: false, error: 'critical_cancel_failed', errorCode: 'platform_failure' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'critical_cancel_failed';
    return { ok: false, error: message, errorCode: classifyNativeError(message) };
  }
}

function pendingAtMatchesAlarmTime(at: unknown, alarmTimeMs: number): boolean {
  if (typeof at === 'number') return at === alarmTimeMs;
  if (typeof at === 'string') {
    const parsed = new Date(at).getTime();
    return !Number.isNaN(parsed) && Math.abs(parsed - alarmTimeMs) <= 2000;
  }
  return false;
}

export async function verifyCriticalAlarmPending(
  medId: string,
  alarmTimeMs: number
): Promise<CriticalAlarmVerifyOutcome> {
  if (!isNativePlatform()) {
    return { ok: false, error: 'unsupported_platform', errorCode: 'platform_failure' };
  }

  try {
    const permission = await getNotificationPermissionResult();
    if (!permission.ok) return permission;
    if (!permission.enabled) {
      return { ok: false, error: 'notification_permission_denied', errorCode: 'permission_denied' };
    }

    if (getNativePlatform() === 'android') {
      const result = await verifyCriticalAlarmPendingNative(medId, alarmTimeMs);
      if (!result.ok) return result;
      return { ok: true, pending: result.pending };
    }

    const pending = await getPendingNotification('critical-stock', medId);
    return {
      ok: true,
      pending: !!pending && pendingAtMatchesAlarmTime(
        pending.schedule?.at,
        alarmTimeMs
      ),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'critical_verify_failed';
    return { ok: false, error: message, errorCode: classifyNativeError(message) };
  }
}

export async function scheduleCriticalAlarm(
  medId: string,
  medName: string,
  criticalDateMs: number,
  unit: string = 'قرص'
): Promise<CriticalAlarmOperationResult> {
  const fireAt = new Date(criticalDateMs);
  const title = `🚨 ${medName}: اقترب النفاد الحرج`;
  const body = `مخزون "${medName}" دخل مرحلة النفاد الحرج (${unit}). يرجى التعبئة فوراً!`;

  if (getNativePlatform() === 'android') {
    const permission = await getNotificationPermissionResult();
    if (!permission.ok) return permission;
    if (!permission.enabled) {
      return { ok: false, error: 'notification_permission_denied', errorCode: 'permission_denied' };
    }
    return scheduleCriticalAlarmNative(
      medId,
      medName,
      criticalDateMs,
      unit,
      title,
      body
    );
  }

  if (getNativePlatform() !== 'ios') {
    scheduleWebNotification(title, body);
    return { ok: false, error: 'unsupported_platform', errorCode: 'platform_failure' };
  }

  try {
    const scheduled = await scheduleNotification({
      namespace: 'critical-stock',
      identity: medId,
      title,
      body,
      channelId: 'low-stock',
      channelName: 'تنبيهات النفاذ',
      channelImportance: 4,
      channelVisibility: 1,
      smallIcon: 'ic_launcher',
      autoCancel: true,
      ongoing: false,
      at: fireAt,
      fallbackToWeb: false,
    });
    return scheduled
      ? { ok: true }
      : { ok: false, error: 'critical_schedule_failed', errorCode: 'platform_failure' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'critical_schedule_failed';
    console.warn('[notifications] iOS scheduleCriticalAlarm failed:', message);
    return { ok: false, error: message, errorCode: classifyNativeError(message) };
  }
}
