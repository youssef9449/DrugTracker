import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { isAndroidPlatform, isIosPlatform } from './platform';
import { LocalNotifications } from '@capacitor/local-notifications';
import {
  classifyNativeError,
  nativeFailureErrorCode,
  toNativeBoundaryError, type NativeBoundaryFailure } from './nativeErrors';

export interface NotificationRuntimePostOptions {
  namespace: string;
  identity: string;
  title: string;
  body: string;
  channelId: string;
  channelName: string;
  channelImportance: 1 | 2 | 3 | 4 | 5;
  channelVisibility?: number | undefined;
  smallIcon?: string | undefined;
  autoCancel?: boolean | undefined;
  ongoing?: boolean | undefined;
  /** Feature payload retained for platform notification delivery; never used as identity. */
  extra?: Record<string, unknown> | undefined;
  action?: {
    id: string;
    title: string;
    foreground?: boolean | undefined;
  } | undefined;
  /** iOS-only scheduled delivery time. Android timing belongs to ExactAlarmRuntime. */
  at?: Date | undefined;
  /** Preserve feature fallback behavior when an iOS schedule operation fails. */
  fallbackToWeb?: boolean | undefined;
}

interface NotificationRuntimePlugin {
  post(
    options: Omit<NotificationRuntimePostOptions, 'at' | 'fallbackToWeb'> & {
      actionId?: string | undefined;
      actionTitle?: string | undefined;
      actionForeground?: boolean | undefined;
    }
  ): Promise<{ ok: boolean; error?: string; code?: string }>;
  cancel(options: { namespace: string; identity: string }): Promise<{ ok: boolean; error?: string; code?: string }>;
  checkPermission(): Promise<{ enabled: boolean }>;
  checkChannel(options: { channelId: string }): Promise<{ enabled: boolean }>;
  ensureChannel(options: {
    channelId: string;
    channelName: string;
    channelImportance: number;
    channelVisibility?: number | undefined;
  }): Promise<{ ok: boolean; error?: string; code?: string }>;
  retryPersistedNotificationDeliveries(): Promise<{ retried: number }>;
  addListener(
    eventName: 'notificationReceived' | 'notificationActionPerformed',
    listener: (event: Record<string, unknown>) => void
  ): Promise<PluginListenerHandle>;
}

const NotificationRuntime = registerPlugin<NotificationRuntimePlugin>('NotificationRuntime');

/**
 * iOS LocalNotifications still requires a numeric platform handle.
 * The handle is resolved through a DURABLE collision-free mapping (#486):
 * logical namespace+identity keys are allocated sequential ids in the
 * platform-valid range (1..2147483646) from a persisted counter, so two
 * different active logical notifications can never resolve to the same
 * platform id. Mappings expire with their occurrence (past-due entries are
 * pruned before allocation) to bound storage; an exhausted range fails safe
 * (null → schedule refused) instead of colliding.
 */
const IOS_ID_MAP_KEY = 'drugtracker_ios_notification_id_map_v1';
const IOS_ID_MAX = 2147483646;

interface IosIdMapEntry {
  id: number;
  /** Epoch ms after which the mapping is no longer needed (occurrence due). */
  expireAt: number;
}

interface IosIdMap {
  nextId: number;
  byLogicalKey: Record<string, IosIdMapEntry>;
}

