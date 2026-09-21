import { Capacitor } from '@capacitor/core';

export type NotificationNativePlatform = 'android' | 'ios' | null;

export function getNativePlatform(): NotificationNativePlatform {
  try {
    if (typeof Capacitor === 'undefined') return null;
    const platform = Capacitor.getPlatform();
    if (platform === 'android') return 'android';
    if (platform === 'ios') return 'ios';
    return null;
  } catch {
    return null;
  }
}

export function isNativePlatform(): boolean {
  return getNativePlatform() !== null;
}

export function isWebNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}
