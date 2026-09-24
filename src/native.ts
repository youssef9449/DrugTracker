/**
 * Capacitor native bridge initialization.
 *
 * Safe to import in any environment: if the Capacitor runtime is not
 * installed, native initialization is skipped on the web platform.
 *
 * Lifecycle state for back-button, app-state, and notification listeners
 * lives in focused modules so each native concern owns its registration,
 * callback state, and cleanup independently.
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import {
  initBackButtonListener,
  cleanupBackButtonListener,
  registerBackButtonHandler,
} from './utils/nativeBackButton';
import {
  initAppStateListener,
  cleanupAppStateListener,
  registerAppResumeHandler,
} from './utils/nativeAppState';
import {
  initNotificationListeners,
  cleanupNotificationListeners,
  registerNotificationActionHandler,
  registerDoseReceivedHandler,
} from './utils/nativeNotificationListeners';

export {
  registerBackButtonHandler,
  registerAppResumeHandler,
  registerNotificationActionHandler,
  registerDoseReceivedHandler,
};

let initialized = false;

export async function initNativeBridge(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const platform = Capacitor.getPlatform();
  if (platform === 'web') return;

  try {
    await StatusBar.setBackgroundColor({ color: '#0f766e' });
    await StatusBar.setStyle({ style: Style.Light });
  } catch (err) {
    console.warn('[native] StatusBar setup failed:', err);
  }

  await initBackButtonListener();
  await initAppStateListener();
  await initNotificationListeners();
}

export async function cleanupNativeListeners(): Promise<void> {
  await cleanupBackButtonListener();
  await cleanupNotificationListeners();
  await cleanupAppStateListener();
  initialized = false;
}

export { openNativeAppSettings as openAppSettings } from './utils/nativeAppSettings';
