import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { classifyNativeError, toNativeBoundaryError, type NativeBoundaryFailure } from './nativeErrors';

export interface NotificationRuntimePostOptions {
  namespace: string;
  identity: string;
  title: string;
  body: string;
  channelId: string;
  channelName: string;
  channelImportance: 1 | 2 | 3 | 4 | 5;
  channelVisibility?: number;
  smallIcon?: string;
  autoCancel?: boolean;
  ongoing?: boolean;
  /** Feature payload retained for platform notification delivery; never used as identity. */
  extra?: Record<string, unknown>;
  action?: {
    id: string;
    title: string;
    foreground?: boolean;
  };
  /** iOS-only scheduled delivery time. Android timing belongs to ExactAlarmRuntime. */
  at?: Date;
  /** Preserve feature fallback behavior when an iOS schedule operation fails. */
  fallbackToWeb?: boolean;
}

interface NotificationRuntimePlugin {
  post(
    options: Omit<NotificationRuntimePostOptions, 'at' | 'fallbackToWeb'> & {
      actionId?: string;
      actionTitle?: string;
      actionForeground?: boolean;
    }
  ): Promise<{ ok: boolean; error?: string }>;
  cancel(options: { namespace: string; identity: string }): Promise<{ ok: boolean; error?: string }>;
  checkPermission(): Promise<{ enabled: boolean }>;
  checkChannel(options: { channelId: string }): Promise<{ enabled: boolean }>;
  addListener(
    eventName: 'notificationReceived' | 'notificationActionPerformed',
    listener: (event: Record<string, unknown>) => void
  ): Promise<PluginListenerHandle>;
}

const NotificationRuntime = registerPlugin<NotificationRuntimePlugin>('NotificationRuntime');

function isIOS(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'ios';
  } catch {
    return false;
  }
}

/**
 * iOS LocalNotifications still requires a numeric platform handle.
 * The handle is an implementation detail derived from the full logical
 * namespace + identity. It is not a feature identity, category registry,
 * numeric range allocator, collision registry, or collision-probing state.
 */
function iosPlatformNotificationId(namespace: string, identity: string): number {
  const value = namespace + '\u001f' + identity;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2147483646 + 1;
}

export function isAndroidNotificationRuntime(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export async function scheduleNotification(
  options: NotificationRuntimePostOptions
): Promise<boolean> {
  if (isAndroidNotificationRuntime()) return (await postNativeNotification(options)).ok;
  if (isIOS()) {
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') return false;
      await LocalNotifications.schedule({
        notifications: [{
          id: iosPlatformNotificationId(options.namespace, options.identity),
          title: options.title,
          body: options.body,
          schedule: {
            at: options.at ?? new Date(Date.now() + 500),
            allowWhileIdle: true,
          },
          smallIcon: options.smallIcon,
          channelId: options.channelId,
          actionTypeId: options.action?.id,
          ongoing: options.ongoing ?? false,
          autoCancel: options.autoCancel ?? true,
          extra: {
            namespace: options.namespace,
            identity: options.identity,
          },
        }],
      });
      return true;
    } catch (err) {
      console.warn('[notification-runtime] iOS schedule failed:', err);
      if (options.fallbackToWeb === false) return false;
      const { scheduleWebNotification } = await import('./notifications/webNotifications');
      return scheduleWebNotification(options.title, options.body);
    }
  }
  if (options.fallbackToWeb === false) return false;
  const { scheduleWebNotification } = await import('./notifications/webNotifications');
  return scheduleWebNotification(options.title, options.body);
}

