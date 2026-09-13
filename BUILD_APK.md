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
   ./gradlew assembleRelease --no-daemon --no-watch-fs
   ```
   The `lint { checkReleaseBuilds = false }` block in `app/build.gradle` already disables `lintVitalRelease`, so no `-x` flags are needed. (Do **not** use `-x lintVitalReportRelease -x lintVitalAnalyzeRelease` — those tasks don't exist in AGP 8.2.1 and the build fails with `Task not found`.)

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
./gradlew assembleRelease --no-daemon --no-watch-fs
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

#### 5. Tell Gradle where the SDK is + turn on every speed-up flag

```bash
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
```

Overwrite `android/gradle.properties` with the following (the Capacitor-generated
defaults only set `org.gradle.jvmargs=-Xmx1536m` and `android.useAndroidX=true` —
the flags below cut a warm rebuild from ~3 min to **under 2 min**, and a
no-op rebuild to ~30 s):

```properties
# JVM for the Gradle daemon. 2 GB avoids OOM on a real Capacitor project;
# UTF-8 avoids a Gradle 8.7 + JDK 21 warning on non-ASCII paths.
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8

# Keep the daemon alive between builds (saves ~15-20 s of JVM + config
# startup on every rebuild). Use `--no-daemon` only inside CI.
org.gradle.daemon=true

# Configuration cache: Gradle caches the entire configuration phase and
# reuses it unchanged on the next build. First build is unaffected; every
# subsequent build skips ~5-10 s of project-configuration work.
#
# ⚠ Requires AGP 8.3+. On AGP 8.2.1 (the version `npx cap add android`
#   generates today) the build DEADLOCKS on the Capacitor multi-project
#   setup. Leave it off until you bump the AGP classpath in
#   `android/build.gradle` to 8.3+.
# org.gradle.configuration-cache=true

# Build cache: reuses task outputs across builds and across projects.
org.gradle.caching=true

# Parallel project execution. Capacitor generates 4+ subprojects
# (capacitor-android, capacitor-local-notifications, capacitor-status-bar,
# capacitor-cordova-android-plugins) that can all configure/build in parallel.
org.gradle.parallel=true

# Configure-on-demand: only configure projects actually needed for the
# requested task. Pairs well with `parallel`.
org.gradle.configureondemand=true

