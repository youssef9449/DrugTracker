# Capacitor Local Notifications — DrugTracker delivery override

**Pinned upstream:** `@capacitor/local-notifications@6.1.3`

## Files

| File | Role |
|------|------|
| `TimedNotificationPublisher.java` | Capacitor 6.1.3 receiver + delivery-time channel selection |
| `AppForegroundState.java` | Process-local `volatile` foreground flag (default `false`) |

App lifecycle wiring lives in `native-android/app/MainActivity.java`
(`onResume` → true, `onPause` → false).

## Behavior

At alarm delivery, if the notification is a DrugTracker dose reminder
(`extra.medicationId` or a dose-reminder channel):

| `AppForegroundState.isForeground()` | Channel |
|-------------------------------------|---------|
| `true` | `dose-reminder-foreground-v1` (silent) |
| `false` (incl. fresh process after kill) | `dose-reminder-v3` (system default sound) |

Channel rewrite uses `NotificationCompat.Builder(context, notification).setChannelId(...)`.
Only the channel changes; other notification fields are preserved by AndroidX.

Unrelated notifications (e.g. low-stock) are never rewritten.

## Install

`scripts/prepare-android.mjs` (after every `cap sync`) copies these files to:

```text
node_modules/@capacitor/local-notifications/android/src/main/java/
  com/capacitorjs/plugins/localnotifications/
    TimedNotificationPublisher.java
    AppForegroundState.java

android/app/src/main/java/app/drugtracker/MainActivity.java
```

Fails hard if destinations are missing. No string/regex patching.

## Upgrade note

When changing the pinned Capacitor Local Notifications version, re-diff
`TimedNotificationPublisher.java` against that exact upstream release and
re-apply only the minimal DrugTracker channel logic.