export async function postNativeNotification(
  options: NotificationRuntimePostOptions
): Promise<{ ok: true } | NativeBoundaryFailure> {
  if (!isAndroidNotificationRuntime()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const { action, ...base } = options;
    delete base.at;
    delete base.fallbackToWeb;
    delete base.extra;
    const result = await NotificationRuntime.post({
      ...base,
      ...(action ? {
        actionId: action.id,
        actionTitle: action.title,
        actionForeground: action.foreground === true,
      } : {}),
    });
    if (result?.ok === true) return { ok: true };
    const message = result?.error || 'notification_post_failed';
    return {
      ok: false,
      error: message,
      errorCode: classifyNativeError(message),
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    console.warn('[notification-runtime] post failed:', boundaryError.message);
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function cancelNativeNotification(
  namespace: string,
  identity: string
): Promise<{ ok: true } | NativeBoundaryFailure> {
  if (!isAndroidNotificationRuntime()) {
    return { ok: false, error: 'not_android', errorCode: 'not_android' };
  }
  try {
    const result = await NotificationRuntime.cancel({ namespace, identity });
    if (result?.ok === true) return { ok: true };
    const message = result?.error || 'notification_cancel_failed';
    return {
      ok: false,
      error: message,
      errorCode: classifyNativeError(message),
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    console.warn('[notification-runtime] cancel failed:', boundaryError.message);
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function cancelNotification(
  namespace: string,
  identity: string
): Promise<boolean> {
  if (isAndroidNotificationRuntime()) return (await cancelNativeNotification(namespace, identity)).ok;
  if (isIOS()) {
    try {
      await LocalNotifications.cancel({
        notifications: [{ id: iosPlatformNotificationId(namespace, identity) }],
      });
      return true;
    } catch (error) {
      console.warn('[notification-runtime] iOS cancel failed:', error);
      return false;
    }
  }
  return false;
}

export type NotificationPendingResult =
  | { ok: true; pending: { schedule?: { at?: unknown } } | null }
  | NativeBoundaryFailure;

export async function getPendingNotificationResult(
  namespace: string,
  identity: string
): Promise<NotificationPendingResult> {
  if (!isIOS()) {
    return { ok: true, pending: null };
  }
  try {
    const pending = await LocalNotifications.getPending();
    const id = iosPlatformNotificationId(namespace, identity);
    const entry = pending.notifications.find((notification) => notification.id === id);
    if (!entry) return { ok: true, pending: null };
    return {
      ok: true,
      pending: { schedule: entry.schedule as { at?: unknown } | undefined },
    };
  } catch (error) {
    const boundaryError = toNativeBoundaryError(error, 'platform_failure');
    console.warn('[notification-runtime] iOS pending lookup failed:', boundaryError.message);
    return {
      ok: false,
      error: boundaryError.message,
      errorCode: boundaryError.code,
    };
  }
}

export async function isNotificationChannelEnabled(channelId: string): Promise<boolean> {
  if (!isAndroidNotificationRuntime()) return true;
  try {
    const result = await NotificationRuntime.checkChannel({ channelId });
    return result?.enabled === true;
  } catch (error) {
    console.warn('[notification-runtime] channel capability check failed:', error);
    return false;
  }
}

export type NotificationPermissionResult =
  | { ok: true; enabled: boolean }
  | NativeBoundaryFailure;

export async function getNotificationPermissionResult(): Promise<NotificationPermissionResult> {
  if (isAndroidNotificationRuntime()) {
    try {
      const result = await NotificationRuntime.checkPermission();
      if (!result || typeof result.enabled !== 'boolean') {
        return {
          ok: false,
          error: 'notification_permission_state_invalid',
          errorCode: 'platform_failure',
        };
      }
      return { ok: true, enabled: result.enabled };
    } catch (error) {
      const boundaryError = toNativeBoundaryError(error, 'platform_failure');
      return {
        ok: false,
        error: boundaryError.message,
        errorCode: boundaryError.code,
      };
    }
  }
  if (isIOS()) {
    try {
      const result = await LocalNotifications.checkPermissions();
      return { ok: true, enabled: result.display === 'granted' };
    } catch (error) {
      const boundaryError = toNativeBoundaryError(error, 'platform_failure');
      return {
        ok: false,
        error: boundaryError.message,
        errorCode: boundaryError.code,
      };
    }
  }
  return { ok: true, enabled: false };
}

export function addNotificationReceivedListener(
  listener: (event: Record<string, unknown>) => void
): Promise<PluginListenerHandle | null> {
  if (!isAndroidNotificationRuntime()) return Promise.resolve(null);
  return NotificationRuntime.addListener('notificationReceived', listener);
}

export function addNotificationActionPerformedListener(
  listener: (event: Record<string, unknown>) => void
): Promise<PluginListenerHandle | null> {
  if (!isAndroidNotificationRuntime()) return Promise.resolve(null);
  return NotificationRuntime.addListener('notificationActionPerformed', listener);
}
