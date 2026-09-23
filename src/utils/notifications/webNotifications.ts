import { isWebNotificationSupported } from './notificationPlatform';

const WEB_SCHEDULE_KEY = 'drugtracker_web_scheduled_notifications_v1';
const timers = new Map<string, ReturnType<typeof setTimeout>>();

type WebScheduledEntry = {
  namespace: string;
  identity: string;
  title: string;
  body: string;
  fireAt: number;
};

function storageKey(namespace: string, identity: string): string {
  return namespace + '::' + identity;
}

function readEntries(): Record<string, WebScheduledEntry> {
  try {
    const raw = localStorage.getItem(WEB_SCHEDULE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeEntries(entries: Record<string, WebScheduledEntry>): void {
  try {
    localStorage.setItem(WEB_SCHEDULE_KEY, JSON.stringify(entries));
  } catch {
    // Scheduling still works for the current page when storage is unavailable.
  }
}

async function showScheduledNotification(entry: WebScheduledEntry): Promise<boolean> {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') return false;
  const options: NotificationOptions = {
    body: entry.body,
    icon: '/assets/icons/icon.svg',
    tag: storageKey(entry.namespace, entry.identity),
  };
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(entry.title, options);
      return true;
    } catch {
      // Fall through to the page timer.
    }
  }
  try {
    new Notification(entry.title, options);
    return true;
  } catch {
    return false;
  }
}

function armTimer(entry: WebScheduledEntry): void {
  const key = storageKey(entry.namespace, entry.identity);
  const existing = timers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  const delay = Math.max(0, entry.fireAt - Date.now());
  const timer = setTimeout(() => {
    timers.delete(key);
    const entries = readEntries();
    const current = entries[key];
    if (!current || current.fireAt !== entry.fireAt) return;
    delete entries[key];
    writeEntries(entries);
    void showScheduledNotification(entry);
  }, delay);
  timers.set(key, timer);
}

export async function scheduleWebNotification(
  title: string,
  body: string,
  options?: {
    namespace?: string;
    identity?: string;
    at?: Date;
  }
): Promise<boolean> {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') {
    return false;
  }

  const namespace = options?.namespace ?? 'web';
  const identity = options?.identity ?? title + '::' + body;
  const fireAt = options?.at?.getTime() ?? Date.now();
  const key = storageKey(namespace, identity);
  const entries = readEntries();
  const existing = entries[key];

  if (existing && existing.fireAt > Date.now() + 1000) {
    armTimer(existing);
    return true;
  }

  const entry: WebScheduledEntry = {
    namespace,
    identity,
    title,
    body,
    fireAt,
  };

  entries[key] = entry;
  writeEntries(entries);

  if (fireAt <= Date.now()) {
    delete entries[key];
    writeEntries(entries);
    return showScheduledNotification(entry);
  }

  armTimer(entry);
  return true;
}

export function getWebScheduledNotification(
  namespace: string,
  identity: string
): WebScheduledEntry | null {
  const entries = readEntries();
  const key = storageKey(namespace, identity);
  const entry = entries[key];
  if (!entry) return null;
  if (entry.fireAt <= Date.now()) {
    delete entries[key];
    writeEntries(entries);
    return null;
  }
  armTimer(entry);
  return entry;
}

export async function cancelScheduledWebNotification(
  namespace: string,
  identity: string
): Promise<boolean> {
  const key = storageKey(namespace, identity);
  const timer = timers.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(key);
  }
  const entries = readEntries();
  const existed = Boolean(entries[key]);
  delete entries[key];
  writeEntries(entries);

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const notifications = await reg.getNotifications();
      for (const notification of notifications) {
        if (notification.tag === key) {
          notification.close();
        }
      }
    } catch {
      // No browser-level cancellation API is guaranteed.
    }
  }
  return existed;
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
