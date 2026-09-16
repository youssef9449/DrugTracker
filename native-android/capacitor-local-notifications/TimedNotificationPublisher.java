package com.capacitorjs.plugins.localnotifications;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import java.text.SimpleDateFormat;
import java.util.Date;

/**
 * Capacitor Local Notifications 6.1.3 TimedNotificationPublisher
 * + DrugTracker delivery-time dose-reminder channel selection.
 *
 * Upstream base: @capacitor/local-notifications@6.1.3
 * (package/android/.../TimedNotificationPublisher.java)
 *
 * DrugTracker addition: after fireReceived, dose reminders may be rewritten
 * onto the channel that matches AppForegroundState (process-local, set from
 * MainActivity onResume/onPause). Fresh process defaults to background →
 * dose-reminder-v3 so killed-process reminders produce the system sound.
 *
 * Channel change uses NotificationCompat.Builder(context, notification)
 * so existing notification fields are preserved; only setChannelId is applied.
 *
 * Installed by scripts/prepare-android.mjs (whole-file copy, not a string patch).
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
        if (!rescheduleNotificationIfNeeded(context, intent, id)) {
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
     * DrugTracker dose reminder if extra.medicationId is set, or the
     * notification is already on a dose-reminder channel.
     */
    static boolean isDoseReminderNotification(Notification notification, JSObject notificationJson) {
        if (notificationJson != null) {
            try {
                JSObject extra = notificationJson.getJSObject("extra");
                if (extra != null && extra.has("medicationId") && extra.getString("medicationId") != null) {
                    return true;
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
     * Sole native recurrence owner for notifications scheduled with CRON_KEY
     * (Capacitor repeats:true / every). JS lifecycle must not also create the
     * next occurrence for the same notification id — that produced duplicates.
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
}
