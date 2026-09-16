# Capacitor Local Notifications — DrugTracker delivery override

**Pinned upstream:** `@capacitor/local-notifications@6.1.3`

## Files

| File | Role |
|------|------|
| `TimedNotificationPublisher.java` | Capacitor 6.1.3 receiver + delivery-time channel selection + next-day dose re-arm |
| `AppForegroundState.java` | Process-local `volatile` foreground flag (default `false`) |
| `DoseReminderRecurrenceStore.java` | Occurrence-scoped delivery evidence; valid only while NOTIFICATION_STORE still holds matching future schedule.at |

App lifecycle wiring lives in `native-android/app/MainActivity.java`
(`onResume` → true, `onPause` → false). Query bridge: `DoseReminderPlugin`
(`native-android/dose-reminder/`).

## Dose recurrence

```text
JS → initial ONE-SHOT LocalNotifications.schedule (no repeats)
TimedNotificationPublisher → next calendar-day AlarmManager arm
DoseReminderRecurrenceStore → occurrence evidence (after AlarmManager+NotificationStorage persist); invalid when storage gone, config mismatches, or occurrence spent
```

JS reconciliation must not treat `getPending() === false` alone as “needs repair”
during delivery: check `isNativeDoseReminderReArmed` (this store) as well.

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
    DoseReminderRecurrenceStore.java

android/app/src/main/java/app/drugtracker/MainActivity.java
android/app/src/main/java/app/drugtracker/dosereminder/DoseReminderPlugin.java
```

Fails hard if destinations are missing. No string/regex patching.

## Upgrade note

When changing the pinned Capacitor Local Notifications version, re-diff
`TimedNotificationPublisher.java` against that exact upstream release and
re-apply only the minimal DrugTracker channel + dose recurrence logic.
