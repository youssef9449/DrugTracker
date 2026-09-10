# النغنغ — Drug Tracker APK build guide

The web app (Vite + React SPA) is fully functional in any browser. To install it as a native Android APK on a phone, two options are available:

## Option A — Build APK locally with Capacitor + Android Studio

This option gives you a real signed APK file you can install on any Android device, share via WhatsApp, or upload to the Play Store.

### One-time setup

1. **Install prerequisites on your machine** (not needed in AI Studio):
   - **Node.js 20+** — check with `node --version`.
   - **Android Studio** (any recent version) — required to build the APK. Download from <https://developer.android.com/studio>.
   - After installing Android Studio, open it once and let it download the Android SDK (it will offer on first launch).

2. **Install npm dependencies** (includes Capacitor):
   ```bash
   npm install
   ```

3. **Add the Android project** (creates `android/` folder — only do this once per machine):
   ```bash
   npx cap add android
   ```

### Build flow

From the project root:

```bash
# 1. Build the web app → dist/
npm run build

# 2. Sync the web build into the Android project
npx cap sync android

# 3. Open the Android project in Android Studio
#    (or use `npm run cap:studio` which does steps 1-3 in one command)
npx cap open android
```

In Android Studio:

- Wait for Gradle sync to finish (bottom-right progress bar).
- Menu: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
- When the build finishes, click **"locate"** in the popup notification.
- The debug APK is at:
  ```
  android/app/build/outputs/apk/debug/app-debug.apk
  ```

Copy that file to your phone (via USB, Google Drive, WhatsApp Web, etc.) and tap it to install. You may need to enable "Install unknown apps" in Android Settings → Security.

### Or, build from the command line (no Android Studio UI):

```bash
cd android
./gradlew assembleDebug
# APK at: app/build/outputs/apk/debug/app-debug.apk
```

### Signed release APK (for distribution)

For a release-signed APK you can share with others, see the official Android docs:
<https://developer.android.com/build/building-apks#sign-manually>

Quick summary:

1. **Generate a release keystore** (one-time, save it forever — losing it means you can never publish an update to the same app):
   ```bash
   keytool -genkeypair \
     -keystore nagnagh-release.keystore \
     -alias nagnagh \
     -keyalg RSA -keysize 2048 \
     -validity 36500 \
     -storepass nagnagh2024release \
     -keypass nagnagh2024release \
     -dname "CN=Нагнаг Drug Tracker, OU=Mobile, O=Youssef9449, L=Cairo, ST=Cairo, C=EG"
   ```

2. **Configure `android/app/build.gradle`** to use the keystore for the release build. Open `android/app/build.gradle` and inside the `android { ... }` block, add:
   ```gradle
   signingConfigs {
       release {
           storeFile file('<absolute-path-to>/nagnagh-release.keystore')
           storePassword 'nagnagh2024release'
           keyAlias 'nagnagh'
           keyPassword 'nagnagh2024release'
       }
   }
   buildTypes {
       release {
           signingConfig signingConfigs.release
           minifyEnabled false
           proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
       }
   }
   ```
   Replace `<absolute-path-to>` with the actual path to your keystore file.

3. **Set the Android SDK location** — create `android/local.properties` with the path to your Android SDK:
   ```bash
   echo "sdk.dir=/home/youruser/Android/Sdk" > android/local.properties
   ```
   This file is gitignored by default. AI Studio doesn't need this because it sets `ANDROID_HOME` automatically, but a local build via `./gradlew` requires it.