function readIosIdMap(): IosIdMap | null {
  try {
    const raw = localStorage.getItem(IOS_ID_MAP_KEY);
    if (raw == null) return { nextId: 1, byLogicalKey: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<IosIdMap>;
    if (
      typeof candidate.nextId !== 'number' ||
      !Number.isFinite(candidate.nextId) ||
      !candidate.byLogicalKey ||
      typeof candidate.byLogicalKey !== 'object'
    ) {
      return null;
    }
    return candidate as IosIdMap;
  } catch {
    return null;
  }
}

function writeIosIdMap(map: IosIdMap): boolean {
  try {
    localStorage.setItem(IOS_ID_MAP_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

function logicalIosKey(namespace: string, identity: string): string {
  return namespace + '\u001f' + identity;
}

/**
 * Resolve (or allocate) the platform id for a logical notification key.
 * Returns null when allocation is impossible (corrupt map, exhausted range)
 * — callers must fail the schedule instead of colliding.
 */
function resolveIosPlatformNotificationId(
  namespace: string,
  identity: string,
  fireAtEpochMs: number
): number | null {
  const key = logicalIosKey(namespace, identity);
  const map = readIosIdMap();
  if (map === null) {
    // Corrupt durable mapping: fail safe rather than reusing a possibly
    // live id (#486). A repair (clearing the key) is a user-visible action.
    return null;
  }
  const now = Date.now();
  // Expired mappings are pruned to bound storage; expired occurrences can no
  // longer be cancelled meaningfully.
  for (const [logicalKey, entry] of Object.entries(map.byLogicalKey)) {
    if (entry.expireAt <= now) delete map.byLogicalKey[logicalKey];
  }
  const existing = map.byLogicalKey[key];
  if (existing) {
    existing.expireAt = Math.max(existing.expireAt, fireAtEpochMs + 60_000);
    writeIosIdMap(map);
    return existing.id;
  }
  if (map.nextId > IOS_ID_MAX) {
    return null;
  }
  const allocated = map.nextId;
  map.nextId = allocated + 1;
  map.byLogicalKey[key] = { id: allocated, expireAt: fireAtEpochMs + 60_000 };
  if (!writeIosIdMap(map)) {
    // Mapping persistence failed: the id may be re-allocated on the next
    // attempt after a reload — refuse now instead of colliding.
    return null;
  }
  return allocated;
}

/**
 * Look up an EXISTING platform id for cancellation/pending lookups without
 * allocating. Returns null when no durable mapping exists (nothing was
 * scheduled for this logical key from this runtime).
 */
function lookupIosPlatformNotificationId(
  namespace: string,
  identity: string
): number | null {
  const map = readIosIdMap();
  if (map === null) return null;
  return map.byLogicalKey[logicalIosKey(namespace, identity)]?.id ?? null;
}

export function isAndroidNotificationRuntime(): boolean {
  return isAndroidPlatform();
}

export async function scheduleNotification(
  options: NotificationRuntimePostOptions
): Promise<boolean> {
  if (isAndroidNotificationRuntime()) return (await postNativeNotification(options)).ok;
  if (isIosPlatform()) {
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') return false;
      const platformId = resolveIosPlatformNotificationId(
        options.namespace,
        options.identity,
        (options.at ?? new Date(Date.now() + 500)).getTime()
      );
      if (platformId === null) {
        // Collision-safe ID allocation failed — refuse to schedule rather
        // than risk one logical notification overwriting another (#486).
        console.warn('[notification-runtime] iOS platform ID allocation failed');
        return false;
      }
      const notification = {
        id: platformId,
        title: options.title,
        body: options.body,
        schedule: {
          at: options.at ?? new Date(Date.now() + 500),
          allowWhileIdle: true,
        },
        channelId: options.channelId,
        ongoing: options.ongoing ?? false,
        autoCancel: options.autoCancel ?? true,
        extra: {
          namespace: options.namespace,
          identity: options.identity,
        },
        ...(options.smallIcon !== undefined ? { smallIcon: options.smallIcon } : {}),
        ...(options.action?.id !== undefined ? { actionTypeId: options.action.id } : {}),
      };

      await LocalNotifications.schedule({
        notifications: [notification],
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
    const errorCode = nativeFailureErrorCode(result, 'notification_post_failed');
    return {
      ok: false,
      error: message,
      errorCode,
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
    const errorCode = nativeFailureErrorCode(result, 'notification_cancel_failed');
    return {
      ok: false,
      error: message,
      errorCode,
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
  if (isIosPlatform()) {
    try {
      const platformId = lookupIosPlatformNotificationId(namespace, identity);
      if (platformId === null) {
        // No durable mapping → nothing was scheduled for this logical key.
        // Cancellation is an idempotent no-op.
        return true;
      }
      await LocalNotifications.cancel({
        notifications: [{ id: platformId }],
      });
      return true;
    } catch (error) {
      console.warn('[notification-runtime] iOS cancel failed:', error);
      return false;
    }
  }
  if (!isIosPlatform()) {
    const { cancelScheduledWebNotification } = await import('./notifications/webNotifications');
    return cancelScheduledWebNotification(namespace, identity);
  }
  return false;
}

export type NotificationPendingResult =
  | { ok: true; pending: { schedule?: { at?: unknown } | undefined } | null }
  | NativeBoundaryFailure;

export async function getPendingNotificationResult(
  namespace: string,
  identity: string
): Promise<NotificationPendingResult> {
  if (!isIosPlatform()) {
    // #519/#495: pure, failure-preserving Web read. Storage failure is
    // surfaced as an explicit boundary failure — never as "no pending".
    const { readWebScheduledNotification, reconcileWebScheduledNotification } =
      await import('./notifications/webNotifications');
    const read = readWebScheduledNotification(namespace, identity);
    if (read.status !== 'ok') {
      console.warn(`[notification-runtime] web pending lookup failed: ${read.reason}`);
      return {
        ok: false,
        error: read.reason,
        errorCode: classifyNativeError(read.reason, 'platform_failure'),
      };
    }
    const entry = read.value;
    if (!entry) return { ok: true, pending: null };
    if (entry.fireAt <= Date.now()) {
      // Terminal state for a past-due record; reconciliation owns cleanup.
      reconcileWebScheduledNotification(namespace, identity);
      return { ok: true, pending: null };
    }
    return { ok: true, pending: { schedule: { at: entry.fireAt } } };
  }
  try {
    const pending = await LocalNotifications.getPending();
    const platformId = lookupIosPlatformNotificationId(namespace, identity);
    if (platformId === null) return { ok: true, pending: null };
    const entry = pending.notifications.find((notification) => notification.id === platformId);
    if (!entry) return { ok: true, pending: null };
    const schedule = entry.schedule;
    return {
      ok: true,
      pending: schedule === undefined ? {} : { schedule },
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

export async function retryPersistedNotificationDeliveries(): Promise<number> {
  if (!isAndroidNotificationRuntime()) return 0;
  try {
    const result = await NotificationRuntime.retryPersistedNotificationDeliveries();
    return Number.isFinite(result?.retried) ? result.retried : 0;
  } catch (error) {
    console.warn('[notification-runtime] persisted delivery retry failed:', error);
    return 0;
  }
}

/**
 * Tri-state notification-channel capability (#482).
 *
 * `enabled` / `disabled` reflect the real OS channel state; `unknown` means
 * the capability check itself failed (transient native/plugin error) and
 * MUST NOT be interpreted as a user decision. Consumers never flip a
 * persisted preference based on `unknown`.
 */
export type NotificationChannelState = 'enabled' | 'disabled' | 'unknown';

export async function getNotificationChannelState(
  channelId: string
): Promise<NotificationChannelState> {
  if (!isAndroidNotificationRuntime()) return 'enabled';
  try {
    const result = await NotificationRuntime.checkChannel({ channelId });
    if (!result || typeof result.enabled !== 'boolean') {
      return 'unknown';
    }
    return result.enabled ? 'enabled' : 'disabled';
  } catch (error) {
    console.warn('[notification-runtime] channel capability check failed:', error);
    return 'unknown';
  }
}

/**
 * Channel bootstrap without posting (#503): startup creates the channels a
 * feature requires BEFORE channel existence is evaluated as a capability
 * gate, so a clean install cannot disable a valid preference merely because
 * the channels were never created. Notification Runtime owns creation;
 * callers supply their own feature-owned channel descriptors.
 */
export async function ensureNotificationChannel(options: {
  channelId: string;
  channelName: string;
  channelImportance: 1 | 2 | 3 | 4 | 5;
  channelVisibility?: number | undefined;
}): Promise<boolean> {
  if (!isAndroidNotificationRuntime()) return true;
  try {
    const result = await NotificationRuntime.ensureChannel(options);
    return result?.ok === true;
  } catch (error) {
    console.warn('[notification-runtime] channel bootstrap failed:', error);
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
  if (isIosPlatform()) {
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
