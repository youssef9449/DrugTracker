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
 *   - Create the Android notification channel(s) used by
 *     @capacitor/local-notifications so notifications actually fire
 *     when the app is in the foreground (otherwise Android silently
 *     drops them if no channel is configured).
 */

import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';

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

  // ─────────────────────────────────────────────────────────────
  // Create notification channels (Android 8.0+ requirement)
  // ─────────────────────────────────────────────────────────────
  // Without an Android NotificationChannel, scheduled notifications
  // silently fail on Android 8.0+. Capacitor LocalNotifications
  // creates a default channel automatically, but the notification
  // channel id used in `schedule({ channelId: 'dose-reminder' })`
  // must be created first or Android will fall back to the default
  // channel (which is acceptable but means we lose the ability to
  // later customize per-channel importance / sound / vibration).
  //
  // We also need to create a separate channel for the "low-stock"
  // alerts so the user can mute them independently from the dose
  // reminders.
  //
  // On iOS this is a no-op (iOS doesn't have channels — it uses the
  // notification's category identifier for grouping instead).
  try {
    // The TypeScript defs for @capacitor/local-notifications 6.x
    // don't include createChannel — it's only on the Android plugin
    // side. Use a cast to access the runtime method.
    const ChannelExt = LocalNotifications as unknown as {
      createChannel: (channel: {
        id: string;
        name: string;
        description?: string;
        importance: number;
        visibility: number;
        sound?: string;
      }) => Promise<void>;
      listChannels: () => Promise<{ channels: { id: string; name: string }[] }>;
    };

    try {
      const existing = await ChannelExt.listChannels();
      const existingIds = new Set(
        (existing?.channels || []).map((c) => c.id)
      );

      // Importance: 4 = HIGH (makes a sound + shows as heads-up
      // notification briefly). Visibility: 1 = PUBLIC (shows on
      // the lock screen).
      const channels = [
        {
          id: 'dose-reminder',
          name: 'تذكير الجرعات',
          description: 'تذكيرات يومية بمواعيد الأدوية',
          importance: 4,
          visibility: 1,
        },
        {
          id: 'low-stock',
          name: 'تنبيهات النفاذ',
          description: 'تنبيه عند اقتراب نفاذ دواء من المخزون',
          importance: 4,
          visibility: 1,
        },
      ];

      for (const ch of channels) {
        if (!existingIds.has(ch.id)) {
          await ChannelExt.createChannel(ch);
          console.info(
            `[native] Notification channel created: ${ch.id} (${ch.name})`
          );
        }
      }
    } catch (err) {
      console.warn('[native] Notification channel creation failed:', err);
    }
  } catch (err) {
    console.warn('[native] LocalNotifications setup failed:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // Foreground notification listener — plays the user's custom sound
  // ─────────────────────────────────────────────────────────────
  // When a local notification fires while the app is in the
  // foreground, Capacitor delivers it to this listener instead of
  // showing it in the system notification tray. We use this to:
  //   1. Play the user-uploaded custom sound (stored in the
  //      notification's `extra` field) — overriding the default
  //      channel sound.
  //   2. The notification itself is still delivered to the system
  //      notification tray by Capacitor, so the user sees the
  //      notification + hears the custom sound.
  try {
    LocalNotifications.addListener(
      'localNotificationReceived',
      (notification: { extra?: { customSoundFile?: { dataUrl: string; fileName: string; mimeType: string } } }) => {
        const customSound = notification?.extra?.customSoundFile;
        if (customSound?.dataUrl) {
          // Play the custom sound via an Audio element. We use a
          // dedicated Audio element (not the Web Audio API) because
          // custom sounds are MP3/WAV/etc files, not synthesized
          // tones. The Audio element plays them naturally.
          try {
            const audio = new Audio(customSound.dataUrl);
            audio.volume = 1;
            audio.play().catch((err) => {
              console.warn('[native] Custom sound playback failed:', err);
            });
          } catch (err) {
            console.warn('[native] Custom sound Audio() creation failed:', err);
          }
        }
      }
    );
  } catch (err) {
    console.warn('[native] localNotificationReceived listener failed:', err);
  }
}

/**
 * Open the OS-level app settings page where the user can toggle
 * notification permissions for the app.
 *
 * - **Android**: opens the Android "App info" screen for this app
 *   (Settings → Apps → النغنغ → Notifications), where the user
 *   can toggle notifications on.
 *
 * - **iOS**: opens the iOS Settings app at this app's notification
 *   permissions page (Settings → النغنغ → Notifications).
 *
 * - **Web**: returns false; the caller should fall back to
 *   openBrowserNotificationSettings() instead — there's no portable
 *   web URL that opens browser notification settings across all
 *   browsers.
 *
 * Implementation note: We use `App.openAppSettings()` via a cast to
 * `any` because the @capacitor/app 6.x TypeScript definitions
 * don't expose this method, but the underlying Android Java plugin
 * implements it. The runtime call works on Android 5.1+ and iOS
 * 10.0+.
 *
 * Returns:
 *   - true on Android / iOS when settings opened successfully
 *   - false on web OR if the Capacitor App plugin failed to open
 */
export async function openAppSettings(): Promise<boolean> {
  if (typeof Capacitor === 'undefined' || Capacitor.getPlatform() === 'web') {
    // On web, the caller should use openBrowserNotificationSettings
    // from utils/notifications.ts instead. This function is a no-op
    // here so the caller can fall back to the browser implementation.
    return false;
  }

  try {
    // openAppSettings() is part of the App plugin's Android/iOS
    // implementation but not declared in @capacitor/app 6.x TS defs.
    // Cast to any to access the runtime method.
    await (App as unknown as { openAppSettings: () => Promise<void> }).openAppSettings();
    return true;
  } catch (err) {
    console.warn('[native] openAppSettings failed:', err);
    return false;
  }
}
