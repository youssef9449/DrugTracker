package com.capacitorjs.plugins.localnotifications;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Capacitor Local Notifications 6.1.3 TimedNotificationPublisher
 * + DrugTracker delivery-time dose-reminder channel selection
 * + DrugTracker sole daily recurrence owner for dose reminders.
 *
 * Upstream base: @capacitor/local-notifications@6.1.3
 *
 * Recurrence architecture (Capacitor 6.1.3 LocalNotificationManager):
 * - schedule.at + repeats:true → AlarmManager.setRepeating with interval
 *   (at - now) — NOT used for dose reminders (wrong interval).
 * - schedule.on (DateMatch) → CRON_KEY + setExact; next via rescheduleNotificationIfNeeded.
 * - DrugTracker dose path: JS schedules a ONE-SHOT LocalNotifications.schedule {@code at}
 *   (no repeats). This class creates the next calendar-day exact alarm from
 *   extra.reminderTime and persists delivery/re-arm evidence in
 *   {@link DoseReminderRecurrenceStore} (medicationId+doseId). That is the only
 *   recurrence path for dose reminders.
 *
 * Channel rewrite (AppForegroundState) is independent of recurrence.
 * Installed by scripts/prepare-android.mjs (whole-file copy).
 */
public class TimedNotificationPublisher extends BroadcastReceiver {

    public static String NOTIFICATION_KEY = "NotificationPublisher.notification";
    public static String CRON_KEY = "NotificationPublisher.cron";


    /** Must match src/utils/notifications.ts DOSE_REMINDER_CHANNEL_ID */
    static final String DOSE_BG_CHANNEL = "dose-reminder-v3";
    /** Must match src/utils/notifications.ts DOSE_REMINDER_FOREGROUND_CHANNEL_ID */
    static final String DOSE_FG_CHANNEL = "dose-reminder-foreground-v1";

    /**
     * Restore and present notification
     */
    @Override
    public void onReceive(Context context, Intent intent) {
        NotificationManager notificationManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);

