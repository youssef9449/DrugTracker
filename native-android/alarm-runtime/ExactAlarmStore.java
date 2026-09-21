package app.drugtracker.alarmruntime;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Durable mechanism store. The feature supplies storageKey so existing storage
 * schemas can be migrated without conflating storage identity with PendingIntent identity.
 */
final class ExactAlarmStore {
    private static final String TAG = "ExactAlarmStore";

    private final SharedPreferences schedules;
    private final SharedPreferences cancellations;
    private final SharedPreferences ordering;

    public ExactAlarmStore(
            Context context,
            String schedulesPrefsName,
            String cancellationsPrefsName,
            String orderingPrefsName) {
        Context appContext = context.getApplicationContext();
        schedules = appContext.getSharedPreferences(
                schedulesPrefsName, Context.MODE_PRIVATE);
        cancellations = appContext.getSharedPreferences(
                cancellationsPrefsName, Context.MODE_PRIVATE);
        ordering = appContext.getSharedPreferences(
                orderingPrefsName, Context.MODE_PRIVATE);
    }

    String storageKey(String featureStorageKey) {
        return ExactAlarmContract.SCHEDULE_KEY_PREFIX + featureStorageKey;
    }

    String cancellationKey(String featureStorageKey) {
        return ExactAlarmContract.CANCEL_KEY_PREFIX + featureStorageKey;
    }

    String getScheduleRaw(String featureStorageKey) {
        return featureStorageKey == null
                ? null
                : schedules.getString(
                        storageKey(featureStorageKey), null);
    }

    boolean hasSchedule(String featureStorageKey) {
        return featureStorageKey != null
                && schedules.contains(storageKey(featureStorageKey));
    }

    boolean hasCancellationTombstoneLocked(
            String featureStorageKey) {
        return featureStorageKey != null
                && cancellations.contains(
                        cancellationKey(featureStorageKey));
    }

    String getCancellationTokenLocked(
            String featureStorageKey) {
        return featureStorageKey == null
                ? null
                : cancellations.getString(
                        cancellationKey(featureStorageKey), null);
    }

    boolean writeScheduleLocked(
            String featureStorageKey,
            JSONObject metadata) {
        return schedules.edit()
                .putString(
                        storageKey(featureStorageKey),
                        metadata.toString())
                .commit();
    }

    boolean removeScheduleLocked(String featureStorageKey) {
        return schedules.edit()
                .remove(storageKey(featureStorageKey))
                .commit();
    }

    boolean removeScheduleIfOwnedLocked(
            String featureStorageKey,
            String expectedOperationVersion) {
        if (!isMetadataOwnedByOperationVersion(
                getScheduleRaw(featureStorageKey),
                expectedOperationVersion)) {
            return false;
        }
        return removeScheduleLocked(featureStorageKey);
    }

    boolean writeCancellationTombstoneLocked(
            String featureStorageKey,
            String operationVersion) {
        return cancellations.edit()
                .putString(
                        cancellationKey(featureStorageKey),
                        operationVersion)
                .commit();
    }

    boolean removeCancellationTombstoneLocked(
            String featureStorageKey) {
        return cancellations.edit()
                .remove(cancellationKey(featureStorageKey))
                .commit();
    }

    /** Caller MUST hold ExactAlarmOperationLock.LOCK. */
    String allocateOperationVersionLocked() {
        long last = ordering.getLong(
                ExactAlarmContract.ORDERING_SEQUENCE_KEY, 0L);
        long next = last + 1L;
        if (!ordering.edit()
                .putLong(
                        ExactAlarmContract.ORDERING_SEQUENCE_KEY,
                        next)
                .commit()) {
            Log.e(TAG, "durable ordering sequence commit failed");
            return null;
        }
        return System.currentTimeMillis()
                + "-"
                + next
                + "-"
                + UUID.randomUUID();
    }

    void clearCancellationIfSupersededLocked(
            String featureStorageKey,
            String scheduleOperationVersion) {
        String cancellation =
                getCancellationTokenLocked(featureStorageKey);
        if (cancellation == null) return;

        long[] scheduleOrder =
                parseOrdering(scheduleOperationVersion);
        long[] cancellationOrder =
                parseOrdering(cancellation);

        if (isOrderingNewer(
                scheduleOrder[0], scheduleOrder[1],
                cancellationOrder[0], cancellationOrder[1])) {
            if (!removeCancellationTombstoneLocked(featureStorageKey)) {
                Log.w(TAG, "failed to clear superseded tombstone: "
                        + featureStorageKey);
            }
        }
    }

    boolean isEffectivelyCancelledLocked(
            String featureStorageKey) {
        String cancellation =
                getCancellationTokenLocked(featureStorageKey);
        if (cancellation == null) return false;

        String schedule = getScheduleRaw(featureStorageKey);
        if (schedule == null || schedule.isEmpty()) return true;

        long[] cancellationOrder = parseOrdering(cancellation);
        long[] scheduleOrder = parseOrdering(
                extractOperationVersion(schedule));

        return scheduleOrder[0] >= 0L
                && cancellationOrder[0] >= 0L
                && isOrderingNewer(
                        scheduleOrder[0],
                        scheduleOrder[1],
                        cancellationOrder[0],
                        cancellationOrder[1])
                ? false
                : true;
    }

    List<String> listFeatureStorageKeys() {
        List<String> result = new ArrayList<>();
        for (Map.Entry<String, ?> entry
                : schedules.getAll().entrySet()) {
            String key = entry.getKey();
            if (key != null
                    && key.startsWith(
                            ExactAlarmContract.SCHEDULE_KEY_PREFIX)) {
                result.add(key.substring(
                        ExactAlarmContract.SCHEDULE_KEY_PREFIX.length()));
            }
        }
        return result;
    }

    static String extractOperationVersion(String raw) {
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
                ExactAlarmContract.FIELD_OPERATION_VERSION, "");
        return current.isEmpty()
                ? metadata.optString(
                        ExactAlarmContract.LEGACY_FIELD_SCHEDULE_VERSION,
                        "")
                : current;
    }

    static boolean isMetadataOwnedByOperationVersion(
            String currentJson,
            String expectedOperationVersion) {
        return expectedOperationVersion != null
                && !expectedOperationVersion.isEmpty()
                && expectedOperationVersion.equals(
                        extractOperationVersion(currentJson));
    }

    static long[] parseOrdering(String raw) {
        long[] result = new long[] {-1L, 0L};
        if (raw == null || raw.trim().isEmpty()) return result;
        try {
            String value = raw.trim();
            int firstDash = value.indexOf('-');
            if (firstDash <= 0) return result;
            int secondDash =
                    value.indexOf('-', firstDash + 1);
            String sequencePart =
                    secondDash > firstDash
                            ? value.substring(
                                    firstDash + 1, secondDash)
                            : value.substring(firstDash + 1);
            result[0] = Long.parseLong(
                    value.substring(0, firstDash));
            result[1] = Long.parseLong(sequencePart);
        } catch (NumberFormatException ignored) {
        }
        return result;
    }

    static boolean isOrderingNewer(
            long firstMillis,
            long firstSequence,
            long secondMillis,
            long secondSequence) {
        return firstMillis != secondMillis
                ? firstMillis > secondMillis
                : firstSequence > secondSequence;
    }
}
