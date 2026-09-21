import { SW_READY_TIMEOUT_MS } from '../time';
import { isWebNotificationSupported } from './notificationPlatform';

export async function scheduleWebNotification(
  title: string,
  body: string
): Promise<boolean> {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }
  const options: NotificationOptions = {
    body,
    icon: '/assets/icons/icon.svg',
  };

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<ServiceWorkerRegistration | null>((resolve) =>
          setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)
        ),
      ]);
      if (reg) {
        await reg.showNotification(title, options);
        return true;
      }
    } catch {
      // Fall through to the browser Notification API.
    }
  }

  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}

export function openBrowserNotificationSettings(): void {
  if (typeof window !== 'undefined') {
    try {
      const win = window.open(
        'chrome://settings/content/notifications',
        '_blank'
      );
      if (win) return;
    } catch {
      // Fall through to the browser-specific instructions below.
    }
  }

  const browserHint = (() => {
    if (typeof navigator === 'undefined') return 'متصفحك';
    const ua = navigator.userAgent;
    if (/Firefox/i.test(ua)) return 'Firefox';
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
    return 'متصفحك';
  })();

  window.alert(
    `لتفعيل الإشعارات على ${browserHint}:\\n\\n` +
      `1. افتح إعدادات ${browserHint}\\n` +
      `2. ابحث عن "إشعارات" أو "Notifications"\\n` +
      `3. ابحث عن اسم هذا الموقع في القائمة\\n` +
      `4. فعّل "السماح" وأعد تحميل الصفحة`
  );
}
