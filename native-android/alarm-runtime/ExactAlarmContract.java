package app.drugtracker.alarmruntime;

import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Feature-neutral contract for one-shot exact alarms.
 *
 * <p>Features own logical identity and business payloads. The shared runtime owns
 * PendingIntent construction and AlarmManager mechanics.</p>
 */
public final class ExactAlarmContract {
    private ExactAlarmContract() {}

    public static final String FIELD_OPERATION_VERSION = "operationVersion";
    public static final String LEGACY_FIELD_SCHEDULE_VERSION = "scheduleVersion";
    public static final String FIELD_IDENTITY_URI = "identityUri";
    public static final String FIELD_STORAGE_KEY = "storageKey";
    public static final String FIELD_ACTION = "action";
    public static final String FIELD_RECEIVER_CLASS = "receiverClass";
    public static final String FIELD_TRIGGER_AT_EPOCH_MS = "triggerAtEpochMs";
    public static final String EXTRA_OPERATION_VERSION = "operationVersion";
    public static final String SCHEDULE_KEY_PREFIX = "sch:";
    public static final String CANCEL_KEY_PREFIX = "cancel:";
    public static final String ORDERING_SEQUENCE_KEY = "lastAllocatedSequence";

    public static String extractOperationVersion(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        try {
            return extractOperationVersion(new JSONObject(raw));
        } catch (JSONException e) {
            return "";
        }
    }

    public static String extractOperationVersion(JSONObject metadata) {
        if (metadata == null) return "";
        String current = metadata.optString(
                FIELD_OPERATION_VERSION, "");
        return current.isEmpty()
                ? metadata.optString(
                        LEGACY_FIELD_SCHEDULE_VERSION,
                        "")
                : current;
    }

    public static boolean isMetadataOwnedByOperationVersion(
            String currentJson,
            String expectedOperationVersion) {
        return expectedOperationVersion != null
                && !expectedOperationVersion.isEmpty()
                && expectedOperationVersion.equals(
                        extractOperationVersion(currentJson));
    }

    public static long[] parseOrdering(String raw) {
        long[] result = new long[] {-1L, 0L};
        if (raw == null || raw.trim().isEmpty()) return result;
        try {
            String value = raw.trim();
            int firstDash = value.indexOf('-');
            if (firstDash <= 0) return result;
            int secondDash = value.indexOf('-', firstDash + 1);
            String sequencePart = secondDash > firstDash
                    ? value.substring(firstDash + 1, secondDash)
                    : value.substring(firstDash + 1);
            result[0] = Long.parseLong(value.substring(0, firstDash));
            result[1] = Long.parseLong(sequencePart);
        } catch (NumberFormatException ignored) {
        }
        return result;
    }

    public static boolean isOrderingNewer(
            long firstMillis,
            long firstSequence,
            long secondMillis,
            long secondSequence) {
        return firstMillis != secondMillis
                ? firstMillis > secondMillis
                : firstSequence > secondSequence;
    }

    private static final String SCHEME = "content";
    private static final String AUTHORITY = "app.drugtracker.alarm";
    private static final String ROOT = "alarm";

    public static Uri buildIdentityUri(
            String featureNamespace,
            String... identitySegments) {
        if (featureNamespace == null
                || featureNamespace.trim().isEmpty()) {
            throw new IllegalArgumentException("featureNamespace");
        }
        Uri.Builder builder = new Uri.Builder()
                .scheme(SCHEME)
                .authority(AUTHORITY)
                .appendPath(ROOT)
                .appendPath(featureNamespace);
        if (identitySegments != null) {
            for (String segment : identitySegments) {
                if (segment == null || segment.isEmpty()) {
                    throw new IllegalArgumentException("identity segment");
                }
                builder.appendPath(segment);
            }
        }
        return builder.build();
    }

    /** Full URI is authoritative identity; no hash is used. */
    public static boolean isValidIdentityUri(String identityUri) {
        if (identityUri == null || identityUri.trim().isEmpty()) {
            return false;
        }
        try {
            Uri uri = Uri.parse(identityUri);
            return SCHEME.equals(uri.getScheme())
                    && uri.getAuthority() != null
                    && !uri.getAuthority().isEmpty()
                    && uri.getPathSegments() != null
                    && !uri.getPathSegments().isEmpty();
        } catch (Exception e) {
            return false;
        }
    }
}
