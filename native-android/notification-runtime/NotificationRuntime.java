package app.drugtracker.notificationruntime;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;
/**
 * Shared Android notification-delivery runtime.
 *
 * <p>This class owns notification presentation only:
 * channels, posting, cancellation, stable notification tags, and generic
 * action delivery. It never schedules AlarmManager alarms and contains no
 * Dose Reminder / Critical Stock / Auto Deduction business policy.</p>
 */
public final class NotificationRuntime {
    public static final String ACTION_NOTIFICATION_POSTED =
            "app.drugtracker.notificationruntime.NOTIFICATION_POSTED";
    public static final String EXTRA_NAMESPACE = "notificationNamespace";
    public static final String EXTRA_IDENTITY = "notificationIdentity";
    public static final String EXTRA_ACTION_ID = "notificationActionId";

    private static final int NOTIFICATION_ID = 1;

    private final Context appContext;

    public NotificationRuntime(Context context) {
        appContext = context.getApplicationContext();
    }

    public boolean areNotificationsEnabled() {
        return NotificationManagerCompat.from(appContext).areNotificationsEnabled();
    }

    public boolean isChannelEnabled(String channelId) {
        if (channelId == null || channelId.isEmpty()) return false;
        if (!areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager manager = notificationManager();
        if (manager == null) return false;
        NotificationChannel channel = manager.getNotificationChannel(channelId);
        return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    public PostResult post(Request request) {
        if (request == null
                || request.namespace == null || request.namespace.isEmpty()
                || request.identity == null || request.identity.isEmpty()
                || request.title == null
                || request.body == null
                || request.channelId == null || request.channelId.isEmpty()) {
            return PostResult.failed("invalid_request");
        }
        if (!areNotificationsEnabled()) {
            return PostResult.failed("notifications_disabled");
        }

        try {
            ensureChannel(
                    request.channelId,
                    request.channelName,
                    request.channelImportance,
                    request.channelVisibility);

            Notification notification = buildNotification(request);
            NotificationManager manager = notificationManager();
            if (manager == null) {
                return PostResult.failed("notification_manager_unavailable");
            }

            manager.notify(
                    tagFor(request.namespace, request.identity),
                    NOTIFICATION_ID,
                    notification);

            Intent event = new Intent(ACTION_NOTIFICATION_POSTED);
            event.setPackage(appContext.getPackageName());
            event.putExtra(EXTRA_NAMESPACE, request.namespace);
            event.putExtra(EXTRA_IDENTITY, request.identity);
            appContext.sendBroadcast(event);
            return PostResult.accepted();
        } catch (SecurityException e) {
            return PostResult.failed("notification_security_exception");
        } catch (Exception e) {
            return PostResult.failed("notification_post_failed");
        }
    }

    public CancelResult cancel(String namespace, String identity) {
        if (namespace == null || namespace.isEmpty()
                || identity == null || identity.isEmpty()) {
            return CancelResult.failed("invalid_request");
        }
        try {
            NotificationManager manager = notificationManager();
            if (manager == null) {
                return CancelResult.failed("notification_manager_unavailable");
            }
            manager.cancel(tagFor(namespace, identity), NOTIFICATION_ID);
            return CancelResult.accepted();
        } catch (SecurityException e) {
            return CancelResult.failed("notification_security_exception");
        } catch (Exception e) {
            return CancelResult.failed("notification_cancel_failed");
        }
    }

    private Notification buildNotification(Request request) {
        PendingIntent contentIntent = buildActionIntent(
                request.namespace,
                request.identity,
                null,
                false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder builder =
                    new Notification.Builder(appContext, request.channelId)
                            .setSmallIcon(resolveSmallIcon(request.smallIcon))
                            .setContentTitle(request.title)
                            .setContentText(request.body)
                            .setAutoCancel(request.autoCancel)
                            .setOngoing(request.ongoing)
                            .setContentIntent(contentIntent);

            if (request.action != null) {
                PendingIntent actionIntent = buildActionIntent(
                        request.namespace,
                        request.identity,
                        request.action.id,
                        request.action.foreground);
                builder.addAction(
                        0,
                        request.action.title,
                        actionIntent);
            }
            return builder.build();
        }

        Notification.Builder builder =
                new Notification.Builder(appContext)
                        .setSmallIcon(resolveSmallIcon(request.smallIcon))
                        .setContentTitle(request.title)
                        .setContentText(request.body)
                        .setAutoCancel(request.autoCancel)
                        .setOngoing(request.ongoing)
                        .setDefaults(request.channelImportance <= 2
                                ? 0
                                : Notification.DEFAULT_ALL)
                        .setPriority(request.channelImportance <= 2
                                ? Notification.PRIORITY_LOW
                                : Notification.PRIORITY_HIGH)
                        .setContentIntent(contentIntent);

        if (request.action != null) {
            PendingIntent actionIntent = buildActionIntent(
                    request.namespace,
                    request.identity,
                    request.action.id,
                    request.action.foreground);
            builder.addAction(
                    0,
                    request.action.title,
                    actionIntent);
        }
        return builder.build();
    }

    private PendingIntent buildActionIntent(
            String namespace,
            String identity,
            String actionId,
            boolean foreground) {
        Intent intent = new Intent(
                appContext,
                NotificationRuntimeActionReceiver.class);
        intent.setAction("app.drugtracker.notificationruntime.ACTION");
        intent.setData(
                android.net.Uri.parse(
                        "content://app.drugtracker.notification/action/"
                                + encodeSegment(namespace)
                                + "/"
                                + encodeSegment(identity)
                                + "/"
                                + encodeSegment(actionId == null ? "" : actionId)));
        intent.putExtra(EXTRA_NAMESPACE, namespace);
        intent.putExtra(EXTRA_IDENTITY, identity);
        if (actionId != null && !actionId.isEmpty()) {
            intent.putExtra(EXTRA_ACTION_ID, actionId);
        }
        intent.putExtra(
                NotificationRuntimeActionReceiver.EXTRA_FOREGROUND,
                foreground);

        // Full Intent data URI participates in PendingIntent identity, so the
        // request code is deliberately constant and never acts as identity.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(
                appContext,
                1,
                intent,
                flags);
    }

    private void ensureChannel(
            String channelId,
            String channelName,
            int importance,
            int visibility) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = notificationManager();
        if (manager == null) return;
        if (manager.getNotificationChannel(channelId) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                channelId,
                channelName == null || channelName.isEmpty()
                        ? channelId
                        : channelName,
                importance);
        channel.setLockscreenVisibility(visibility);
        manager.createNotificationChannel(channel);
    }