android.useAndroidX=true
```

> **Why not `--no-daemon`?** The original guide used `--no-daemon` to dodge a
> Gradle 8.2.1 + JDK 21 shutdown-hang (the wrapper client refused to exit even
> after the daemon finished). That bug is fixed in **Gradle 8.7**, which is why
> step 1 bumps the wrapper. With 8.7 + `--daemon`, the daemon stays warm and
> a rebuild drops from ~3 min to **~90 s**; a pure no-op rebuild (no source
> changes) finishes in **~30 s**.

#### 6. Prepare exact alarms and the native reminder sound

Medication dose reminders are time-sensitive and MUST fire at the exact
scheduled time. On Android 12+ (API 31+), `@capacitor/local-notifications`
uses `AlarmManager.setExactAndAllowWhileIdle` — but only if the app
declares the `SCHEDULE_EXACT_ALARM` permission and the user grants it.

The repeatable `npm run cap:sync` and `npm run apk:debug` commands run
`scripts/prepare-android.mjs` after Capacitor sync. It injects the
`SCHEDULE_EXACT_ALARM` permission into the generated manifest and removes any
legacy `dose_reminder.wav` from a previous build (the dose channel now uses
the default system sound). No manual manifest edit is required after a sync.

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
the foreground `localNotificationReceived` event. The app uses a single
dose-reminder channel:

- `dose-reminder-v3` uses the **default system notification sound** (the one
  the user picked in Settings → Sound). No custom sound is bundled — the
  previous `dose_reminder.wav` was removed because users found it unpleasant.
  Since channel sound is immutable, bumping from v2 to v3 was the only way to
  switch the sound; the old v2 channel is deleted on first launch.

The `soundEnabled` setting controls foreground JavaScript playback (the
in-app chime when the app is active). When the app is backgrounded or killed,
Android plays the system default notification sound via the v3 channel — no
JavaScript is involved.

#### 7. Sync the web build into the Android project

```bash
npx cap sync android
```

#### 8. Build the signed release APK

The `lint { checkReleaseBuilds = false; abortOnError = false }` block from
step 4 already disables `lintVitalRelease`, so **no `-x` flags are needed**.
(Do not copy `-x lintVitalReportRelease -x lintVitalAnalyzeRelease` from older
guides — those task names don't exist in AGP 8.2.1 and the build fails with
`Task 'lintVitalReportRelease' not found`.)

```bash
cd android
./gradlew assembleRelease --no-daemon --no-watch-fs
```

* `--no-daemon` — the daemon deadlocks on stale locks in sandboxed / CI /
  headless environments. A no-daemon build is ~10 s slower on startup but
  100% reliable. Use `--daemon` only for interactive local dev.
* `--no-watch-fs` — disables Gradle's file-system-watching, which hangs the
  wrapper client on shutdown in some Linux/container environments even on
  Gradle 8.7.

This finishes in **~50–90 s on a warm 2-core / 4 GB machine** (proven: a real
build on exactly that spec completed in **51 s**).

> **If the build finishes but the `./gradlew` process never returns** (hangs
> after printing `BUILD SUCCESSFUL`), run it in the background and poll + kill:
> ```bash
> ./gradlew assembleRelease --no-daemon --no-watch-fs > build.log 2>&1 &
> GRADLE_PID=$!
> while ! grep -qE "BUILD SUCCESSFUL|BUILD FAILED" build.log; do
>   kill -0 $GRADLE_PID 2>/dev/null || break
>   sleep 1
> done
> sleep 3  # let the APK finalize on disk
> kill -9 $GRADLE_PID 2>/dev/null
> pkill -9 -f GradleDaemon 2>/dev/null
> ```
> The APK is already on disk the moment `BUILD SUCCESSFUL` appears — the kill
> only reclaims the hung wrapper process.

> **First build only — pre-warm the Gradle distribution.** The very first run
> downloads Gradle 8.7 (~130 MB) and all AGP/AndroidX dependencies (~470 MB).
> If your network is slow, download the distribution manually first so the
> build doesn't time out partway through:
> ```bash
> DIST="$(grep distributionUrl gradle/wrapper/gradle-wrapper.properties \
>   | sed 's/.*gradle-\([0-9.]*\)-all.zip.*/\1/')"
> HASH_DIR="$(ls -d ~/.gradle/wrapper/dists/gradle-${DIST}-all/* 2>/dev/null | head -1)"
> mkdir -p "$HASH_DIR"
> curl -sSL -o "$HASH_DIR/gradle-${DIST}-all.zip" \
>   "https://services.gradle.org/distributions/gradle-${DIST}-all.zip"
> # The wrapper will verify the hash and unpack it on first use.
> ```

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

### Expected timings (2-core / 4 GB machine)

There are **three speed tiers**, depending on what's cached. Knowing which
tier you're in tells you exactly how long a build will take.

| Tier | When it happens | Total time |
|------|-----------------|------------|
| **Cold** | First-ever build on a fresh machine (no JDK, no SDK, no Gradle, no deps) | ~8–12 min |
| **Warm** | Caches are populated, but most source/config files changed since last build | ~50–90 s |
| **Incremental** | Only a few source files changed (e.g. a bugfix + `versionCode` bump) | **~20–30 s** |

#### Detailed timings per tier

| Step | Cold | Warm | Incremental |
|------|------|------|-------------|
| `npm install` | ~30 s | ~10 s (cached) | ~10 s (cached) |
| `npm run build` (vite) | ~5 s | ~3 s | ~3 s |
| `npx cap add android` (first time only) | ~1 s | — | — |
| `npx cap sync android` | ~1 s | ~1 s | ~1 s |
| Gradle wrapper download (8.7, first time only) | ~30 s | — | — |
| Gradle dependency download (first time only) | ~60 s | — | — |
| `./gradlew assembleRelease --no-daemon --no-watch-fs` | ~2 min | ~50–90 s | **~20–30 s** |
| `apksigner verify` | <1 s | <1 s | <1 s |

**Proven on a 2-core / 4 GB machine:**
- Warm: **51 s** (full rebuild, all tasks executed, caches warm)
- Incremental: **27 s** (only `versionCode` + one source file changed → 40 tasks
  executed, 139 UP-TO-DATE)

---

### How to get a ~25 s incremental rebuild (step by step)

The 27 s build above was not magic — it was Gradle's incremental build system
doing its job. This section is the exact recipe, written so future-you can
reproduce it without thinking.

#### What "incremental" means

Gradle tracks the **inputs** (source files, configs, dependency versions) and
**outputs** of every task. On each build, it checks whether any input changed
since the last successful run. If none changed, the task is marked
`UP-TO-DATE` and skipped entirely. When you change only `versionCode` in
`app/build.gradle` + one `.ts` file, only the tasks that depend on those
inputs re-run — everything else is skipped. In the 27 s build, **139 of 179
tasks were UP-TO-DATE**; only 40 actually executed.

The three tiers map to how many tasks are UP-TO-DATE:
- **Cold**: 0 of 179 (nothing cached — downloads + full execution)
- **Warm**: ~0 of 179 (caches populated, but all sources changed → full execution)
- **Incremental**: ~140+ of 179 (only a few inputs changed → most tasks skipped)

#### Prerequisites (do these once, then never again)

These are the caches that make incremental builds possible. They persist
across builds on the same machine — **do not delete them** between builds.

1. **JDK 21** installed at `~/jdk21` (or wherever — just keep it).
2. **Android SDK** at `~/android-sdk` with `platform-tools`, `platforms;android-34`,
   `build-tools;34.0.0` installed.
3. **Gradle 8.7 distribution** unpacked at
   `~/.gradle/wrapper/dists/gradle-8.7-all/<hash>/gradle-8.7/`.
   (Downloaded automatically on first build; pre-warm manually if your network
   is slow — see step 8's note.)
4. **Gradle dependency cache** at `~/.gradle/caches/modules-2/` (~470 MB of
   AGP + AndroidX + Capacitor + Kotlin jars). Populated on first build.
5. **The `android/` project** generated by `npx cap add android` — keep it.
   Do NOT delete it between builds.
6. **`android/local.properties`** pointing at the SDK:
   `sdk.dir=/home/z/android-sdk`.
7. **`android/gradle.properties`** with the fast settings (see step 5).
8. **`android/app/build.gradle`** with the signing config + `lint { ... }`
   block (see step 4).

Once all eight are in place, every subsequent build is at most a warm rebuild.

#### The incremental rebuild recipe (do this every time)

```bash
# From the repo root. Total: ~25 s if only source/versionCode changed.