4. **Build the signed APK** — either via Android Studio:
   - Open Android Studio → **Build → Generate Signed Bundle / APK → APK**, choose your keystore, select "release" build variant.

   Or via the command line (faster, no Android Studio UI needed):
   ```bash
   cd android
   ./gradlew assembleRelease \
     -x lint -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x testReleaseUnitTest
   ```
   The `-x lint...` flags skip lint tasks (they take 5+ minutes and aren't needed for a release APK you control yourself).

5. **The signed APK is at**: `android/app/build/outputs/apk/release/app-release.apk`.

6. **Verify the signature**:
   ```bash
   # Use the apksigner tool from build-tools/<version>/apksigner
   $ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs \
     android/app/build/outputs/apk/release/app-release.apk
   ```
   You should see "Verified using v1 scheme: true" and "Verified using v2 scheme: true".

### Updating the app

After editing the web source:

```bash
# Use `npm run cap:studio` for steps 1-2 in one command, then:
npx cap open android
# Or build the APK from the command line (no Android Studio needed):
npm run apk:debug
# Then rebuild in Android Studio as above, OR:
cd android
./gradlew assembleRelease -x lint -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x testReleaseUnitTest
```

**IMPORTANT**: Always sign update APKs with the **same keystore** as the original. Android refuses the update if the signing key differs — you'll see "App not installed" / "Signature mismatch" errors. Bump `versionCode` and `versionName` in `android/app/build.gradle` before publishing each update.

---

## Option B — Generate APK from a deployed PWA via PWABuilder

This option is easier if you don't want to install Android Studio, but requires deploying the app to a public URL first.

1. **Deploy the web build to a public URL**. Any static host works (Vercel, Netlify, GitHub Pages, Cloudflare Pages). For Vercel:
   ```bash
   npm install -g vercel
   vercel --prod
   ```
   You'll get a URL like `https://nagnagh.vercel.app`.

2. **Open <https://www.pwabuilder.com>** in your browser.

3. **Enter your deployed URL** and click **"Start"**.

4. **Click "Package for stores"** → choose **Android** → click **"Generate"**.

5. **Download the `.apk`** or `.aab` file. PWABuilder packages the PWA (manifest + service worker) into a TWA (Trusted Web Activity) APK that installs like a native app.

The resulting APK will:
- Show "النغنغ" as the app name on the home screen.
- Use the bell icon from `public/assets/icons/icon.svg` / `icon-192.png` as the launcher icon.
- Open in a full-screen Android window (no browser chrome).
- Use the teal-800 status bar color.
- Work offline (because of the service worker).

---

## Renaming the app

The external display name "النغنغ" is set in three places — keep them in sync:

| File | Field | Purpose |
|------|-------|---------|
| `index.html` | `<title>`, `<meta name="apple-mobile-web-app-title">`, `<meta name="application-name">` | Browser tab, iOS home screen, Android "Recents" |
| `public/manifest.json` | `name`, `short_name` | Android Chrome "Install app" / Add to home screen |
| `capacitor.config.ts` | `appName` | Capacitor Android project (the APK's display name) |
| `metadata.json` | `name` | Google AI Studio preview |

The Android package ID (`app.nagnagh`) is set in `capacitor.config.ts` → `appId`. Changing it after the first build requires deleting `android/` and re-running `npx cap add android`.

---

## Troubleshooting AI Studio "Cannot find module" errors

If AI Studio shows an error like:

```
Could not resolve "./scripts/with-app-env.mjs"
Could not resolve "./scripts/grok-pwa-plugin.mjs"
Could not resolve "./scripts/app-env-plugin.mjs"
Could not resolve "./scripts/migration-plan.mjs"
```

…it means AI Studio is running a cached copy of `package.json` or `vite.config.ts` from the deleted TanStack Start rewrite (commit `ac287a5`). The repo now ships **stub files** at those paths so the cached imports still resolve, but the real fix is to force AI Studio to re-fetch the latest config:

- **Hard reload**: `Ctrl+Shift+R` (or `Cmd+Shift+R` on Mac).
- If that doesn't help, click the **Reset** / **Restart** button in AI Studio to clear the preview cache.

Once AI Studio reads the latest `vite.config.ts` (which doesn't import any of those stub files), they become dead code and can be safely deleted.
