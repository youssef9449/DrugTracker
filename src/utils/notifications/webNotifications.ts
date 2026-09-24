import { isWebNotificationSupported } from './notificationPlatform';

const WEB_SCHEDULE_KEY = 'drugtracker_web_scheduled_notifications_v1';
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const persistentTriggerOperations = new Map<string, Promise<boolean>>();

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

function writeEntries(entries: Record<string, WebScheduledEntry>): boolean {
  try {
    localStorage.setItem(WEB_SCHEDULE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
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

async function armPersistentNotification(entry: WebScheduledEntry): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  const Trigger = (globalThis as typeof globalThis & {
    TimestampTrigger?: new (timestamp: number) => unknown;
  }).TimestampTrigger;
  if (typeof Trigger !== 'function') return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(entry.title, {
      body: entry.body,
      icon: '/assets/icons/icon.svg',
      tag: storageKey(entry.namespace, entry.identity),
      showTrigger: new Trigger(entry.fireAt),
    } as NotificationOptions & { showTrigger: unknown });
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
    const operation = armPersistentNotification(existing);
    persistentTriggerOperations.set(key, operation);
    void operation.then((persisted) => {
      if (!persisted) armTimer(existing);
      if (persistentTriggerOperations.get(key) === operation) {
        persistentTriggerOperations.delete(key);
      }
    });
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
  if (!writeEntries(entries)) {
    delete entries[key];
    return false;
  }

  if (fireAt <= Date.now()) {
    delete entries[key];
    if (!writeEntries(entries)) {
      return false;
    }
    return showScheduledNotification(entry);
  }

  const operation = armPersistentNotification(entry);
  persistentTriggerOperations.set(key, operation);
  void operation.then((persisted) => {
    if (persisted) {
      const current = readEntries()[key];
      if (current?.fireAt === entry.fireAt) {
        const entries = readEntries();
        delete entries[key];
        writeEntries(entries);
      }
      const timer = timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(key);
      }
    } else {
      armTimer(entry);
    }
    if (persistentTriggerOperations.get(key) === operation) {
      persistentTriggerOperations.delete(key);
    }
  });
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
  const pendingTrigger = persistentTriggerOperations.get(key);
  if (pendingTrigger) await pendingTrigger;

  const entries = readEntries();
  const existed = Boolean(entries[key]);
  delete entries[key];
  const persisted = writeEntries(entries);

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
  return persisted && existed;
}

function isChromiumNotificationSettingsSupported(): boolean {
  if (typeof navigator === 'undefined') return false;

  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: {
        brands?: ReadonlyArray<{ brand: string; version: string }>;
      };
    }
  ).userAgentData;

  if (userAgentData?.brands?.length) {
    const brands = userAgentData.brands.map(({ brand }) => brand);
    const isKnownAlternateChromium =
      brands.some((brand) =>
        /Microsoft Edge|Opera|Brave|Vivaldi|Samsung Browser/i.test(brand)
      );
    return (
      brands.some((brand) => /Chromium|Google Chrome/i.test(brand)) &&
      !isKnownAlternateChromium &&
      !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    );
  }

  // There is no standard API that probes browser-internal settings URLs.
  // Keep the fallback narrowly scoped to known Chromium signatures and
  // never send Firefox/Safari/unknown browsers to a chrome:// URL.
  const ua = navigator.userAgent;
  return (
    !/Android|iPhone|iPad|iPod/i.test(ua) &&
    /Chrome|Chromium/i.test(ua) &&
    !/Firefox|FxiOS|Safari\//i.test(ua) &&
    !/Edg\//i.test(ua) &&
    !/OPR\//i.test(ua) &&
    !/Brave\//i.test(ua) &&
    !/Vivaldi\//i.test(ua) &&
    !/SamsungBrowser\//i.test(ua)
  );
}

function getBrowserHint(): string {
  if (typeof navigator === 'undefined') return 'متصفحك';
  const ua = navigator.userAgent;
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  return 'متصفحك';
}

export function openBrowserNotificationSettings(): void {
  if (typeof window === 'undefined') return;
  if (
    isChromiumNotificationSettingsSupported()
  ) {
    try {
      const win = window.open(
        'chrome://settings/content/notifications',
        '_blank'
      );
      if (win) return;
    } catch {
      // Fall through to generic browser instructions.
    }
  }

  const browserHint = getBrowserHint();

  window.alert(
    `لتفعيل الإشعارات على ${browserHint}:\\n\\n` +
      `1. افتح إعدادات ${browserHint}\\n` +
      `2. ابحث عن "إشعارات" أو "Notifications"\\n` +
      `3. ابحث عن اسم هذا الموقع في القائمة\\n` +
      `4. فعّل "السماح" وأعد تحميل الصفحة`
  );
}