# 1. Edit your source files (e.g. fix a bug in src/utils/notifications.ts).
#    If shipping a new release, also bump versionCode + versionName in
#    android/app/build.gradle (see "Bumping the version for an update" above).

# 2. Rebuild the web app → dist/  (~3 s)
npm run build

# 3. Sync the web build into the existing android/ project  (~1 s)
#    This copies dist/ → android/app/src/main/assets/public/ and regenerates
#    capacitor.config.json. It does NOT touch build.gradle, gradle.properties,
#    or the signing config — so Gradle's cache stays valid.
npx cap sync android

# 4. Run the prepare script (exact-alarm permission + cleanup)  (~0.1 s)
node scripts/prepare-android.mjs

# 5. Build the signed release APK  (~20-30 s incremental, ~50-90 s warm)
cd android
./gradlew assembleRelease --no-daemon --no-watch-fs
# → app/build/outputs/apk/release/app-release.apk
```

Steps 2–4 take ~5 s combined. Step 5 is where the time goes — and it's the
step that benefits from incremental caching.

#### How to verify your build was actually incremental

Read the last line of the Gradle output:

```
BUILD SUCCESSFUL in 27s
179 actionable tasks: 40 executed, 139 up-to-date
```

- **`X up-to-date`** should be **high** (120+) for an incremental build.
- If `up-to-date` is 0 and `executed` is 179, you're doing a **warm** build
  (~50–90 s) — something invalidated the cache (see below).
- If you see "Downloading https://services.gradle.org/…" or "Resolve
  dependencies of …" taking 30+ s, you're doing a **cold** build — the
  caches were deleted.

#### What invalidates the incremental cache (avoid these between builds)

| Action | What it breaks | Recovery |
|--------|---------------|----------|
| `./gradlew clean` | Deletes all `build/` dirs → every task re-runs | Full warm rebuild (~90 s) |
| Deleting `android/` | Loses the generated project + all config | Re-run `npx cap add android` + re-patch build.gradle + gradle.properties (~5 min) |
| Deleting `~/.gradle/caches/` | Loses all downloaded dependencies | Re-download ~470 MB (~60 s) |
| Changing `android/build.gradle` `classpath` (AGP version) | Re-resolves + re-downloads AGP | Warm rebuild + dep download |
| Changing `android/gradle/wrapper/gradle-wrapper.properties` | Re-downloads the Gradle distribution | ~30 s download + warm build |
| Changing `capacitor.config.ts` (appId, appName) | `cap sync` regenerates native project files | Warm rebuild |
| Changing `android/app/build.gradle` `signingConfigs` | Re-runs packaging + signing (but not compile) | ~30 s |
| Changing `android/app/build.gradle` `versionCode` / `versionName` | Re-runs packaging (manifest merge + APK build) — **this is fine, it's fast** | ~25 s (still incremental) |
| Changing `src/**/*.ts` / `.tsx` | Re-runs vite build + cap sync + Gradle's mergeAssets | ~25 s (still incremental) |

The key insight: **changing source files or `versionCode` preserves
incrementality** (only the affected tasks re-run). Changing build
**infrastructure** (Gradle version, AGP version, capacitor config, deleting
`android/` or caches) forces a warm or cold rebuild.

#### The fastest possible loop: source edit → APK in <30 s

```bash
# Edit src/something.ts, then:
npm run build && npx cap sync android && node scripts/prepare-android.mjs && \
cd android && ./gradlew assembleRelease --no-daemon --no-watch-fs && \
ls -la app/build/outputs/apk/release/app-release.apk
# Total: ~25-30 s on a 2-core / 4 GB machine with warm caches.
```

This is the command future-you should reach for 95% of the time. The only
reason to do anything slower is the first build on a new machine, or after
deleting the `android/` directory or the Gradle caches.


### Updating the app (Option A+ quick reference)

```bash
# From the repo root, after editing web source.
# See "How to get a ~25 s incremental rebuild" above for the full recipe.
# Expect ~25-30 s if only source/versionCode changed, ~50-90 s if many
# files changed, ~8-12 min on a fresh machine.
npm run build && npx cap sync android && node scripts/prepare-android.mjs && \
cd android && ./gradlew assembleRelease --no-daemon --no-watch-fs
# → app/build/outputs/apk/release/app-release.apk
```

Remember to bump `versionCode` + `versionName` in `android/app/build.gradle`
before each release, and always sign with the same keystore.

### Bumping the version for an update (releases a new installable APK)

Android refuses to install an APK whose `versionCode` is **lower than or equal
to** the currently-installed one — the installer shows *"App not installed"*
with no further detail. Every release you want users to install **over** an
existing copy must have a higher `versionCode` AND be signed with the **same
keystore**.

#### The three rules for an in-place update

| Rule | Why | Where |
|------|-----|-------|
| Same `applicationId` (`app.drugtracker`) | Android matches apps by package name | `android/app/build.gradle` → `defaultConfig.applicationId` |
| Higher `versionCode` (monotonic increase) | Android refuses downgrades / no-ops | `android/app/build.gradle` → `defaultConfig.versionCode` |
| Same signing key (identical SHA-256) | Android refuses cross-key updates | `signingConfigs.release` (same keystore file) |

Meet all three → the APK installs as an **update** (keeps all user data:
medications, history, settings). Break any one → *"App not installed"* /
*"package appears to be invalid"* and the user must uninstall first (losing
data).

#### Versioning scheme

`versionCode` is an integer Android compares numerically; `versionName` is a
string shown to users. A clean scheme:

| Release | `versionCode` | `versionName` |
|---------|---------------|---------------|
| Initial | `1` | `"1.0"` |
| Patch   | `2` | `"1.0.1"` |
| Minor   | `12` | `"1.2"` |
| Next minor | `13` | `"1.3"` |
| Next minor | `14` | `"1.4"` |

`versionCode` jumps in steps of 1 (or 10 if you want room for hotfixes
in-between). **Never reuse a `versionCode`** — Android caches the highest one
seen and won't let the same code install twice as an update.

#### Step-by-step: ship v1.3 over an installed v1.2

1. **Edit `android/app/build.gradle`** — inside `defaultConfig { … }`:
   ```gradle
   versionCode 13
   versionName "1.3"
   ```
   (Pick the next integer above whatever the previous release used. If you
   don't know the previous `versionCode`, run this against the installed APK:
   ```bash
   $ANDROID_HOME/build-tools/34.0.0/aapt dump badging \
     app/build/outputs/apk/release/app-release.apk | grep versionCode
   # → package: name='app.drugtracker' versionCode='12' versionName='1.2'
   ```
   Then use `13`.)

2. **Rebuild with the SAME keystore** (no other change needed):
   ```bash
   cd android
   ./gradlew assembleRelease --no-daemon --no-watch-fs
   # → app/build/outputs/apk/release/app-release.apk  (now versionCode 13 / 1.3)
   ```
   An incremental rebuild (only `versionCode` changed, sources cached) is
   **~20 s**.

3. **Verify the bump + signature**:
   ```bash
   $ANDROID_HOME/build-tools/34.0.0/aapt dump badging \
     app/build/outputs/apk/release/app-release.apk | head -1
   # Expect: package: name='app.drugtracker' versionCode='13' versionName='1.3'

   $ANDROID_HOME/build-tools/34.0.0/apksigner verify --print-certs \
     app/build/outputs/apk/release/app-release.apk | grep SHA-256
   # Expect: d3b89977…9506088  (SAME as the v1.2 key)
   ```

4. **Distribute.** The user taps the new APK → Android sees same package +
   higher `versionCode` + same key → prompts **"Install update?"** → replaces
   v1.2, keeps all data. No uninstall required.

#### Quick sanity check before distributing

```bash
# Does versionCode strictly increase over the previous release?
echo "new: $(aapt dump badging new.apk | grep -o 'versionCode=[^ ]*')"
echo "old: $(aapt dump badging old.apk | grep -o 'versionCode=[^ ]*')"
# new versionCode MUST be > old versionCode.

