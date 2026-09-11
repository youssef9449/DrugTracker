import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for Drug Tracker.
 *
 * The app is a Vite + React SPA. Capacitor wraps the production
 * build (output of `vite build`, located in `dist/`) in an Android
 * WebView so it can be installed as a native APK on the phone.
 *
 * Build flow:
 *   1. `npm run build`        — vite build → dist/
 *   2. `npx cap add android`  — first-time only, creates android/ project
 *   3. `npx cap sync android` — copies dist/ into the Android project
 *   4. `npx cap open android`  — opens the project in Android Studio
 *   5. In Android Studio: Build → Build APK(s) → install on phone
 *
 * OR for a one-shot debug APK without Android Studio:
 *   cd android && ./gradlew assembleDebug
 *   → android/app/build/outputs/apk/debug/app-debug.apk
 *
 * The bundle ID `app.drugtracker` is used as the Android package name
 * and the iOS bundle identifier. It must be lowercase, contain only
 * letters and dots, and end with a non-numeric segment. We use the
 * `app.` prefix to keep it out of the public DNS namespace.
 */
const config: CapacitorConfig = {
  appId: 'app.drugtracker',
  appName: 'Drug Tracker',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    // Allow the WebView to access localStorage / IndexedDB. Already
    // allowed by default, but explicit for clarity.
    allowMixedContent: false,
    backgroundColor: '#f1f5f9',
  },
  plugins: {
    StatusBar: {
      // Match the teal-800 theme color used in the app header.
      backgroundColor: '#0f766e',
      style: 'LIGHT',
      overlaysWebView: false,
    },
    App: {
      // Kill the app on back-button press on Android (rather than
      // going back in the WebView history, which can confuse users
      // since our SPA doesn't have a multi-level navigation stack).
      // The user can still use the bottom-nav buttons to switch tabs.
    },
  },
};

export default config;