    private int resolveSmallIcon(String requested) {
        String name = requested == null || requested.isEmpty()
                ? "ic_launcher"
                : requested;
        int drawable = appContext.getResources().getIdentifier(
                name,
                "drawable",
                appContext.getPackageName());
        if (drawable != 0) return drawable;
        int mipmap = appContext.getResources().getIdentifier(
                name,
                "mipmap",
                appContext.getPackageName());
        if (mipmap != 0) return mipmap;
        return appContext.getApplicationInfo().icon;
    }

    private NotificationManager notificationManager() {
        return (NotificationManager) appContext.getSystemService(
                Context.NOTIFICATION_SERVICE);
    }

    /** Full namespace + logical identity is the notification authority. */
    public static String notificationTag(String namespace, String identity) {
        return namespace + ":" + identity;
    }

    private static String tagFor(String namespace, String identity) {
        return namespace + ":" + identity;
    }

    private static String encodeSegment(String value) {
        return android.net.Uri.encode(value == null ? "" : value);
    }

    public static final class Request {
        public final String namespace;
        public final String identity;
        public final String title;
        public final String body;
        public final String channelId;
        public final String channelName;
        public final int channelImportance;
        public final int channelVisibility;
        public final String smallIcon;
        public final boolean autoCancel;
        public final boolean ongoing;
        public final Action action;

        public Request(
                String namespace,
                String identity,
                String title,
                String body,
                String channelId,
                String channelName,
                int channelImportance,
                int channelVisibility,
                String smallIcon,
                boolean autoCancel,
                boolean ongoing,
                Action action) {
            this.namespace = namespace;
            this.identity = identity;
            this.title = title;
            this.body = body;
            this.channelId = channelId;
            this.channelName = channelName;
            this.channelImportance = channelImportance;
            this.channelVisibility = channelVisibility;
            this.smallIcon = smallIcon;
            this.autoCancel = autoCancel;
            this.ongoing = ongoing;
            this.action = action;
        }
    }

    public static final class Action {
        public final String id;
        public final String title;
        public final boolean foreground;

        public Action(String id, String title, boolean foreground) {
            this.id = id;
            this.title = title;
            this.foreground = foreground;
        }
    }

    public static final class CancelResult {
        public final boolean accepted;
        public final String error;

        private CancelResult(boolean accepted, String error) {
            this.accepted = accepted;
            this.error = error;
        }

        public static CancelResult accepted() {
            return new CancelResult(true, null);
        }

        public static CancelResult failed(String error) {
            return new CancelResult(false, error);
        }
    }

    public static final class PostResult {
        public final boolean accepted;
        public final String error;

        private PostResult(boolean accepted, String error) {
            this.accepted = accepted;
            this.error = error;
        }

        public static PostResult accepted() {
            return new PostResult(true, null);
        }

        public static PostResult failed(String error) {
            return new PostResult(false, error);
        }
    }
}
