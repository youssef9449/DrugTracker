import { Capacitor } from '@capacitor/core';

export function isAndroidPlatform(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}
