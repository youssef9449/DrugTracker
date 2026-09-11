# Drug Tracker — APK build guide

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

## Option A+ — Fast fully-automated headless build (no Android Studio)

This is the fastest path to a signed release APK. It runs entirely on the
command line — **no Android Studio UI, no GUI, no manual clicks**. It is the
flow used to produce every release APK in this repo. On a clean machine the
whole thing (prerequisites + build + signature verification) finishes in
roughly **8–12 minutes**; on a machine that already has the SDK + JDK cached
it drops to **under 3 minutes**.

### Prerequisites (one-time, ~5 min)

You need three things on `PATH`/`JAVA_HOME`. None of them require Android Studio.

1. **Node.js 20+** — `node --version`.
2. **Android SDK** (command-line tools, not the full Android Studio). Download `commandlinetools-linux-*.zip` from <https://developer.android.com/studio#command-line-tools-only>, then:
   ```bash
   mkdir -p ~/android-sdk/cmdline-tools/latest
   unzip -q commandlinetools-linux-*.zip -d ~/android-sdk/cmdline-tools/latest
   mv ~/android-sdk/cmdline-tools/latest/cmdline-tools/* ~/android-sdk/cmdline-tools/latest/
   rmdir ~/android-sdk/cmdline-tools/latest/cmdline-tools

   export ANDROID_HOME=~/android-sdk
   export ANDROID_SDK_ROOT=$ANDROID_HOME
   export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

   yes | sdkmanager --licenses
   sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
   ```
