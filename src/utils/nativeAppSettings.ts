import { App, type AppPlugin } from '@capacitor/app';

interface NativeAppSettingsPlugin extends AppPlugin {
  openAppSettings?: () => Promise<void>;
}

const nativeApp = App as unknown as NativeAppSettingsPlugin;

/**
 * Open the platform app-settings screen when the installed App plugin
 * exposes the native capability. The type escape is intentionally kept
 * inside this adapter because Capacitor 6 does not declare the method.
 */
export async function openNativeAppSettings(): Promise<boolean> {
  if (typeof nativeApp.openAppSettings !== 'function') return false;

  try {
    await nativeApp.openAppSettings();
    return true;
  } catch (error) {
    console.warn('[native-app-settings] openAppSettings failed:', error);
    return false;
  }
}
