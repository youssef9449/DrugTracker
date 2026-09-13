package com.capacitorjs.plugins.localnotifications;

import android.app.ActivityManager;
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
 * DrugTracker-owned delivery path for Capacitor scheduled local notifications.
 *
 * Vendored from @capacitor/local-notifications (6.1.x) TimedNotificationPublisher
 * and extended with delivery-time dose-reminder channel selection.
 *
 * Why this file exists:
 * Capacitor binds Android channelId when the Notification is built at schedule
 * time. JS cancel+reschedule on appStateChange is the fast path, but if the
 * process is killed before that async work completes, a silent
 * dose-reminder-foreground-v1 notification can survive and fire with no system
 * sound. This receiver re-selects the channel at DELIVERY time based on the
 * current process importance so killed-process reminders use dose-reminder-v3.
 *
 * Deployment:
 * scripts/prepare-android.mjs copies this file over the Capacitor plugin source
 * under node_modules after every `cap sync`. It is a whole-file vendor override
 * (not a string patch). Fail the prepare step if the target is missing.
 *
 * Channel IDs must stay in sync with src/utils/notifications.ts:
 *   DOSE_REMINDER_CHANNEL_ID            = dose-reminder-v3
 *   DOSE_REMINDER_FOREGROUND_CHANNEL_ID  = dose-reminder-foreground-v1
 *
 * Unrelated notifications (e.g. low-stock) are left completely untouched.
 */
public class TimedNotificationPublisher extends BroadcastReceiver {

    public static String NOTIFICATION_KEY = "NotificationPublisher.notification";
    public static String CRON_KEY = "NotificationPublisher.cron";

    /** Must match src/utils/notifications.ts DOSE_REMINDER_CHANNEL_ID */
    static final String DOSE_BG_CHANNEL = "dose-reminder-v3";
    /** Must match src/utils/notifications.ts DOSE_REMINDER_FOREGROUND_CHANNEL_ID */
    static final String DOSE_FG_CHANNEL = "dose-reminder-foreground-v1";

    /**
     * Restore and present notification.
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

        // DrugTracker: delivery-time channel safeguard for dose reminders only.
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
     * If this is a DrugTracker dose reminder, ensure the channel matches the
     * current process foreground state. Uses NotificationCompat.Builder's
     * copy constructor so all existing Notification fields are preserved;
     * only the channel id is changed when necessary.
     *
     * Package-visible helpers below exist so the decision logic can be reasoned
     * about without reconstructing Android framework objects in documentation.
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

        boolean foreground = isProcessInForeground();
        String desired = resolveDoseReminderChannel(foreground);

        if (desired.equals(currentChannel)) {
            return notification;
        }

        try {
            // Platform-supported equivalent rebuild: copies the existing
            // Notification then overrides only the channel id.
            Notification rewritten = new NotificationCompat.Builder(context, notification)
                .setChannelId(desired)
                .build();
            Logger.debug(
                Logger.tags("LN"),
                "DrugTracker: dose reminder channel " + currentChannel + " → " + desired + " (foreground=" + foreground + ")"
            );
            return rewritten;
        } catch (Exception e) {
            Logger.error(Logger.tags("LN"), "DrugTracker: failed to rewrite dose reminder channel", e);
            return notification;
        }
    }

    /**
     * Identify DrugTracker dose reminders via existing metadata only:
     * - extra.medicationId (set by scheduleDoseReminder / scheduleSnoozedDoseReminder)
     * - or already on one of the two dose-reminder channels
     */
    static boolean isDoseReminderNotification(Notification notification, JSObject notificationJson) {
        if (notificationJson != null) {
            try {
                JSObject extra = notificationJson.getJSObject("extra");
                if (extra != null && extra.has("medicationId") && extra.getString("medicationId") != null) {
                    return true;
                }
            } catch (Exception ignored) {
                // fall through to channel check
            }
        }
        if (notification != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String channelId = notification.getChannelId();
            return DOSE_BG_CHANNEL.equals(channelId) || DOSE_FG_CHANNEL.equals(channelId);
        }
        return false;
    }

    /**
     * Pure channel decision used at delivery time.
     * Non-foreground (including unknown / killed) → sound-capable v3.
     */
    static String resolveDoseReminderChannel(boolean processForeground) {
        return processForeground ? DOSE_FG_CHANNEL : DOSE_BG_CHANNEL;
    }

    /**
     * Process importance check. On failure, returns false so we prefer the
     * sound-capable channel (safer for killed-process reminders).
     */
    static boolean isProcessInForeground() {
        try {
            ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(info);
            return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                || info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
        } catch (Exception e) {
            return false;
        }
    }

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
