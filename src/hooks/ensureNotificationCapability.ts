import {
  getNotificationPermission,
  requestNotificationPermission,
} from '../utils/notifications/notificationPermissions';

export type NotificationCapabilityResult =
  | { status: 'granted'; allowed: true }
  | { status: 'denied'; allowed: false }
  | { status: 'unsupported'; allowed: false }
  | { status: 'default'; allowed: false }
  | { status: 'error'; allowed: false; error: unknown };

/**
 * Shared notification capability check + optional request (#473).
 * Preference mutation stays with the caller.
 */
export async function ensureNotificationCapability(
  logLabel = 'notifications'
): Promise<NotificationCapabilityResult> {
  try {
    const currentPerm = await getNotificationPermission();
    if (currentPerm === 'granted') {
      return { status: 'granted', allowed: true };
    }
    if (currentPerm === 'unsupported') {
      return { status: 'unsupported', allowed: false };
    }
    if (currentPerm === 'denied') {
      return { status: 'denied', allowed: false };
    }
    if (currentPerm === 'default') {
      const granted = await requestNotificationPermission();
      return granted
        ? { status: 'granted', allowed: true }
        : { status: 'denied', allowed: false };
    }
    return { status: 'unsupported', allowed: false };
  } catch (error) {
    console.warn(
      `[ensureNotificationCapability] permission error (${logLabel}):`,
      error
    );
    return { status: 'error', allowed: false, error };
  }
}
