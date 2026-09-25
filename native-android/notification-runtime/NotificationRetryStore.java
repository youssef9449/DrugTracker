package app.drugtracker.notificationruntime;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Durable retry-evidence store for failed notification deliveries (#489).
 *
 * Responsibility-oriented extraction from {@link NotificationRuntime}: this
 * class owns ONLY the persistence/read-model of retry records —
 * serialization, eviction bounds (MAX_RETRY_ENTRIES + MAX_RETRY_AGE_MS),
 * compare-and-set removal, and the stable entry-key derivation. Delivery
 * itself (posting, channels, cancellation) stays in NotificationRuntime; the
 * retry-replay ORCHESTRATION also stays there so the store never posts.
 *
 * #511: persistence failures are surfaced through the structured
 * {@link NotificationRuntime.RetryPersistResult} outcome — never silently
 * discarded.
 *
 * #520 privacy boundary: the retry record stores the MINIMUM fields needed
 * for native reconstruction (namespace+identity routing, channel
 * id/importance, presentation title/body, action routing). The channel
 * display name is not persisted — the channel already exists at OS level
 * and is reused during replay.
 */
final class NotificationRetryStore {
    private static final String TAG = "NotificationRetryStore";
    private static final String RETRY_PREFS =
            "drugtracker_notification_delivery_retry_v2";
    private static final String RETRY_ENTRY_PREFIX = "entry:";
    private static final int MAX_RETRY_ENTRIES = 64;
    private static final long MAX_RETRY_AGE_MS =
            7L * 24L * 60L * 60L * 1000L;
    /** Process-wide serialization boundary for retry evidence. */
    private static final Object RETRY_LOCK = new Object();

    private final Context appContext;

    NotificationRetryStore(Context context) {
        this.appContext = context.getApplicationContext();
    }

    /** One pending retry record discovered by a store scan. */
    static final class RetryCandidate {
        final String key;
        final long queuedAtEpochMs;
        final String retryToken;

        RetryCandidate(String key, long queuedAtEpochMs, String retryToken) {
            this.key = key;
            this.queuedAtEpochMs = queuedAtEpochMs;
            this.retryToken = retryToken;
        }
    }

    /**
     * Persist a failed delivery for a later retry.
     *
     * #511: serialization/persistence failures are NOT silently discarded —
     * the structured outcome lets the caller distinguish "retry scheduled"
     * from "delivery failed and retry evidence could not be stored".
     */
    NotificationRuntime.RetryPersistResult persist(NotificationRuntime.Request request) {
        if (request == null || request.namespace == null || request.namespace.isEmpty()
                || request.identity == null || request.identity.isEmpty()) {
            return NotificationRuntime.RetryPersistResult.failed("invalid_retry_request");
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
            return NotificationRuntime.RetryPersistResult.stored();
        } catch (JSONException e) {
            // #511: observable persistence failure — never silently ignored.
            Log.e(TAG, "retry persistence failed", e);
            return NotificationRuntime.RetryPersistResult.failed("retry_persist_failed");
        }
    }

    /**
     * Scan pending retry records: expired entries are evicted, the rest are
     * returned oldest-first. Read-side cleanup only — no posting happens
     * here (replay orchestration remains NotificationRuntime's job).
     */
    List<RetryCandidate> listPendingRetries() {
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
        return candidates;
    }

    /** Reconstruct a stored retry request; null when unusable. */
    NotificationRuntime.Request readRequest(String entryKey) {
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

    /** Unconditional clear for an identity after successful delivery. */
    void clear(String namespace, String identity) {
        if (namespace == null || identity == null) return;
        remove(retryEntryKey(namespace, identity), null);
    }

    /**
     * Remove an entry only when its retry token still matches (null token
     * removes unconditionally). CAS semantics across the replay path.
     */
    void remove(String entryKey, String expectedRetryToken) {
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

    /**
     * Compare-and-set removal used after a successful replay: the entry is
     * dropped only if it is STILL the record this replay read.
     */
    boolean clearIfUnchanged(String entryKey, String expectedRetryToken) {
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

    private JSONObject serializeRequest(NotificationRuntime.Request request) throws JSONException {
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

    private NotificationRuntime.Request deserializeRequest(JSONObject item) {
        if (item == null) return null;
        try {
            JSONObject actionJson = item.optJSONObject("action");
            NotificationRuntime.Action action = actionJson == null ? null : new NotificationRuntime.Action(
                    actionJson.optString("id", ""),
                    actionJson.optString("title", ""),
                    actionJson.optBoolean("foreground", false));
            return new NotificationRuntime.Request(
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
}
