import { Capacitor } from '@capacitor/core';

export type NativePlatform = 'android' | 'ios' | null;

export function getNativePlatform(): NativePlatform {
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

export function isAndroidPlatform(): boolean {
  return getNativePlatform() === 'android';
}

export function isIosPlatform(): boolean {
  return getNativePlatform() === 'ios';
}

export function isNativePlatform(): boolean {
  return getNativePlatform() !== null;
}
