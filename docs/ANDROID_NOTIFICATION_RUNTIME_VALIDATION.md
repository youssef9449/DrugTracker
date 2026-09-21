# Android notification channel — runtime validation

## Purpose

TypeScript/Vitest tests and static inspection of Java source prove:

- which channel IDs the app *requests*
- which channel the JS scheduler picks at *schedule time*
- which channel `TimedNotificationPublisher.resolveDoseReminderChannel` *intends* at *delivery time*

They **cannot** prove what Android’s `NotificationManager` actually stores for a channel (importance, sound URI, user overrides) or which channel ID is attached to a **delivered** system notification after alarm delivery, process death, or channel immutability.

This document closes that gap with a **reproducible manual/runtime procedure** on a real emulator or device. It does **not** change production notification architecture.

## Intended contract (do not change)

| Scenario | Expected channel ID | Expected importance | Expected sound |
| -------- | ------------------- | ------------------- | -------------- |
| App foreground | `dose-reminder-foreground-v1` | LOW (2) | Silent (no system alert) |
| App background (process alive) | `dose-reminder-v3` | HIGH (4) | System default notification sound |
| Process killed / fresh process | `dose-reminder-v3` | HIGH (4) | System default notification sound |

Channel creation (JS → Capacitor → Android):

- `src/native.ts` → `LocalNotifications.createChannel`
- Background: `dose-reminder-v3`, importance 4, **no** `sound` property (Android constructor default sound)
- Foreground: `dose-reminder-foreground-v1`, importance 2, **no** `sound` property (LOW → no audible alert)

Delivery-time channel selection (native):

- `native-android/dose-reminder/DoseReminderAlarmReceiver.java` selects the notification channel from the current `AppForegroundState`.
- Fresh process: `AppForegroundState` defaults to **false** → background channel.
- The receiver posts directly through `NotificationRuntime`; there is no separate delivery-rewrite layer.

Package ID: `app.drugtracker`

## Prerequisites

- Android **12+** device or emulator preferred (API 31+; exact-alarm and channel behavior are most relevant here). API 26+ is the minimum for notification channels.
- Android SDK platform-tools (`adb` on `PATH`).
- Debug APK built from this repository (see `BUILD_APK.md`):
  - `npm run build` → `npx cap sync android` → `node scripts/prepare-android.mjs` → `cd android && ./gradlew assembleDebug`
- Notification permission **granted** for the app.
- Exact alarms allowed where the OS requires it (Settings → Apps → Drug Tracker → Alarms & reminders).
- Device **not** in Do Not Disturb; media/notification volume **audible**; ringer not fully silent if you need to hear the system notification sound.
- Unlock the device and keep the screen on for delivery observation when testing killed-process delivery.

## Clean-state setup (channel immutability)

Android **does not** update channel sound/importance after first creation. Source changes alone do **not** refresh an existing channel.

Before every formal validation pass, reset channels:

