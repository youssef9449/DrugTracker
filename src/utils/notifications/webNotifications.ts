import { isWebNotificationSupported } from './notificationPlatform';

/**
 * Web Notification scheduler.
 *
 * Lifecycle contract (#547): the durable localStorage record is the SINGLE
 * application-level authority for a scheduled Web notification. It is kept
 * until the occurrence is explicitly cancelled, superseded (replaced by a
 * different definition), delivered, or expired — never deleted merely
 * because the platform trigger was armed. Startup/reconciliation uses the
 * record to discover, reconcile, and cancel pending schedules after a page
 * reload.
 *
 * Reliability contract (#525): the durable Service-Worker TimestampTrigger
 * is preferred when the platform supports it. The page `setTimeout` fallback
 * is BEST-EFFORT delivery only — browsers may throttle, suspend, background,
 * or terminate the page, so it does NOT provide exact-time guarantees equal
 * to Android exact alarms. Reconciliation detects un-armed best-effort
 * schedules via the durable record and re-arms on lifecycle events.
 *
 * Read contract (#519): storage/read failures are preserved as explicit
 * failure outcomes — they are never collapsed into "no pending
 * notification". Reads are side-effect free (#495); arming is an explicit
 * operation controlled by the scheduler/reconciliation.
 */

const WEB_SCHEDULE_KEY = 'drugtracker_web_scheduled_notifications_v1';
/**
 * Upper bound for a single setTimeout delay. Browsers constrain timer delays
 * to the signed 32-bit range (~24.8 days); anything above overflows. The
 * fallback scheduler chains bounded intermediate wake-ups below this maximum
 * (#548). Centralized — do not scatter timer literals.
 */
export const MAX_WEB_TIMER_DELAY_MS = 2_000_000_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Definition (fireAt/title/body) each live page timer was armed for (#483).
 * Replacement of a same-identity schedule must be able to tell whether the
 * running timer already realizes the NEW definition; without this, an old
 * timer blocks re-arming and the replacement can be left with NO active
 * timer after the stale hop exits on its fireAt mismatch check.
 */
const armedDefinitions = new Map<string, WebScheduledEntry>();

type WebScheduledEntry = {
  namespace: string;
  identity: string;
  title: string;
  body: string;
  fireAt: number;
};

/** Explicit outcome of a durable Web schedule read (#519). */
export type WebScheduleReadOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'failed'; reason: string };

function storageKey(namespace: string, identity: string): string {
  return namespace + '::' + identity;
}

/** Failure-preserving durable record read (#519). Never mutates state. */
function readEntriesOutcome(): WebScheduleReadOutcome<Record<string, WebScheduledEntry>> {
  try {
    const raw = localStorage.getItem(WEB_SCHEDULE_KEY);
    if (raw == null) return { status: 'ok', value: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed', reason: 'web_schedule_shape_invalid' };
    }
    const entries: Record<string, WebScheduledEntry> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      const entry = value as Partial<WebScheduledEntry> | null;
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.namespace !== 'string' ||
        typeof entry.identity !== 'string' ||
        typeof entry.title !== 'string' ||
        typeof entry.body !== 'string' ||
        typeof entry.fireAt !== 'number' ||
        !Number.isFinite(entry.fireAt)
      ) {
        return { status: 'failed', reason: 'web_schedule_entry_invalid' };
      }
      entries[key] = {
        namespace: entry.namespace,
        identity: entry.identity,
        title: entry.title,
        body: entry.body,
        fireAt: entry.fireAt,
      };
    }
    return { status: 'ok', value: entries };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : 'web_schedule_read_failed',
    };
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

function supportsWebTimestampTrigger(): boolean {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  const Trigger = (globalThis as typeof globalThis & {
    TimestampTrigger?: new (timestamp: number) => unknown;
  }).TimestampTrigger;
  return typeof Trigger === 'function';
}

async function armPersistentNotification(entry: WebScheduledEntry): Promise<boolean> {
  if (!supportsWebTimestampTrigger()) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(entry.title, {
      body: entry.body,
      icon: '/assets/icons/icon.svg',
      tag: storageKey(entry.namespace, entry.identity),
      showTrigger: new (globalThis as typeof globalThis & {
        TimestampTrigger: new (timestamp: number) => unknown;
      }).TimestampTrigger(entry.fireAt),
    } as NotificationOptions & { showTrigger: unknown });
    return true;
  } catch {
    return false;
  }
}

