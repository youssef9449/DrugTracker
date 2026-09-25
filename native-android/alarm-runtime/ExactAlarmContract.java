package app.drugtracker.alarmruntime;
import android.net.Uri;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;
/**
 * Feature-neutral contract for one-shot exact alarms.
 *
 * <p>Features own logical identity and business payloads. The shared runtime owns
 * PendingIntent construction and AlarmManager mechanics.</p>
 */
public final class ExactAlarmContract {
    private ExactAlarmContract() {}
    public static final String FIELD_OPERATION_VERSION = "operationVersion";
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
        return current;
    }
    public static boolean isMetadataOwnedByOperationVersion(
            String currentJson,
            String expectedOperationVersion) {
        return expectedOperationVersion != null
                && !expectedOperationVersion.isEmpty()
                && expectedOperationVersion.equals(
                        extractOperationVersion(currentJson));
    }
    public static boolean isMetadataOwnedByOperationVersion(
            JSONObject metadata,
            String expectedOperationVersion) {
        return expectedOperationVersion != null
                && !expectedOperationVersion.isEmpty()
                && expectedOperationVersion.equals(extractOperationVersion(metadata));
    }
    public static boolean isValidCalendarDate(String value) {
        if (value == null || value.length() != 10
                || value.charAt(4) != '-' || value.charAt(7) != '-') {
            return false;
        }
        for (int i = 0; i < value.length(); i++) {
            if (i == 4 || i == 7) continue;
            char c = value.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        try {
            int year = Integer.parseInt(value.substring(0, 4));
            int month = Integer.parseInt(value.substring(5, 7));
            int day = Integer.parseInt(value.substring(8, 10));
            Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"), Locale.US);
            calendar.clear();
            calendar.setLenient(false);
            calendar.set(year, month - 1, day, 0, 0, 0);
            calendar.getTimeInMillis();
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }
    /**
     * Parse the monotonic operation token as [sequence, wallClockMillis].
     *
     * <p>The sequence is the only chronological authority. The wall-clock
     * component is diagnostic metadata and intentionally cannot override a
     * later durable operation when the device clock moves.</p>
     */
    public static long[] parseOrdering(String raw) {
        long[] result = new long[] {-1L, 0L};
        if (raw == null || raw.trim().isEmpty()) return result;
        try {
            String value = raw.trim();
            int firstDash = value.indexOf('-');
            if (firstDash <= 0) return result;
            int secondDash = value.indexOf('-', firstDash + 1);
            String millisPart = secondDash > firstDash
                    ? value.substring(firstDash + 1, secondDash)
                    : value.substring(firstDash + 1);
            result[0] = Long.parseLong(value.substring(0, firstDash));
            result[1] = Long.parseLong(millisPart);
        } catch (NumberFormatException ignored) {
        }
        return result;
    }

    public static boolean isOrderingNewer(
            long firstSequence,
            long firstMillis,
            long secondSequence,
            long secondMillis) {
        if (firstSequence != secondSequence) {
            return firstSequence > secondSequence;
        }
        return firstMillis > secondMillis;
    }
    private static final String SCHEME = "content";
    /**
     * Single generic native identity encoder.
     *
     * <p>The caller supplies its own URI scheme/authority/path
     * segments. The shared contract owns validation and encoding; it knows
     * nothing about any caller's feature namespaces.</p>
     */
    public static Uri buildIdentityUri(
            String scheme,
            String authority,
            String... pathSegments) {
        if (scheme == null || scheme.trim().isEmpty()) {
            throw new IllegalArgumentException("scheme");
        }
        if (authority == null || authority.trim().isEmpty()) {
            throw new IllegalArgumentException("authority");
        }
        Uri.Builder builder = new Uri.Builder()
                .scheme(scheme)
                .authority(authority);
        if (pathSegments != null) {
            for (String segment : pathSegments) {
                if (segment == null || segment.isEmpty()) {
                    throw new IllegalArgumentException("identity segment");
                }
                builder.appendPath(segment);
            }
        }
        return builder.build();
    }
    /**
     * Resolve a local calendar date + wall-clock time to epoch milliseconds in
     * the device's current timezone. This is the shared generic conversion;
     * the caller supplies the calendar-field leniency policy.
     *
     * @param lenient whether Calendar may normalize nonexistent/overflowing
     *                calendar fields; feature-specific validation remains outside.
     * @return epoch milliseconds, or -1L when the input cannot be resolved.
     */
    public static long resolveLocalDateTimeEpochMs(
            String calendarDate,
            String timeHhmm,
            boolean lenient) {
        if (calendarDate == null || calendarDate.length() != 10
                || calendarDate.charAt(4) != '-'
                || calendarDate.charAt(7) != '-') {
            return -1L;
        }
        for (int i = 0; i < calendarDate.length(); i++) {
            if (i == 4 || i == 7) continue;
            char c = calendarDate.charAt(i);
            if (c < '0' || c > '9') return -1L;
        }
        if (timeHhmm == null || (timeHhmm.length() != 4 && timeHhmm.length() != 5)) {
            return -1L;
        }
        int colon = timeHhmm.indexOf(':');
        if (colon < 1 || colon > 2 || colon != timeHhmm.lastIndexOf(':')) {
            return -1L;
        }
        for (int i = 0; i < timeHhmm.length(); i++) {
            if (i == colon) continue;
            char c = timeHhmm.charAt(i);
            if (c < '0' || c > '9') return -1L;
        }
        try {
            int year = Integer.parseInt(calendarDate.substring(0, 4));
            int month = Integer.parseInt(calendarDate.substring(5, 7));
            int day = Integer.parseInt(calendarDate.substring(8, 10));
            int hour = Integer.parseInt(timeHhmm.substring(0, colon));
            int minute = Integer.parseInt(timeHhmm.substring(colon + 1));
            Calendar calendar = Calendar.getInstance(TimeZone.getDefault(), Locale.US);
            calendar.clear();
            calendar.setLenient(lenient);
            calendar.set(year, month - 1, day, hour, minute, 0);
            return calendar.getTimeInMillis();
        } catch (Exception e) {
            return -1L;
        }
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