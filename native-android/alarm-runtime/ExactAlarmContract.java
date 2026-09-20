package app.drugtracker.alarmruntime;

import android.net.Uri;

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
    public static final String FIELD_CALENDAR_DATE = "calendarDate";
    public static final String FIELD_TIME_HHMM = "timeHhmm";
    public static final String FIELD_TRIGGER_AT_EPOCH_MS = "triggerAtEpochMs";
    public static final String FIELD_DELIVERY_EXTRAS = "deliveryExtras";
    public static final String FIELD_RESTORE_ON_LIFECYCLE = "restoreOnLifecycle";
    public static final String EXTRA_OPERATION_VERSION = "operationVersion";
    public static final String SCHEDULE_KEY_PREFIX = "sch:";
    public static final String CANCEL_KEY_PREFIX = "cancel:";
    public static final String ORDERING_SEQUENCE_KEY = "lastAllocatedSequence";

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
