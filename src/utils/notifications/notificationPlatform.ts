import {
  getNativePlatform,
  isNativePlatform,
  type NativePlatform,
} from '../platform';

export type NotificationNativePlatform = NativePlatform;

export { getNativePlatform, isNativePlatform };

export function isWebNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}