```bash
# Preferred: full uninstall removes all app notification channels
adb uninstall app.drugtracker

# Install a freshly built debug APK
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Alternative (keeps package, clears data including channels on most OEMs):

```bash
adb shell pm clear app.drugtracker
```

Then launch the app **once** so `initNativeBridge()` creates channels, and grant notification (and exact-alarm) permissions.

Confirm channels exist **before** scenario tests:

```bash
adb shell dumpsys notification --noredact | grep -A 30 'app.drugtracker'
```

Or open: **Settings → Apps → Drug Tracker → Notifications** and inspect each channel’s name/importance/sound.

### What to record for each channel

**`dose-reminder-v3`**

- Exists under package `app.drugtracker`
- Importance: HIGH / 4 (or “Urgent” / “High” in UI wording)
- Visibility: public (if exposed)
- Sound: **not** a custom app WAV (e.g. not `dose_reminder`); system default / “Default” is expected when the app omits `sound` at create time
- User has not muted the channel

**`dose-reminder-foreground-v1`**

- Exists
- Importance: LOW / 2
- Silent / no sound in practice when used for foreground dose reminders

## Controlled triggers (avoid long real schedules)

Prefer short, deterministic triggers over waiting for a real dose time.

### A. In-app test notification (schedule-time channel only)

Settings → send test notification (`sendTestAlertNotification`).

This uses `getDoseReminderChannelId()` at **schedule** time (JS lifecycle tracker). It is useful for a quick smoke check of permission + basic delivery, but it does **not** fully exercise the native `DoseReminderAlarmReceiver` delivery-time channel selection after process death.

- Foreground: open app → send test → expect silent/low channel behavior.
- Background: open app, Home to background, send test via an already-open path only if still reachable; otherwise use a scheduled dose (B).

### B. Near-future dose reminder (preferred for publisher path)

1. Add a medication with reminder enabled and a `doseSchedule` / `reminderTime` set to **1–2 minutes** from now.
2. Ensure notifications + exact alarm are granted.
3. Leave the app in the state required by the case (foreground / background / force-stop).
4. Wait for the alarm; do not keep changing clock mid-test unless you document time changes carefully.

### C. Optional: schedule via existing Capacitor APIs in a local debug build

Only if you already use a local debug helper—**do not** land production-only backdoors. Prefer (B).

## Test matrix

Fill **Result** only after real device/emulator observation. Leave blank or `NOT EXECUTED` when blocked.

| Scenario | Expected channel | Expected importance | Expected sound | Result |
| -------- | ---------------- | ------------------- | -------------- | ------ |
| Foreground | `dose-reminder-foreground-v1` | LOW | Silent | |
| Background | `dose-reminder-v3` | HIGH | Default/system audible | |
| Killed process | `dose-reminder-v3` | HIGH | Default/system audible | |

## Scenario procedures

### Case 1 — App foreground

1. Clean install / clear data; launch app; grant permissions; confirm channels.
2. Keep Drug Tracker **visible** (onResume → `AppForegroundState` true).
3. Trigger a controlled dose reminder (near-future schedule) while the UI stays in the foreground.
4. When the notification posts:
   - Shade / heads-up should be low-priority; **no** system notification sound from the channel (in-app chime may still play via JS—that is separate and expected for foreground UX).
5. Inspect delivered notification channel (see Inspection commands).
6. **Pass if** channel ID is `dose-reminder-foreground-v1` and no system channel sound is heard.

### Case 2 — App background (process alive)

1. Launch app; grant permissions; schedule a near-future dose reminder.
2. Press Home (do **not** force-stop). Process stays alive; `onPause` → foreground flag false. Prefer waiting long enough for any JS resume/lifecycle re-arm if the app reschedules on background.
3. On delivery:
   - Expect `dose-reminder-v3`
   - Expect HIGH importance behavior (heads-up where OEM allows)
   - Expect **audible** system notification sound under normal volume / non-DND settings
4. **Pass if** channel ID is `dose-reminder-v3` and an audible system alert is observed (document if OEM suppresses heads-up but sound still plays).

### Case 3 — Process killed

1. Launch app once (channels created); schedule a near-future dose reminder; confirm it is pending if possible.
2. Force-stop the app:

   ```bash
   adb shell am force-stop app.drugtracker
   ```

3. Do **not** reopen the app. Keep device unlocked / able to show notifications.
4. On delivery, the `DoseReminderAlarmReceiver` runs in a **fresh** process: `AppForegroundState` defaults to `false` → selects `dose-reminder-v3`.
5. **Pass if** delivered channel is `dose-reminder-v3` with background/system-alert behavior—not the foreground silent channel.

## Inspection commands

Commands vary by Android version; adjust if output shape differs. Always confirm against your API level.

### List notification channels for the app

```bash
adb shell dumpsys notification | grep -A 40 'app.drugtracker'
```

Look for channel records containing `dose-reminder-v3` and `dose-reminder-foreground-v1`, and fields such as `importance`, `sound`, `vibration`.

On some versions:

```bash
adb shell cmd notification list_channels app.drugtracker
```

(If `list_channels` is unsupported, rely on `dumpsys` + Settings UI.)

### Inspect active / recent notifications

```bash
adb shell dumpsys notification --noredact | grep -A 50 'app.drugtracker'
```

Find the posted notification entry and read its `channel=` / `channelId` (wording varies by API).

### Confirm process state

```bash
adb shell pidof app.drugtracker   # empty after force-stop
adb shell am force-stop app.drugtracker
```

### Log delivery-time rewrite (optional)

```bash
adb logcat -s Capacitor/LocalNotification:D LN:D chromium:S
```

Useful while a reminder fires; not a substitute for reading the posted notification’s channel id.

## Record for every formal run

| Field | Value |
| ----- | ----- |
| Date | |
| Device / emulator | |
| Android version / API | |
| App build (git SHA / APK path) | |
| Clean install? (uninstall or `pm clear`) | |
| Notification permission | |
| Exact-alarm permission | |
| DND / volume notes | |
| Trigger method (test button / near-future dose) | |

## What static tests already cover (not runtime proof)

- `Tests/utils/notifications.channel.test.ts` — JS channel ID selection via `setAppInForeground` / `getDoseReminderChannelId`
- `Tests/native.test.ts` — channel create arguments (mocked Capacitor)
- `DoseReminderAlarmReceiver` — selects the delivery channel from `AppForegroundState` and posts through `NotificationRuntime`
- `scripts/prepare-android.mjs` — installs the native Dose Reminder receiver/runtime sources after `cap sync`

None of the above prove OEM `NotificationManager` channel properties or delivered notification channel IDs after alarm delivery.

## Status of automated Android instrumentation

This repository does **not** currently ship an instrumentation APK test that asserts `NotificationManager` channel importance/sound on a live system image. Adding a mocked `NotificationManager` unit test would **not** count as runtime sound validation.

If instrumentation is added later, it may assert channel **existence** and **importance** only as a safety net; **audible** behavior still requires a human or instrumented audio observation on a real device/emulator.

## Honesty rule

- Compilation / Gradle success ≠ sound verified.
- “No `sound` property in createChannel” ≠ runtime proof of audible default.
- Only fill the matrix with PASS/FAIL after observing a real Android runtime.
- If no emulator/device/adb is available, mark the entire runtime section **BLOCKED / NOT EXECUTED** and keep this procedure for manual runs.