3. **JDK 21** (full JDK — needs `javac` **and** `jlink` + the `jmods/` dir; the JRE-headless package is NOT enough because Gradle 8.7's `JdkImageTransform` task needs `jlink`). Adoptium Temurin 21 is recommended:
   ```bash
   curl -sSL -o jdk21.tar.gz \
     "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse"
   mkdir -p ~/jdk21
   tar -xzf jdk21.tar.gz -C ~/jdk21 --strip-components=1
   export JAVA_HOME=~/jdk21
   export PATH="$JAVA_HOME/bin:$PATH"
   ```
   Verify: `java -version` (21.x), `which jlink` (should print a path under `$JAVA_HOME/bin`).

> **Why JDK 21 + Gradle 8.7?** AGP 8.2 ships with Gradle 8.2.1, which does NOT
> officially support running on JDK 21 — the Gradle *daemon* runs but its
> *wrapper client* hangs on shutdown, so every build looks like it never
> finishes. Gradle 8.7 (set in the wrapper properties, see step 1 below) is
> the first release with official Java 21 support and fixes the hang.

### Build steps (repeatable, ~2–3 min once prerequisites are cached)

Assume you are at the repo root and the keystore (`nagnagh-release.keystore`)
sits at the repo root too.

#### 1. Bump the Gradle wrapper to 8.7 (already done in the repo, skip if present)

```bash
# android/gradle/wrapper/gradle-wrapper.properties should read:
# distributionUrl=https\://services.gradle.org/distributions/gradle-8.7-all.zip
```

#### 2. Install npm deps + build the web app

```bash
npm install
npm run build          # → dist/
```

#### 3. Generate the Android project (only if `android/` is missing)

```bash
npx cap add android
```

#### 4. Patch `android/app/build.gradle` for signing + lint-skip

Open `android/app/build.gradle` and inside the `android { ... }` block make
sure you have a `signingConfigs.release` block + `buildTypes.release` wired to
it + a `lint { checkReleaseBuilds = false }` block (full snippet below). Point
`storeFile` at the keystore (a path relative to `rootProject.projectDir` works):

```gradle
def keystorePath = file("${rootProject.projectDir}/../nagnagh-release.keystore")

android {
    // ... defaultConfig ...
    signingConfigs {
        release {
            storeFile keystorePath
            storePassword 'nagnagh2024release'
            keyAlias 'nagnagh'
            keyPassword 'nagnagh2024release'
            enableV1Signing true
            enableV2Signing true
            enableV3Signing false
            enableV4Signing false
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
    // lintVitalRelease expects input files produced by lint tasks we skip
    // below — disable the release lint check so the build doesn't fail on
    // a missing lintVitalReturn_value file. AGP 8.2 quirk.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
```

#### 5. Tell Gradle where the SDK is + bump daemon memory

```bash
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
# android/gradle.properties — bump the heap to 2 GB (default 1536 MB can OOM
# on a real project) and enable the daemon:
# org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
# org.gradle.daemon=true
# org.gradle.configureondemand=true
```

#### 6. Prepare exact alarms and the native reminder sound

Medication dose reminders are time-sensitive and MUST fire at the exact
scheduled time. On Android 12+ (API 31+), `@capacitor/local-notifications`
uses `AlarmManager.setExactAndAllowWhileIdle` — but only if the app
declares the `SCHEDULE_EXACT_ALARM` permission and the user grants it.

The repeatable `npm run cap:sync` and `npm run apk:debug` commands run
`scripts/prepare-android.mjs` after Capacitor sync. It injects the
`SCHEDULE_EXACT_ALARM` permission into the generated manifest and creates the
bundled `dose_reminder.wav` resource used by the versioned dose notification
channel. No manual manifest edit is required after a sync.

**Why `SCHEDULE_EXACT_ALARM` and not `USE_EXACT_ALARM`?**
- `USE_EXACT_ALARM` is for apps whose core purpose IS an alarm clock or
  calendar (granted automatically, no user prompt). A medication tracker
  doesn't qualify under Google Play's policy.
- `SCHEDULE_EXACT_ALARM` is for apps that NEED exact alarms but aren't
  alarm-clock apps. The user must grant it via the Android settings screen
  (the app opens it via `LocalNotifications.changeExactNotificationSetting()`).
  On Android < 12 it's granted automatically (no settings screen needed).

The app checks this permission at runtime (`getExactAlarmPermission()` in
`notifications.ts`) and shows a UI warning + "grant" button in the
AppSettingsModal when it's missing. The `useDoseReminderScheduler` hook
BLOCKS dose-reminder scheduling when the permission is denied (inexact
alarms are unacceptable for medication reminders).

### Dose notification sound policy

Android notification channels cannot change their sound after creation, and
Capacitor Local Notifications 6 posts the native notification after emitting
the foreground `localNotificationReceived` event. The app therefore uses two
fixed dose channels:

- `dose-reminder-foreground-v1` is silent. While the app is active, the
   foreground handler plays one global custom, per-medication synthesized, or
   default chime and opens the modal.
- `dose-reminder-v2` contains the bundled `dose_reminder.wav`. When the app
   is backgrounded or killed, Android plays this native sound without
   JavaScript.

Lifecycle transitions re-arm the same stable notification IDs onto the
appropriate channel. The global uploaded sound remains in IndexedDB and is
never copied into native notification extras. The `soundEnabled` setting
controls foreground JavaScript playback; Android may still play the native
background fallback because channel sound cannot be toggled per notification
without creating uncontrolled channel state.

#### 7. Sync the web build into the Android project

```bash
npx cap sync android
```

#### 8. Build the signed release APK

```bash
cd android
./gradlew assembleRelease --no-daemon
```

> **Shutdown-hang workaround (Java 21 + old Gradle):** if you are NOT on
> Gradle 8.7+, the Gradle *wrapper client* hangs after the build succeeds even
> though the daemon has already exited cleanly. The build itself is complete —
> the APK is already on disk. Run gradle in the background, poll the build log
> for `BUILD SUCCESSFUL`, then `kill -9` the wrapper:
> ```bash
> ./gradlew assembleRelease --no-daemon > build.log 2>&1 &
> GRADLE_PID=$!
> while ! grep -qE "BUILD SUCCESSFUL|BUILD FAILED" build.log; do
>   kill -0 $GRADLE_PID 2>/dev/null || break
>   sleep 1
> done
> sleep 3  # let the APK finalize on disk
> kill -9 $GRADLE_PID 2>/dev/null
> pkill -9 -f GradleDaemon 2>/dev/null
> ```
> (Once you are on Gradle 8.7 this workaround is unnecessary — `./gradlew`
> returns on its own.)

#### 9. Verify the signature + grab the APK

```bash
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --verbose --print-certs \
  app/build/outputs/apk/release/app-release.apk
# Expect: Verified using v1 scheme: true  | v2 scheme: true
# Expect: Signer #1 certificate SHA-256: d3b89977... (matches the keystore)

$ANDROID_HOME/build-tools/34.0.0/zipalign -c -v 4 \
  app/build/outputs/apk/release/app-release.apk
# Expect: Verification succesful

# The signed APK:
ls -la app/build/outputs/apk/release/app-release.apk
```

### Expected timings (warm cache, 2-core / 4 GB machine)

| Step | Time |
|------|------|
| `npm install` (cached) | ~10 s |
| `npm run build` (vite) | ~3 s |
| `npx cap add android` (first time only) | ~1 s |
| `npx cap sync android` | ~1 s |
| Gradle wrapper download (Gradle 8.7, first time only) | ~30 s |
| Gradle dependency download (first time only) | ~60 s |
| `./gradlew assembleRelease` (incremental) | **~90–160 s** |
| `apksigner verify` | <1 s |

Total for a warm rebuild: **~3 minutes**. Total for a clean-machine first
build (download SDK + JDK + Gradle + all deps): **~8–12 minutes**.

### Updating the app (Option A+ quick reference)

```bash
# From the repo root, after editing web source:
npm run build && npx cap sync android && \
cd android && ./gradlew assembleRelease --no-daemon
# → app/build/outputs/apk/release/app-release.apk
```

Remember to bump `versionCode` + `versionName` in `android/app/build.gradle`
before each release, and always sign with the same keystore.

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
- Show "Drug Tracker" as the app name on the home screen.
- Use the bell icon from `public/assets/icons/icon.svg` / `icon-192.png` as the launcher icon.
- Open in a full-screen Android window (no browser chrome).
- Use the teal-800 status bar color.
- Work offline (because of the service worker).

---

## Renaming the app

The external display name "Drug Tracker" is set in three places — keep them in sync:

| File | Field | Purpose |
|------|-------|---------|
| `index.html` | `<title>`, `<meta name="apple-mobile-web-app-title">`, `<meta name="application-name">` | Browser tab, iOS home screen, Android "Recents" |
| `public/manifest.json` | `name`, `short_name` | Android Chrome "Install app" / Add to home screen |
| `capacitor.config.ts` | `appName` | Capacitor Android project (the APK's display name) |
| `metadata.json` | `name` | Google AI Studio preview |

The Android package ID (`app.drugtracker`) is set in `capacitor.config.ts` → `appId`. Changing it after the first build requires deleting `android/` and re-running `npx cap add android`.

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
