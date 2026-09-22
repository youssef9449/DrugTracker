import { App } from '@capacitor/app';
import { setAppInForeground } from './notifications/doseReminderNotifications';

type AppResumeHandler = ((isActive: boolean) => void) | null;

let appStateHandle: { remove: () => Promise<void> } | null = null;
let appResumeHandler: AppResumeHandler = null;

export function registerAppResumeHandler(handler: AppResumeHandler): void {
  appResumeHandler = handler;
}

export async function initAppStateListener(): Promise<void> {
  try {
    appStateHandle = await App.addListener('appStateChange', ({ isActive }) => {
      setAppInForeground(isActive);
      if (appResumeHandler) {
        try {
          appResumeHandler(isActive);
        } catch (err) {
          console.warn('[native] appResumeHandler failed:', err);
        }
      }
    });
  } catch (err) {
    console.warn('[native] appStateChange listener failed:', err);
  }
}

export async function cleanupAppStateListener(): Promise<void> {
  try {
    if (appStateHandle) await appStateHandle.remove();
  } catch (err) {
    console.warn('[native] appStateHandle.remove() failed:', err);
  }
  appStateHandle = null;
  appResumeHandler = null;
}