        Notification notification;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notification = intent.getParcelableExtra(NOTIFICATION_KEY, Notification.class);
        } else {
            notification = getParcelableExtraLegacy(intent, NOTIFICATION_KEY);
        }

        notification.when = System.currentTimeMillis();

        int id = intent.getIntExtra(LocalNotificationManager.NOTIFICATION_INTENT_KEY, Integer.MIN_VALUE);
        if (id == Integer.MIN_VALUE) {
            Logger.error(Logger.tags("LN"), "No valid id supplied", null);
        }
        NotificationStorage storage = new NotificationStorage(context);
        JSObject notificationJson = storage.getSavedNotificationAsJSObject(Integer.toString(id));
        LocalNotificationsPlugin.fireReceived(notificationJson);

        // DrugTracker: delivery-time channel for dose reminders only.
        notification = applyDoseReminderChannelIfNeeded(context, notification, notificationJson);

        notificationManager.notify(id, notification);
        // Sole recurrence: CRON_KEY (non-dose Capacitor on-schedule) OR dose daily.
        boolean kept = rescheduleNotificationIfNeeded(context, intent, id);
        if (!kept) {
            kept = rescheduleDoseReminderNextDay(context, intent, id, notificationJson);
        }
        if (!kept) {
            storage.deleteNotification(Integer.toString(id));
        }
    }

    @SuppressWarnings("deprecation")
    private Notification getParcelableExtraLegacy(Intent intent, String string) {
        return intent.getParcelableExtra(NOTIFICATION_KEY);
    }

    /**
     * Dose reminders only: align channel with AppForegroundState.
     * Unrelated notifications (e.g. low-stock) are returned unchanged.
     */
    Notification applyDoseReminderChannelIfNeeded(Context context, Notification notification, JSObject notificationJson) {
        if (notification == null) {
            return notification;
        }
        if (!isDoseReminderNotification(notification, notificationJson)) {
            return notification;
        }

        String currentChannel = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            currentChannel = notification.getChannelId();
        }

        String desired = resolveDoseReminderChannel(AppForegroundState.isForeground());
        if (desired.equals(currentChannel)) {
            return notification;
        }

        try {
            Notification rewritten = new NotificationCompat.Builder(context, notification)
                .setChannelId(desired)
                .build();
            Logger.debug(
                Logger.tags("LN"),
                "DrugTracker: dose reminder channel " + currentChannel + " → " + desired
            );
            return rewritten;
        } catch (Exception e) {
            Logger.error(Logger.tags("LN"), "DrugTracker: failed to rewrite dose reminder channel", e);
            return notification;
        }
    }

    /**
     * Dose reminder only when occurrence identity is present
     * (medicationId + non-empty doseId), or the notification is already on a
     * dose-reminder channel. medicationId alone (Critical Stock / low-stock)
     * is NOT a dose reminder.
     */
    static boolean isDoseReminderNotification(Notification notification, JSObject notificationJson) {
        if (notificationJson != null) {
            try {
                JSObject extra = notificationJson.getJSObject("extra");
                if (extra != null) {
                    String medId = extra.has("medicationId") ? extra.getString("medicationId") : null;
                    String doseId = extra.has("doseId") ? extra.getString("doseId") : null;
                    boolean hasMed = medId != null && !medId.isEmpty();
                    boolean hasDose = doseId != null && !doseId.trim().isEmpty();
                    if (hasMed && hasDose) {
                        return true;
                    }
                }
            } catch (Exception ignored) {
                // fall through
            }
        }
        if (notification != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String channelId = notification.getChannelId();
            return DOSE_BG_CHANNEL.equals(channelId) || DOSE_FG_CHANNEL.equals(channelId);
        }
        return false;
    }

    /** Pure channel decision for unit testing. */
    static String resolveDoseReminderChannel(boolean appForeground) {
        return appForeground ? DOSE_FG_CHANNEL : DOSE_BG_CHANNEL;
    }

    /**
     * Upstream CRON recurrence (schedule.on / DateMatch). Used for non-dose
     * notifications that set CRON_KEY. Dose reminders use
     * {@link #rescheduleDoseReminderNextDay} instead.
     */
    private boolean rescheduleNotificationIfNeeded(Context context, Intent intent, int id) {
        String dateString = intent.getStringExtra(CRON_KEY);

        if (dateString != null) {
            DateMatch date = DateMatch.fromMatchString(dateString);
            AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);

            long trigger = date.nextTrigger(new Date());
            Intent clone = (Intent) intent.clone();
            int flags = PendingIntent.FLAG_CANCEL_CURRENT;
            if (android.os.Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                flags = flags | PendingIntent.FLAG_MUTABLE;
            }
            PendingIntent pendingIntent = PendingIntent.getBroadcast(context, id, clone, flags);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                Logger.warn(
                    "Capacitor/LocalNotification",
                    "Exact alarms not allowed in user settings.  Notification scheduled with non-exact alarm."
                );
                alarmManager.set(AlarmManager.RTC, trigger, pendingIntent);
            } else {
                alarmManager.setExact(AlarmManager.RTC, trigger, pendingIntent);
            }
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy/MM/dd HH:mm:ss");
            Logger.debug(Logger.tags("LN"), "notification " + id + " will next fire at " + sdf.format(new Date(trigger)));
            return true;
        }

        return false;
    }

    /**
     * DrugTracker dose reminders: after a one-shot delivery, arm exactly one
     * next occurrence at the same local HH:MM on the next calendar day.
     * Uses the same notification id / PendingIntent request code so a concurrent
     * JS schedule with the same id replaces rather than duplicates.
     *
     * Requires notification JSON extra:
     *   doseRecurring: true
     *   reminderTime: "HH:MM"
     *   medicationId (required), doseId (required)
     *
     * Atomicity after AlarmManager.set* succeeds:
     *   NotificationStorage persist (must succeed)
     *   then {@link DoseReminderRecurrenceStore#markReArmed} for medicationId+doseId.
     * Failed persist → no markReArmed (JS can repair). Alarm still kept.
     */
    boolean rescheduleDoseReminderNextDay(
            Context context,
            Intent intent,
            int id,
            JSObject notificationJson
    ) {
        if (notificationJson == null) {
            return false;
        }
        try {
            JSObject extra = notificationJson.getJSObject("extra");
            if (extra == null) {
                return false;
            }
            if (!Boolean.TRUE.equals(extra.getBool("doseRecurring"))) {
                return false;
            }
            String reminderTime = extra.getString("reminderTime");
            if (reminderTime == null || reminderTime.indexOf(':') < 0) {
                return false;
            }
            int colon = reminderTime.indexOf(':');
            int hour = Integer.parseInt(reminderTime.substring(0, colon));
            int minute = Integer.parseInt(reminderTime.substring(colon + 1));
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                return false;
            }

            String medicationId = extra.getString("medicationId");
            if (medicationId == null || medicationId.isEmpty()) {
                Log.w("LN", "TimedNotificationPublisher: missing medicationId; skip next-day recurrence");
                return false;
            }
            String doseId = null;
            try {
                if (extra.has("doseId")) {
                    doseId = extra.getString("doseId");
                }
            } catch (Exception ignored) {
                doseId = null;
            }
            // Full occurrence identity required — no next-day arm without doseId.
            if (doseId == null || doseId.isEmpty()) {
                Log.w("LN", "TimedNotificationPublisher: missing doseId; skip next-day recurrence");
                return false;
            }

            Calendar cal = Calendar.getInstance();
            cal.add(Calendar.DAY_OF_MONTH, 1);
            cal.set(Calendar.HOUR_OF_DAY, hour);
            cal.set(Calendar.MINUTE, minute);
            cal.set(Calendar.SECOND, 0);
            cal.set(Calendar.MILLISECOND, 0);
            long trigger = cal.getTimeInMillis();

            AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarmManager == null) {
                return false;
            }
            Intent clone = (Intent) intent.clone();
            int flags = PendingIntent.FLAG_CANCEL_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                flags = flags | PendingIntent.FLAG_MUTABLE;
            }
            PendingIntent pendingIntent = PendingIntent.getBroadcast(context, id, clone, flags);
            // AlarmManager first — never persist delivery/re-arm state before success.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                Logger.warn(
                    "Capacitor/LocalNotification",
                    "Exact alarms not allowed; dose reminder scheduled inexact."
                );
                alarmManager.set(AlarmManager.RTC, trigger, pendingIntent);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pendingIntent);
            } else {
                alarmManager.setExact(AlarmManager.RTC, trigger, pendingIntent);
            }
            SimpleDateFormat sdf = new SimpleDateFormat("yyyy/MM/dd HH:mm:ss", Locale.US);
            Logger.debug(
                Logger.tags("LN"),
                "dose reminder " + id + " next day at " + sdf.format(new Date(trigger))
            );
            // Order (required atomicity):
            //   1) AlarmManager.set* already succeeded above
            //   2) NotificationStorage persist — observable success/failure
            //   3) markReArmed only if (2) succeeded
            // Never write evidence for a storage state that was not persisted.
            boolean persisted =
                    persistDoseReminderNextAt(context, id, notificationJson, trigger);
            if (persisted
                    && medicationId != null && !medicationId.isEmpty()
                    && doseId != null && !doseId.isEmpty()) {
                DoseReminderRecurrenceStore.markReArmed(
                        context, medicationId, doseId, trigger, reminderTime, id);
            } else if (!persisted) {
                Logger.error(
                    Logger.tags("LN"),
                    "dose next-day AlarmManager armed but NotificationStorage persist failed; "
                        + "no re-arm evidence written — JS may repair",
                    null
                );
            }
            // AlarmManager arm succeeded: keep notification id (do not delete storage
            // in onReceive). Missing markReArmed / past schedule.at lets JS repair.
            return true;
        } catch (Exception e) {
            Logger.error(Logger.tags("LN"), "dose next-day reschedule failed", e);
            // No markReArmed on failure — JS must detect missing alarm and repair.
            return false;
        }
    }

    /**
     * Write updated schedule.at into the plugin notification store (same file
     * NotificationStorage uses). Makes post-delivery getPending() report a
     * future occurrence for this stable dose id.
     *
     * @return true only when the SharedPreferences write committed successfully
     */
    private boolean persistDoseReminderNextAt(
            Context context,
            int id,
            JSObject notificationJson,
            long triggerMs
    ) {
        if (notificationJson == null) {
            return false;
        }
        try {
            JSObject schedule = notificationJson.getJSObject("schedule");
            if (schedule == null) {
                schedule = new JSObject();
                notificationJson.put("schedule", schedule);
            }
            // Capacitor accepts ISO-8601 / Date-parsable strings for schedule.at
            SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
            schedule.put("at", iso.format(new Date(triggerMs)));
            // Match NotificationStorage.NOTIFICATION_STORE_ID
            SharedPreferences storage =
                    context.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE);
            boolean committed =
                    storage.edit().putString(Integer.toString(id), notificationJson.toString()).commit();
            if (!committed) {
                Logger.error(Logger.tags("LN"), "persist dose next at: SharedPreferences commit failed", null);
                return false;
            }
            return true;
        } catch (Exception e) {
            Logger.error(Logger.tags("LN"), "persist dose next at failed", e);
            return false;
        }
    }
}