/**
 * Invalidate the page timer for a key (#483). Clears BOTH the pending
 * timeout handle and the armed-definition marker so the old realization
 * can never be mistaken for an armed new one.
 */
function clearPageTimer(key: string): void {
  const existing = timers.get(key);
  if (existing !== undefined) {
    clearTimeout(existing);
    timers.delete(key);
  }
  armedDefinitions.delete(key);
}

/**
 * Arm the BEST-EFFORT page timer for an entry (#525). The delay is bounded
 * and chained (#548): every wake-up re-validates the durable record
 * (identity + fireAt unchanged — cancellation/replacement respected), then
 * either schedules the next bounded hop or performs the final delivery.
 *
 * Arming invalidates any previously-armed timer for the same identity
 * FIRST (#483) — even if that timer was already dequeued and is mid-hop —
 * so exactly one timer chain can ever be alive per logical identity.
 */
function armTimer(entry: WebScheduledEntry): void {
  const key = storageKey(entry.namespace, entry.identity);
  clearPageTimer(key);
  const fireAt = entry.fireAt;
  // Identity of THIS chain: the hop proceeds only while the timers map
  // still holds the handle it last scheduled. A replacement/ cancellation
  // that swaps the map entry (or a stale hop already dequeued when the
  // replacement happened) fails this check and exits without touching
  // state or delivering.
  let handle: ReturnType<typeof setTimeout> | undefined;
  const hop = (): void => {
    if (timers.get(key) !== handle) return;
    timers.delete(key);
    // Re-validate against the durable record on every hop: the occurrence
    // may have been cancelled or replaced while this timer waited.
    const read = readEntriesOutcome();
    if (read.status !== 'ok') {
      // Unknown state — never deliver from an untrusted snapshot (#519).
      return;
    }
    const current = read.value[key];
    if (!current || current.fireAt !== fireAt) return;
    const remaining = fireAt - Date.now();
    if (remaining > MAX_WEB_TIMER_DELAY_MS) {
      // Intermediate bounded wake-up; recompute the remaining duration.
      const timer = setTimeout(hop, MAX_WEB_TIMER_DELAY_MS);
      handle = timer;
      timers.set(key, timer);
      return;
    }
    if (remaining > 0) {
      const timer = setTimeout(hop, remaining);
      handle = timer;
      timers.set(key, timer);
      return;
    }
    // Due: delivery consumes the durable record (terminal state).
    const nextEntries = read.value;
    delete nextEntries[key];
    writeEntries(nextEntries);
    armedDefinitions.delete(key);
    void showScheduledNotification(current);
  };
  const initialDelay = Math.min(
    Math.max(0, fireAt - Date.now()),
    MAX_WEB_TIMER_DELAY_MS
  );
  handle = setTimeout(hop, initialDelay);
  timers.set(key, handle);
  armedDefinitions.set(key, { ...entry });
}

/**
 * Explicit arming operation (#495): reconciliation and scheduling control
 * WHEN an entry is armed; reads never do. Prefers the durable SW trigger;
 * falls back to the best-effort page timer when unavailable/failed.
 *
 * Same-identity replacement (#483): if a page timer is already running for
 * this identity, it is kept ONLY when it was armed for EXACTLY this
 * definition. Otherwise the stale timer is invalidated BEFORE the new
 * definition is armed, so the replaced realization can never deliver and
 * the new one always ends up armed (the old timer would otherwise wake,
 * observe a foreign fireAt, exit, and leave the replacement unarmed).
 */
async function ensureWebScheduledNotificationArmed(
  entry: WebScheduledEntry
): Promise<void> {
  const key = storageKey(entry.namespace, entry.identity);
  const armed = armedDefinitions.get(key);
  if (timers.has(key) && armed !== undefined) {
    const identical =
      armed.fireAt === entry.fireAt &&
      armed.title === entry.title &&
      armed.body === entry.body;
    if (identical) {
      // Best-effort timer already running for THIS definition; leave it
      // (it re-validates identity + fireAt on every hop).
      return;
    }
  }
  if (timers.has(key) || armedDefinitions.has(key)) {
    // #483: the durable definition was replaced (same identity, new
    // fireAt/title/body). Invalidate the old realization first — the old
    // timer must never deliver the replaced notification, and arming the
    // new definition must not be skipped just because a stale timer exists.
    clearPageTimer(key);
  }
  const persisted = await armPersistentNotification(entry);
  if (!persisted) {
    armTimer(entry);
  }
}

