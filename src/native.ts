/**
 * Capacitor native bridge initialization.
 *
 * Safe to import in any environment: if the Capacitor runtime is not
 * installed (e.g., running as a plain web app in a browser, or in
 * AI Studio's preview before the user runs `npm install`), the
 * Capacitor.getPlatform() call gracefully returns 'web' and the
 * native plugins simply no-op.
 *
 * This file is imported by App.tsx on mount to:
 *   - Set the Android status bar color to match the teal theme.
 *   - Set the status bar style to LIGHT so the icons are visible
 *     on the dark teal background.
 *   - Listen for the Android hardware back button and exit the app
 *     (the SPA's bottom-nav is the primary navigation, so back
 *     button should not navigate the WebView history).
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';

let initialized = false;

export async function initNativeBridge(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const platform = Capacitor.getPlatform();
  if (platform === 'web') {
    // Running in a browser or AI Studio preview — no native bridge.
    return;
  }

  try {
    await StatusBar.setBackgroundColor({ color: '#0f766e' });
    await StatusBar.setStyle({ style: Style.Light });
  } catch (err) {
    console.warn('[native] StatusBar setup failed:', err);
  }

  try {
    App.addListener('backButton', () => {
      // Exit the app on back-button press — the SPA uses bottom-nav
      // for navigation, not a stack-based browser history.
      App.exitApp();
    });
  } catch (err) {
    console.warn('[native] backButton listener failed:', err);
  }
}
