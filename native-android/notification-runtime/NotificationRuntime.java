package app.drugtracker.notificationruntime;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

import androidx.core.app.NotificationManagerCompat;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
/**
 * Shared Android notification-delivery runtime.
 *
 * <p>This class owns notification presentation only:
 * channels, posting, cancellation, stable notification tags, and generic
 * action delivery. It never schedules platform alarms and contains no
 * Dose Reminder / Critical Stock / Auto Deduction business policy.</p>
 */
public final class NotificationRuntime {
    private static final String TAG = "NotificationRuntime";
    public static final String ACTION_NOTIFICATION_POSTED =
            "app.drugtracker.notificationruntime.NOTIFICATION_POSTED";
    public static final String ACTION_ACTION_PERFORMED =
            "app.drugtracker.notificationruntime.ACTION_PERFORMED";
    public static final String EXTRA_NAMESPACE = "notificationNamespace";
    public static final String EXTRA_IDENTITY = "notificationIdentity";
    public static final String EXTRA_ACTION_ID = "notificationActionId";

    private static final int NOTIFICATION_ID = 1;
    private static final String RETRY_PREFS =
            "drugtracker_notification_delivery_retry_v2";
    private static final String RETRY_ENTRY_PREFIX = "entry:";
    private static final int MAX_RETRY_ENTRIES = 64;
    private static final long MAX_RETRY_AGE_MS =
            7L * 24L * 60L * 60L * 1000L;
    private static final Object RETRY_LOCK = new Object();

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
        return postInternal(request, true);
    }

    /**
     * Common delivery implementation (#533): permission checks, channel
     * setup/validation, manager lookup, notify(), and the delivery broadcast
     * exist in exactly ONE path. The only parameterized difference is the
     * retry-persistence policy: the public post() persists failed deliveries
     * for later retry; the retry replay path must not re-persist.
     *
     * #511: when delivery fails AND the retry evidence itself cannot be
     * stored, the result carries that distinction explicitly
     * ({@code retryEvidence == FAILED}) instead of swallowing it.
     */
    private PostResult postInternal(Request request, boolean persistRetryOnFailure) {
        if (request == null
                || request.namespace == null || request.namespace.isEmpty()
                || request.identity == null || request.identity.isEmpty()
                || request.title == null
                || request.body == null
                || request.channelId == null || request.channelId.isEmpty()) {
            return PostResult.failed("invalid_request");
        }
        if (!areNotificationsEnabled()) {
            return failedWithRetryPolicy(request, "notifications_disabled", persistRetryOnFailure);
        }

        try {
            ensureChannel(
                    request.channelId,
                    request.channelName,
                    request.channelImportance,
                    request.channelVisibility);

            if (!isChannelEnabled(request.channelId)) {
                return failedWithRetryPolicy(request, "notification_channel_disabled", persistRetryOnFailure);
            }

            Notification notification = buildNotification(request);
            NotificationManager manager = notificationManager();
            if (manager == null) {
                return failedWithRetryPolicy(request, "notification_manager_unavailable", persistRetryOnFailure);
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
            clearRetry(request.namespace, request.identity);
            return PostResult.accepted();
        } catch (SecurityException e) {
            return failedWithRetryPolicy(request, "notification_security_exception", persistRetryOnFailure);
        } catch (Exception e) {
            return failedWithRetryPolicy(request, "notification_post_failed", persistRetryOnFailure);
        }
    }

    /** Fail a delivery, applying the caller's retry-persistence policy (#533). */
    private PostResult failedWithRetryPolicy(
            Request request,
            String error,
            boolean persistRetryOnFailure) {
        if (!persistRetryOnFailure) {
            return PostResult.failed(error);
        }
        RetryPersistResult persisted = persistRetry(request);
        return PostResult.failed(error, persisted.ok
                ? PostResult.RetryEvidenceState.STORED
                : PostResult.RetryEvidenceState.FAILED);
    }

    /**
     * Persist a failed delivery for a later retry.
     *
     * #511: serialization/persistence failures are NOT silently discarded —
     * the structured outcome lets the caller distinguish "retry scheduled"
     * from "delivery failed and retry evidence could not be stored".
     *
     * #520 privacy boundary: the retry record stores the MINIMUM fields
     * needed for native reconstruction (namespace+identity routing, channel
     * id/importance, presentation title/body, action routing). Notification
     * text may contain health-related content; it cannot be reconstructed
     * natively after process death, so the presentation is retained here
     * under the app's private storage. No extras or redundant metadata
     * (channel display name is not persisted — the channel already exists at
     * OS level and is reused during replay). Retention: bounded by
     * MAX_RETRY_ENTRIES + MAX_RETRY_AGE_MS eviction.
     */
    public RetryPersistResult persistRetry(Request request) {
        if (request == null || request.namespace == null || request.namespace.isEmpty()
                || request.identity == null || request.identity.isEmpty()) {
            return RetryPersistResult.failed("invalid_retry_request");
        }

        final long now = System.currentTimeMillis();
        final String entryKey = retryEntryKey(request.namespace, request.identity);

        try {
            JSONObject entry = serializeRequest(request);
            entry.put("queuedAtEpochMs", now);
            entry.put("retryToken", UUID.randomUUID().toString());
            String serialized = entry.toString();

            synchronized (RETRY_LOCK) {
                SharedPreferences prefs =
                        appContext.getSharedPreferences(RETRY_PREFS, Context.MODE_PRIVATE);
                Map<String, ?> all = prefs.getAll();
                SharedPreferences.Editor editor = prefs.edit();
                List<RetryCandidate> candidates = new ArrayList<>();
                boolean currentExists = false;

                for (Map.Entry<String, ?> stored : all.entrySet()) {
                    if (!stored.getKey().startsWith(RETRY_ENTRY_PREFIX)) continue;
                    if (stored.getKey().equals(entryKey)) {
                        currentExists = true;
                        continue;
                    }

                    Long queuedAt = readQueuedAt(stored.getValue());
                    String retryToken = readRetryToken(stored.getValue());
                    if (queuedAt == null
                            || retryToken == null
                            || now - queuedAt.longValue() > MAX_RETRY_AGE_MS) {
                        editor.remove(stored.getKey());
                        continue;
                    }
                    candidates.add(new RetryCandidate(
                            stored.getKey(),
                            queuedAt.longValue(),
                            retryToken));
                }

                if (!currentExists) {
                    candidates.sort((a, b) -> Long.compare(a.queuedAtEpochMs, b.queuedAtEpochMs));
                    while (candidates.size() >= MAX_RETRY_ENTRIES && !candidates.isEmpty()) {
                        RetryCandidate oldest = candidates.remove(0);
                        editor.remove(oldest.key);
                    }
                }

                editor.putString(entryKey, serialized).apply();
            }
            return RetryPersistResult.stored();
        } catch (JSONException e) {
            // #511: observable persistence failure — never silently ignored.
            Log.e(TAG, "retry persistence failed", e);
            return RetryPersistResult.failed("retry_persist_failed");
        }
    }

    public int retryPersistedFailures() {
        final long now = System.currentTimeMillis();
        final List<RetryCandidate> candidates = new ArrayList<>();

        synchronized (RETRY_LOCK) {
            SharedPreferences prefs =
                    appContext.getSharedPreferences(RETRY_PREFS, Context.MODE_PRIVATE);
            SharedPreferences.Editor cleanup = prefs.edit();

            for (Map.Entry<String, ?> stored : prefs.getAll().entrySet()) {
                if (!stored.getKey().startsWith(RETRY_ENTRY_PREFIX)) continue;
                Long queuedAt = readQueuedAt(stored.getValue());
                String retryToken = readRetryToken(stored.getValue());
                if (queuedAt == null
                        || retryToken == null
                        || now - queuedAt.longValue() > MAX_RETRY_AGE_MS) {
                    cleanup.remove(stored.getKey());
                    continue;
                }
                candidates.add(new RetryCandidate(
                        stored.getKey(),
                        queuedAt.longValue(),
                        retryToken));
            }
            cleanup.apply();
        }

        candidates.sort((a, b) -> Long.compare(a.queuedAtEpochMs, b.queuedAtEpochMs));
        int accepted = 0;
        for (RetryCandidate candidate : candidates) {
            Request request = readRetryRequest(candidate.key);
            if (request == null) {
                removeRetryKey(candidate.key, candidate.retryToken);
                continue;
            }
            PostResult result = postWithoutPersistingRetry(request);
            if (result.accepted && clearRetryIfUnchanged(candidate.key, candidate.retryToken)) {
                accepted++;
            }
        }
        return accepted;
    }

    private PostResult postWithoutPersistingRetry(Request request) {
        return postInternal(request, false);
    }

    private JSONObject serializeRequest(Request request) throws JSONException {
        // #520: minimum durable fields for reconstruction; the channel display
        // name is NOT persisted (the OS channel already exists and is reused).
        JSONObject item = new JSONObject();
        item.put("namespace", request.namespace);
        item.put("identity", request.identity);
        item.put("title", request.title);
        item.put("body", request.body);
        item.put("channelId", request.channelId);
        item.put("channelImportance", request.channelImportance);
        item.put("channelVisibility", request.channelVisibility);
        item.put("smallIcon", request.smallIcon);
        item.put("autoCancel", request.autoCancel);
        item.put("ongoing", request.ongoing);
        if (request.action != null) {
            JSONObject action = new JSONObject();
            action.put("id", request.action.id);
            action.put("title", request.action.title);
            action.put("foreground", request.action.foreground);
            item.put("action", action);
        }
        return item;
    }

    private Request deserializeRequest(JSONObject item) {
        if (item == null) return null;
        try {
            JSONObject actionJson = item.optJSONObject("action");
            Action action = actionJson == null ? null : new Action(
                    actionJson.optString("id", ""),
                    actionJson.optString("title", ""),
                    actionJson.optBoolean("foreground", false));
            return new Request(
                    item.getString("namespace"),
                    item.getString("identity"),
                    item.getString("title"),
                    item.getString("body"),
                    item.getString("channelId"),
                    // #520: channelName is not persisted; replay reuses the
                    // existing OS channel (display name unchanged after creation).
                    item.optString("channelId", ""),
                    item.optInt("channelImportance", 4),
                    item.optInt("channelVisibility", 1),
                    item.optString("smallIcon", "ic_launcher"),
                    item.optBoolean("autoCancel", true),
                    item.optBoolean("ongoing", false),
                    action);
        } catch (JSONException e) {
            return null;
        }
    }

    private void clearRetry(String namespace, String identity) {
        if (namespace == null || identity == null) return;
        removeRetryKey(retryEntryKey(namespace, identity), null);
    }

    private void removeRetryKey(String entryKey, String expectedRetryToken) {
        synchronized (RETRY_LOCK) {
            SharedPreferences prefs =
                    appContext.getSharedPreferences(RETRY_PREFS, Context.MODE_PRIVATE);
            if (expectedRetryToken != null) {
                String currentRetryToken = readRetryToken(
                        prefs.getString(entryKey, null));
                if (currentRetryToken == null
                        || !currentRetryToken.equals(expectedRetryToken)) {
                    return;
                }
            }
            prefs.edit().remove(entryKey).apply();
        }
    }

    private boolean clearRetryIfUnchanged(
            String entryKey,
            String expectedRetryToken) {
        synchronized (RETRY_LOCK) {
            SharedPreferences prefs =
                    appContext.getSharedPreferences(RETRY_PREFS, Context.MODE_PRIVATE);
            String currentRetryToken = readRetryToken(
                    prefs.getString(entryKey, null));
            if (currentRetryToken == null
                    || !currentRetryToken.equals(expectedRetryToken)) {
                return false;
            }
            prefs.edit().remove(entryKey).apply();
            return true;
        }
    }

    private Request readRetryRequest(String entryKey) {
        synchronized (RETRY_LOCK) {
            SharedPreferences prefs =
                    appContext.getSharedPreferences(RETRY_PREFS, Context.MODE_PRIVATE);
            String raw = prefs.getString(entryKey, null);
            if (raw == null) return null;
            try {
                return deserializeRequest(new JSONObject(raw));
            } catch (JSONException e) {
                return null;
            }
        }
    }

    private Long readQueuedAt(Object raw) {
        if (!(raw instanceof String)) return null;
        try {
            long value = new JSONObject((String) raw).optLong(
                    "queuedAtEpochMs", Long.MIN_VALUE);
            return value > 0L ? Long.valueOf(value) : null;
        } catch (JSONException e) {
            return null;
        }
    }

    private String readRetryToken(Object raw) {
        if (!(raw instanceof String)) return null;
        try {
            String value = new JSONObject((String) raw).optString(
                    "retryToken", "").trim();
            return value.isEmpty() ? null : value;
        } catch (JSONException e) {
            return null;
        }
    }

    private static String retryEntryKey(String namespace, String identity) {
        String value = namespace + "\u0000" + identity;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(RETRY_ENTRY_PREFIX);
            for (byte b : hash) {
                result.append(String.format("%02x", b & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static final class RetryCandidate {
        final String key;
        final long queuedAtEpochMs;
        final String retryToken;

        RetryCandidate(String key, long queuedAtEpochMs, String retryToken) {
            this.key = key;
            this.queuedAtEpochMs = queuedAtEpochMs;
            this.retryToken = retryToken;
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
        /** Distinguishes delivery-failure outcomes with persisted retry evidence (#511). */
        public enum RetryEvidenceState { NOT_ATTEMPTED, STORED, FAILED }

        public final boolean accepted;
        public final String error;
        public final RetryEvidenceState retryEvidence;

        private PostResult(boolean accepted, String error, RetryEvidenceState retryEvidence) {
            this.accepted = accepted;
            this.error = error;
            this.retryEvidence = retryEvidence;
        }

        public static PostResult accepted() {
            return new PostResult(true, null, RetryEvidenceState.NOT_ATTEMPTED);
        }

        public static PostResult failed(String error) {
            return new PostResult(false, error, RetryEvidenceState.NOT_ATTEMPTED);
        }

        public static PostResult failed(String error, RetryEvidenceState retryEvidence) {
            return new PostResult(false, error, retryEvidence);
        }
    }

    /** Structured outcome of a retry-persistence attempt (#511). */
    public static final class RetryPersistResult {
        public final boolean ok;
        public final String error;

        private RetryPersistResult(boolean ok, String error) {
            this.ok = ok;
            this.error = error;
        }

        static RetryPersistResult stored() {
            return new RetryPersistResult(true, null);
        }

        static RetryPersistResult failed(String error) {
            return new RetryPersistResult(false, error);
        }
    }
}
