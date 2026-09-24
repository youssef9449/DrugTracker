package app.drugtracker.alarmruntime;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Durable mechanism store. The feature supplies a storageKey so durable state
 * identity stays distinct from the Android PendingIntent identity.
 */
final class ExactAlarmStore {
    private static final String TAG = "ExactAlarmStore";

    private final SharedPreferences schedules;
    private final SharedPreferences cancellations;
    private final SharedPreferences ordering;

    ExactAlarmStore(
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

    /**
     * Synchronous commit (#493): schedule metadata MUST be durably visible
     * BEFORE the AlarmManager install so a crash between the two steps cannot
     * leave an armed alarm without a durable ownership record. Runs on the
     * background executor — never on a UI thread.
     */
    boolean writeScheduleLocked(
            String featureStorageKey,
            JSONObject metadata) {
        return schedules.edit()
                .putString(
                        storageKey(featureStorageKey),
                        metadata.toString())
                .commit();
    }

    /**
     * Synchronous commit (#493): durability serves two distinct callers.
     * Ownership-safe rollback restores the pre-transaction durable record so
     * that after a failed AlarmManager install the durable state never
     * describes a schedule the platform does not hold — an asynchronously
     * restored rollback could be lost in a crash and leave rollback ambiguity
     * between operation versions. The same write is the durable
     * delivery-accepted evidence (markOneShotDelivered): a delivery receiver
     * can be killed as soon as onReceive work ends, so a lost marker would
     * replay the delivery. The explicit outcome is consumed by both callers
     * (rollback failure log / delivery-evidence gate). Background executor or
     * goAsync receiver thread only — never a UI thread.
     */
    boolean writeScheduleRawLocked(
            String featureStorageKey,
            String rawMetadata) {
        if (featureStorageKey == null
                || featureStorageKey.isEmpty()
                || rawMetadata == null
                || rawMetadata.isEmpty()) {
            return false;
        }
        return schedules.edit()
                .putString(
                        storageKey(featureStorageKey),
                        rawMetadata)
                .commit();
    }


    /**
     * Synchronous commit (#493): the cancel transaction needs the real
     * persistence outcome — a failed removal keeps the metadata row, which
     * the tombstone-ordering reconciliation must then resolve. The durable
     * tombstone (also committed) remains the correctness authority; this
     * commit supplies the explicit success/failure signal. Background
     * executor only.
     */
    boolean removeScheduleLocked(String featureStorageKey) {
        return schedules.edit()
                .remove(storageKey(featureStorageKey))
                .commit();
    }

    boolean removeScheduleIfOwnedLocked(
            String featureStorageKey,
            String expectedOperationVersion) {
        if (!ExactAlarmContract.isMetadataOwnedByOperationVersion(
                getScheduleRaw(featureStorageKey),
                expectedOperationVersion)) {
            return false;
        }
        return removeScheduleLocked(featureStorageKey);
    }

    /**
     * Synchronous commit (#493): the tombstone is THE durable cancellation
     * proof and must be on disk before AlarmManager.cancel runs — otherwise a
     * crash could leave an armed alarm with no durable cancellation evidence.
     * Background executor only.
     */
    boolean writeCancellationTombstoneLocked(
            String featureStorageKey,
            String operationVersion) {
        return cancellations.edit()
                .putString(
                        cancellationKey(featureStorageKey),
                        operationVersion)
                .commit();
    }

    /**
     * Synchronous commit (#493): the removal outcome is part of the recovery
     * state machine — AutoDeductionFireService's compensation recovery
     * refuses (fail-closed) to resurrect an occurrence while its durable
     * cancellation tombstone cannot be confirmed durably cleared; superseded-
     * tombstone cleanup callers consume the outcome only for diagnostics.
     * A leftover tombstone is reconciled by ordering, but the compensation
     * gate needs the confirmed outcome, so apply() would silently disable
     * that fail-closed check. Background executor or goAsync receiver thread
     * only — never a UI thread.
     */
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
        // Synchronous commit (#493): the ordering sequence must be durably
        // monotonic BEFORE any dependent schedule/tombstone write — a lost
        // increment would let two operations claim the same ordering token.
        // Background executor only.
        if (!ordering.edit()
                .putLong(
                        ExactAlarmContract.ORDERING_SEQUENCE_KEY,
                        next)
                .commit()) {
            Log.e(TAG, "durable ordering sequence commit failed");
            return null;
        }
        return next
                + "-"
                + System.currentTimeMillis()
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
                ExactAlarmContract.parseOrdering(scheduleOperationVersion);
        long[] cancellationOrder =
                ExactAlarmContract.parseOrdering(cancellation);

        if (ExactAlarmContract.isOrderingNewer(
                scheduleOrder[0], scheduleOrder[1],
                cancellationOrder[0], cancellationOrder[1])) {
            if (!removeCancellationTombstoneLocked(featureStorageKey)) {
                Log.w(TAG, "failed to clear superseded tombstone: "
                        + featureStorageKey);
            }
        }
    }

    /** Caller MUST hold ExactAlarmOperationLock.LOCK. */
    java.util.Map<String, ?> getAllScheduleMetadata() {
        return schedules.getAll();
    }

    boolean isEffectivelyCancelledLocked(
            String featureStorageKey) {
        String cancellation =
                getCancellationTokenLocked(featureStorageKey);
        if (cancellation == null) return false;

        String schedule = getScheduleRaw(featureStorageKey);
        if (schedule == null || schedule.isEmpty()) return true;

        long[] cancellationOrder = ExactAlarmContract.parseOrdering(cancellation);
        long[] scheduleOrder = ExactAlarmContract.parseOrdering(
                ExactAlarmContract.extractOperationVersion(schedule));

        return scheduleOrder[0] >= 0L
                && cancellationOrder[0] >= 0L
                && ExactAlarmContract.isOrderingNewer(
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


}
