# Capacitor Local Notifications — DrugTracker delivery override

## Purpose

Capacitor binds Android `channelId` when a local notification is **scheduled**.
JS lifecycle reconciliation (`setAppInForeground` + cancel/reschedule) is the
fast path, but cannot guarantee correct channel selection if the process is
killed before async reschedule completes.

This directory owns a modified `TimedNotificationPublisher` that re-selects
the dose-reminder channel at **delivery** time based on process importance:

| Process state | Channel |
|---|---|
| Foreground / visible | `dose-reminder-foreground-v1` (silent) |
| Background / unknown / killed | `dose-reminder-v3` (system default sound) |

Only notifications identified as DrugTracker dose reminders
(`extra.medicationId` or already on a dose-reminder channel) are rewritten.
All other notifications are untouched.

Channel changes use `NotificationCompat.Builder(context, existingNotification)`
so the platform copies the existing notification; only `setChannelId` is applied.

## How it is installed

`scripts/prepare-android.mjs` (runs after every `cap sync` via package.json
scripts) **copies** this file over:

```text
node_modules/@capacitor/local-notifications/android/src/main/java/
  com/capacitorjs/plugins/localnotifications/TimedNotificationPublisher.java
```

This is a whole-file vendor override for `@capacitor/local-notifications`
**6.1.x**, not a runtime string patch of dependency source.

If the Capacitor plugin source is missing, prepare-android **exits non-zero**.

## Upstream base

Based on Capacitor Local Notifications 6.1.x `TimedNotificationPublisher`.
When upgrading `@capacitor/local-notifications`, re-diff this file against the
new upstream class and re-apply the dose-reminder channel logic.

## Manual device checks

1. Foreground: silent Android notification + DoseAlarmModal + JS chime
2. Background: system default notification sound via v3
3. Schedule while foreground → background → kill process before reschedule →
   reminder should still sound via v3 (delivery-time rewrite)
4. Background → reopen → later dose: silent + modal/chime
