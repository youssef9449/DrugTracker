import { LocalNotifications } from '@capacitor/local-notifications';
import { NOTIFICATION_IMMEDIATE_OFFSET_MS } from '../time';
import { postNativeNotification } from '../notificationRuntime';
import { isNativePlatform, getNativePlatform } from './notificationPlatform';
import { scheduleWebNotification } from './webNotifications';

export async function scheduleNotification(opts: {
  id: number;
  namespace?: string;
  identity?: string;
  title: string;
  body: string;
  channelId: string;
  smallIcon: string;
  /** Android notification-channel importance (1=min … 5=max), mirroring NotificationRuntime. */
  channelImportance?: 1 | 2 | 3 | 4 | 5;
  actionTypeId?: string;
  extra?: Record<string, unknown>;
}): Promise<boolean> {
  if (isNativePlatform()) {
    // Android presentation is owned by the repository Notification Runtime.
    // The numeric id remains only for the legacy iOS Local Notifications path;
    // Android identity is namespace + logical notification identity.
    if (getNativePlatform() === 'android') {
      const native = await postNativeNotification({
        namespace: opts.namespace || 'app-notification',
        identity: opts.identity || String(opts.id),
        title: opts.title,
        body: opts.body,
        channelId: opts.channelId,
        channelName: opts.channelId,
        channelImportance: opts.channelImportance ?? 4,
        channelVisibility: 1,
        smallIcon: opts.smallIcon,
      });
      return native;
    }

    try {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') {
        console.warn('[notifications] scheduleNotification skipped: permission not granted');
        return false;
      }

      await LocalNotifications.schedule({
        notifications: [
          {
            id: opts.id,
            title: opts.title,
            body: opts.body,
            schedule: {
              at: new Date(Date.now() + NOTIFICATION_IMMEDIATE_OFFSET_MS),
            },
            smallIcon: opts.smallIcon,
            channelId: opts.channelId,
            actionTypeId: opts.actionTypeId,
            ongoing: false,
            autoCancel: true,
            extra: {
              ...opts.extra,
            },
          },
        ],
      });
      return true;
    } catch (err) {
      console.warn('[notifications] Capacitor schedule failed:', err);
      return scheduleWebNotification(opts.title, opts.body);
    }
  }

  return scheduleWebNotification(opts.title, opts.body);
}

/**
 * Send a test notification immediately so the user can verify that
 * notifications work properly on their device. Uses the same channel
 * and native sound as real dose reminders.
 */