# Same signing key?
diff <(apksigner verify --print-certs new.apk | grep SHA-256) \
     <(apksigner verify --print-certs old.apk | grep SHA-256)
# No output = identical fingerprints = good.
```

---

## Troubleshooting: "App not installed" / "package appears to be invalid"

This error is shown by the Android GUI installer (Package Installer app) when
it refuses an APK. The GUI message is **deliberately generic** — it covers
everything from a signature clash to a vendor security toggle. The fix is to
get the *real* reason, which is always one of the cases below.

### Step 0 — get the real error message with `adb install`

Plug the phone in, enable USB debugging (Settings → Developer options), then:

```bash
adb install -r app-release.apk
```

`adb` prints the actual failure code, e.g.:
- `INSTALL_FAILED_UPDATE_INCOMPATIBLE` → case 1 (signature clash)
- `INSTALL_FAILED_VERIFICATION_FAILURE` → case 5 (Play Protect)
- `INSTALL_FAILED_OLDER_SDK` → case 6 (Android version too old)
- `INSTALL_FAILED_INVALID_APK` → case 7 (corrupt download)

Once you know the code, jump to the matching case.

### Case 1 — An existing install has a different signature (most common)

If `app.drugtracker` is **already on the phone** with a *different* signing
key, Android refuses the install. This happens in three scenarios:

1. You installed the **debug APK** (signed with the Android debug key) and are
   now trying to install the **release APK** (signed with your keystore) —
   different keys → refused.
2. You previously installed a **PWABuilder TWA** (Option B) — it uses a
   *Digital Asset Links* signing key, totally unrelated to your keystore.
3. A prior release was signed with a **different keystore** you no longer have.

The fix is to **fully uninstall the existing app first**:
- Phone: Settings → Apps → **Drug Tracker** → Uninstall.
- Or: `adb uninstall app.drugtracker`
- **MIUI / One UI caveat**: also check "uninstall for all users" —
  `adb shell pm list packages | grep drugtracker` should return *nothing*
  before you retry the install.

After uninstalling, the signed release APK installs cleanly. (You can install
the debug APK over a release APK, or vice-versa, only if you uninstall first —
they can never coexist or update each other.)

### Case 2 — Android 14+ "Restricted settings" blocks sideloads

Android 14 (API 34) blocks apps sideloaded via a browser / Files app / messenger
if the sideloading app wasn't previously granted the "install unknown apps"
permission **and** the sideloaded app requests sensitive permissions. The GUI
shows "App not installed" with no further detail.

Fix: **Settings → Apps → Special app access → Restricted settings →** toggle
**on** for the app you sideloaded from (e.g. Chrome / Files / WhatsApp). Then
retry the install. ([Android 14 restricted settings docs](https://support.google.com/android/answer/12623653).)

### Case 3 — Samsung Auto Blocker (One UI 6+)

Samsung's "Auto Blocker" (One UI 6 / Android 14+) blocks sideloaded APKs by
default and surfaces "App not installed". Turn it off, or add an exception:

**Settings → Security and privacy → Auto Blocker →** off (or **Block app
installs with Auto Blocker → App protection list →** add Drug Tracker).

### Case 4 — Xiaomi MIUI / Oppo ColorOS / Vivo OriginOS USB-install toggle

These vendors require a *separate* developer toggle to allow sideload installs
over USB / file manager:
- **MIUI**: Developer options → **USB installation** (and **Install via USB**)
  → enable. A SIM-connected Mi account is sometimes required.
- **ColorOS**: Developer options → **Disable permission monitoring** +
  **Install via USB**.
- **OriginOS**: Developer options → **USB debug (Security settings)**.

A MIUI-specific symptom: the installer says "waiting" forever, then fails.

### Case 5 — Google Play Protect flagged the APK

Play Protect scans sideloaded APKs and can silently block unsigned or
low-reputation apps. The `adb` error is `INSTALL_FAILED_VERIFICATION_FAILURE`.

Fix: **Settings → Google → Play Protect → ⚙ → Scan apps with Play Protect →**
off temporarily, retry the install, turn it back on afterward. (You can also
watch the install with `adb install -r` — Play Protect's network check is
skipped for `adb` installs, so this also works as a workaround.)

### Case 6 — Phone's Android version is below `minSdkVersion` (22)

`app.drugtracker` declares `minSdkVersion=22` (Android 5.1 Lollipop). If the
phone is on Android 5.0 or older, install is refused with `INSTALL_FAILED_OLDER_SDK`.
This is now extremely rare (Android 5.1 shipped in 2015) but shows up on
old test devices. No fix except updating the phone.

### Case 7 — Corrupt / truncated APK download

If the APK was transferred through WhatsApp / Telegram / a cloud drive, it can
arrive truncated or re-compressed. Compare the SHA-256 on the phone against the
build-machine value:

```bash
# Build machine:
sha256sum android/app/build/outputs/apk/release/app-release.apk
# Phone (via adb):
adb shell sha256sum /sdcard/Download/app-release.apk
```

The two must match **exactly**. If they differ, re-transfer the file — use
`adb push` or a USB cable instead of a messenger.

### Case 8 — The APK really is malformed (rare)

If none of the above applies, verify the APK itself on the build machine:

```bash
# Signature + schemes:
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --verbose --print-certs \
  app/build/outputs/apk/release/app-release.apk
# Expect: v1 true, v2 true, SHA-256 d3b89977...

# Alignment (must be 4-byte aligned):
$ANDROID_HOME/build-tools/34.0.0/zipalign -c -v 4 \
  app/build/outputs/apk/release/app-release.apk
# Expect: Verification succesful

# Manifest parses + identity is correct:
$ANDROID_HOME/build-tools/34.0.0/aapt dump badging \
  app/build/outputs/apk/release/app-release.apk | head -2
# Expect: package: name='app.drugtracker' versionCode='1' versionName='1.0'
```

If all three pass, the APK is valid and the problem is **100% on the phone**
(cases 1–6). Re-read case 1 — a leftover install with a mismatched signature
is by far the most frequent cause and is invisible in the GUI.

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
