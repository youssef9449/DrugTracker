import { App } from '@capacitor/app';

type BackPressHandler = (() => boolean) | null;

let backPressHandler: BackPressHandler = null;
let backPressHandle: { remove: () => Promise<void> } | null = null;

export function registerBackButtonHandler(handler: BackPressHandler): void {
  backPressHandler = handler;
}

export async function initBackButtonListener(): Promise<void> {
  try {
    backPressHandle = await App.addListener('backButton', () => {
      if (backPressHandler && backPressHandler()) return;
      App.exitApp();
    });
  } catch (err) {
    console.warn('[native] backButton listener failed:', err);
  }
}

export async function cleanupBackButtonListener(): Promise<void> {
  try {
    if (backPressHandle) await backPressHandle.remove();
  } catch (err) {
    console.warn('[native] backPressHandle.remove() failed:', err);
  }
  backPressHandle = null;
  backPressHandler = null;
}
