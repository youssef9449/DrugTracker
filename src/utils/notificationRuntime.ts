import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export const DOSE_REMINDER_CHANNEL_ID = 'dose-reminder-v3';
export const DOSE_REMINDER_FOREGROUND_CHANNEL_ID =
  'dose-reminder-foreground-v1';
export const LOW_STOCK_CHANNEL_ID = 'low-stock';

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
  action?: {
    id: string;
    title: string;
    foreground?: boolean;
  };
}

interface NotificationRuntimePlugin {
  post(options: NotificationRuntimePostOptions): Promise<{
    ok: boolean;
    error?: string;
  }>;
  cancel(options: {
    namespace: string;
    identity: string;
  }): Promise<{ ok: boolean }>;
  checkPermission(): Promise<{ enabled: boolean }>;
  addListener(
    eventName: 'notificationReceived' | 'notificationActionPerformed',
    listener: (event: Record<string, unknown>) => void
  ): Promise<PluginListenerHandle>;
}

const NotificationRuntime = registerPlugin<NotificationRuntimePlugin>(
  'NotificationRuntime'
);

export function isAndroidNotificationRuntime(): boolean {
  try {
    return (
      typeof Capacitor !== 'undefined' &&
      Capacitor.getPlatform() === 'android'
    );
  } catch {
    return false;
  }
}

export async function postNativeNotification(
  options: NotificationRuntimePostOptions
): Promise<boolean> {
  if (!isAndroidNotificationRuntime()) return false;
  try {
    const result = await NotificationRuntime.post(options);
    return result?.ok === true;
  } catch (error) {
    console.warn('[notification-runtime] post failed:', error);
    return false;
  }
}

export async function cancelNativeNotification(
  namespace: string,
  identity: string
): Promise<boolean> {
  if (!isAndroidNotificationRuntime()) return false;
  try {
    const result = await NotificationRuntime.cancel({
      namespace,
      identity,
    });
    return result?.ok === true;
  } catch (error) {
    console.warn('[notification-runtime] cancel failed:', error);
    return false;
  }
}

export async function areNativeNotificationsEnabled(): Promise<boolean> {
  if (!isAndroidNotificationRuntime()) return false;
  try {
    const result = await NotificationRuntime.checkPermission();
    return result?.enabled === true;
  } catch {
    return false;
  }
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
  return NotificationRuntime.addListener(
    'notificationActionPerformed',
    listener
  );
}