/**
 * Pure read of a scheduled Web notification (#495, #519): no timer arming,
 * no record mutation. Expired entries are surfaced as-is so reconciliation
 * can reach a terminal state for them.
 */
export function readWebScheduledNotification(
  namespace: string,
  identity: string
): WebScheduleReadOutcome<WebScheduledEntry | null> {
  const read = readEntriesOutcome();
  if (read.status !== 'ok') return read;
  const key = storageKey(namespace, identity);
  const entry = read.value[key] ?? null;
  return { status: 'ok', value: entry };
}

/**
 * Reconcile a durable record: delete past-due (delivered/missed) entries and
 * explicitly re-arm future best-effort/durable schedules. Event-driven —
 * invoked by scheduling and lifecycle reconciliation, never by reads.
 */
export function reconcileWebScheduledNotification(
  namespace: string,
  identity: string
): void {
  const read = readEntriesOutcome();
  if (read.status !== 'ok') {
    console.warn(
      `[web-notifications] schedule reconciliation skipped (${read.reason}).`
    );
    return;
  }
  const key = storageKey(namespace, identity);
  const entry = read.value[key];
  if (!entry) return;
  if (entry.fireAt <= Date.now()) {
    // Terminal state: the occurrence is past — delivered by the SW trigger,
    // missed by the best-effort timer, or stale. Remove the record.
    const nextEntries = read.value;
    delete nextEntries[key];
    writeEntries(nextEntries);
    return;
  }
  void ensureWebScheduledNotificationArmed(entry);
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

  const read = readEntriesOutcome();
  if (read.status !== 'ok') {
    // Storage unreadable: scheduling cannot be made durable or reconciled —
    // fail instead of pretending (#519).
    console.warn(`[web-notifications] schedule aborted (${read.reason}).`);
    return false;
  }
  const entries = read.value;
  const existing = entries[key];

  // #483: same-identity requests are only idempotent when the desired
  // definition is IDENTICAL. A changed fireAt/title/body must replace the
  // pending delivery instead of silently keeping stale content.
  if (existing && existing.fireAt > Date.now() + 1000) {
    const identical =
      existing.fireAt === fireAt &&
      existing.title === title &&
      existing.body === body;
    if (identical) {
      await ensureWebScheduledNotificationArmed(existing);
      return true;
    }
    const replaced: WebScheduledEntry = { namespace, identity, title, body, fireAt };
    entries[key] = replaced;
    if (!writeEntries(entries)) {
      return false;
    }
    await ensureWebScheduledNotificationArmed(replaced);
    return true;
  }

  const entry: WebScheduledEntry = {
    namespace,
    identity,
    title,
    body,
    fireAt,
  };

  if (fireAt <= Date.now()) {
    // Immediate delivery: no durable future record (terminal on delivery).
    return showScheduledNotification(entry);
  }

  entries[key] = entry;
  if (!writeEntries(entries)) {
    delete entries[key];
    return false;
  }

  await ensureWebScheduledNotificationArmed(entry);
  return true;
}

/**
 * Durable-record listing for Web-side stale reconciliation (#546): returns
 * the logical identities of all future-scheduled entries for a namespace.
 * Read-only.
 */
export function listWebScheduledNotificationIdentities(
  namespace: string
): string[] {
  const read = readEntriesOutcome();
  if (read.status !== 'ok') {
    console.warn(`[web-notifications] schedule listing skipped (${read.reason}).`);
    return [];
  }
  const prefix = namespace + '::';
  const identities: string[] = [];
  for (const [key, entry] of Object.entries(read.value)) {
    if (!key.startsWith(prefix)) continue;
    if (entry.fireAt <= Date.now()) continue;
    identities.push(key.slice(prefix.length));
  }
  return identities;
}

export async function cancelScheduledWebNotification(
  namespace: string,
  identity: string
): Promise<boolean> {
  const key = storageKey(namespace, identity);
  clearPageTimer(key);
  const read = readEntriesOutcome();
  let existed = false;
  let persisted = false;
  if (read.status === 'ok') {
    existed = Boolean(read.value[key]);
    delete read.value[key];
    persisted = writeEntries(read.value);
  } else {
    // Unknown durable state (#519): still perform the platform-level cancel,
    // but report failure so callers do not treat the state as trusted.
    console.warn(`[web-notifications] cancel proceeded with unreadable schedule (${read.reason}).`);
  }

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
  return read.status === 'ok' && persisted && existed;
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
