package app.drugtracker.autodeduction;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Map;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;
import app.drugtracker.alarmruntime.ExactAlarmStore;

/**
 * Auto Deduction adapter over the feature-neutral exact-alarm runtime.
 *
 * <p>This class is the only Auto Deduction scheduling boundary that talks to
 * {@link ExactAlarmRuntime}. It translates the Auto occurrence identity,
 * delivery payload, and Auto recurrence generation into the shared runtime's
 * mechanism-level request.</p>
 *
 * <p>Auto Deduction business rules remain in {@link AutoDeductionScheduler}:
 * recurrence authorization, FIRED/RECONCILED state, catch-up, fire retry
 * evidence, amount authority, and recovery policy are not implemented here.</p>
 */
public final class AutoDeductionSchedulingAdapter {

    private final Context appContext;
    private final ExactAlarmRuntime alarmRuntime;
    private final android.content.SharedPreferences schedulePrefs;

    public volatile boolean forceOrderingTokenAllocationFailureForTest;
    public volatile boolean forceTombstoneCommitFailureForTest;
    public volatile boolean forceScheduleMetadataRemovalFailureForTest;

    public AutoDeductionSchedulingAdapter(Context context) {
        appContext = context.getApplicationContext();
        schedulePrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_SCHEDULES,
                Context.MODE_PRIVATE);
        alarmRuntime = new ExactAlarmRuntime(
                appContext,
                AutoDeductionContract.PREFS_SCHEDULES,
                AutoDeductionContract.PREFS_CANCELLED,
                AutoDeductionContract.PREFS_ORDERING,
                AutoDeductionContract.PENDING_INTENT_REQUEST_CODE);
    }

    /**
     * Synchronize test-only runtime failure switches.
     * Production code leaves all switches false.
     */
    public void syncTestControls() {
        alarmRuntime.forceOrderingTokenAllocationFailureForTest =
                forceOrderingTokenAllocationFailureForTest;
        alarmRuntime.forceTombstoneCommitFailureForTest =
                forceTombstoneCommitFailureForTest;
        alarmRuntime.forceScheduleMetadataRemovalFailureForTest =
                forceScheduleMetadataRemovalFailureForTest;
    }

    public boolean canScheduleExactAlarms() {
        return alarmRuntime.canScheduleExactAlarms();
    }

    /**
     * Schedule one Auto Deduction occurrence through the shared runtime.
     *
     * <p>The caller owns validation and recurrence authorization. This adapter
     * only translates Auto-specific identity/payload into the neutral runtime
     * request. The shared runtime remains responsible for ordering, durable
     * schedule persistence, PendingIntent construction, AlarmManager install,
     * and ownership-safe rollback.</p>
     *
     * @param occurrenceKey canonical Auto occurrence key
     * @param medicationId feature identity
     * @param doseId feature identity
     * @param calendarDate occurrence date
     * @param timeHhmm local occurrence time
     * @param amount authoritative Auto amount
     * @param triggerAtEpochMs resolved wall-clock trigger
     * @param recurrenceGeneration active Auto recurrence authorization
     * @param expectedOperationVersion restore ownership guard, or null for a new schedule
     */
    public ScheduleResult scheduleOccurrence(
            String occurrenceKey,
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long triggerAtEpochMs,
            long recurrenceGeneration,
            String expectedOperationVersion) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()
                || medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)
                || triggerAtEpochMs <= 0L
                || recurrenceGeneration <= 0L) {
            return ScheduleResult.failure("invalid_schedule_request");
        }

        JSONObject featureMetadata = new JSONObject();
        try {
            featureMetadata.put("medicationId", medicationId);
            featureMetadata.put("doseId", doseId);
            featureMetadata.put("calendarDate", calendarDate);
            featureMetadata.put("timeHhmm", timeHhmm);
            featureMetadata.put("amount", amount);
            featureMetadata.put("scheduledAtEpochMs", triggerAtEpochMs);
            featureMetadata.put(
                    AutoDeductionContract.EXTRA_RECURRENCE_GENERATION,
                    recurrenceGeneration);
        } catch (JSONException e) {
            return ScheduleResult.failure("payload_build_failed");
        }

        Bundle deliveryExtras = new Bundle();
        deliveryExtras.putString(
                AutoDeductionContract.EXTRA_MEDICATION_ID,
                medicationId);
        deliveryExtras.putString(
                AutoDeductionContract.EXTRA_DOSE_ID,
                doseId);
        deliveryExtras.putString(
                AutoDeductionContract.EXTRA_CALENDAR_DATE,
                calendarDate);
        deliveryExtras.putLong(
                AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS,
                triggerAtEpochMs);
        deliveryExtras.putDouble(
                AutoDeductionContract.EXTRA_AMOUNT,
                amount);
        deliveryExtras.putString(
                AutoDeductionContract.EXTRA_TIME_HHMM,
                timeHhmm);
        deliveryExtras.putLong(
                AutoDeductionContract.EXTRA_RECURRENCE_GENERATION,
                recurrenceGeneration);

        syncTestControls();
        ExactAlarmRuntime.ScheduleResult result = alarmRuntime.schedule(
                new ExactAlarmRuntime.ScheduleRequest(
                        AutoDeductionContract.occurrenceUri(
                                medicationId,
                                doseId,
                                calendarDate).toString(),
                        occurrenceKey,
                        AutoDeductionContract.ACTION_AUTO_DEDUCTION,
                        AutoDeductionReceiver.class,
                        triggerAtEpochMs,
                        featureMetadata,
                        deliveryExtras,
                        expectedOperationVersion));
        if (!result.ok) {
            return ScheduleResult.failure(result.error);
        }
        return ScheduleResult.success(occurrenceKey);
    }

    /**
     * Cancel one Auto occurrence through the shared runtime.
     * All durable tombstone / AlarmManager / metadata ordering remains owned by
     * {@link ExactAlarmRuntime}.
     */
    public ExactAlarmRuntime.CancelResult cancelOccurrence(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return ExactAlarmRuntime.CancelResult.fail("invalid_args");
        }

        syncTestControls();
        return alarmRuntime.cancel(
                AutoDeductionContract.occurrenceUri(
                        medicationId,
                        doseId,
                        calendarDate).toString(),
                AutoDeductionContract.occurrenceKey(
                        medicationId,
                        doseId,
                        calendarDate),
                AutoDeductionContract.ACTION_AUTO_DEDUCTION,
                AutoDeductionReceiver.class);
    }

    /**
     * Feature-owned, ephemeral retry alarm. No durable schedule metadata is
     * written by this method; retry evidence remains in Auto Deduction state.
     */
    public boolean scheduleFireRetry(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String scheduleVersion,
            int retryCount) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)
                || recurrenceGeneration <= 0L
                || retryCount <= 0) {
            return false;
        }

        Bundle extras = new Bundle();
        extras.putString(
                AutoDeductionContract.EXTRA_MEDICATION_ID,
                medicationId);
        extras.putString(
                AutoDeductionContract.EXTRA_DOSE_ID,
                doseId);
        extras.putString(
                AutoDeductionContract.EXTRA_CALENDAR_DATE,
                calendarDate);
        extras.putLong(
                AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS,
                scheduledAtEpochMs);
        extras.putDouble(
                AutoDeductionContract.EXTRA_AMOUNT,
                amount);
        extras.putString(
                AutoDeductionContract.EXTRA_TIME_HHMM,
                timeHhmm != null ? timeHhmm : "");
        extras.putLong(
                AutoDeductionContract.EXTRA_RECURRENCE_GENERATION,
                recurrenceGeneration);
        extras.putInt(
                AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT,
                retryCount);
        if (scheduleVersion != null && !scheduleVersion.isEmpty()) {
            extras.putString(
                    AutoDeductionContract.EXTRA_SCHEDULE_VERSION,
                    scheduleVersion);
        }

        syncTestControls();
        return alarmRuntime.scheduleOneShot(
                AutoDeductionContract.occurrenceUri(
                        medicationId,
                        doseId,
                        calendarDate).toString(),
                AutoDeductionContract.ACTION_AUTO_DEDUCTION,
                AutoDeductionReceiver.class,
                extras,
                System.currentTimeMillis()
                        + AutoDeductionContract.FIRE_RETRY_DELAY_MS,
                true);
    }

    public String getScheduleRaw(String keyOrPrefKey) {
        String featureStorageKey = stripSchedulePrefix(keyOrPrefKey);
        return alarmRuntime.store().getScheduleRaw(featureStorageKey);
    }

    public boolean hasSchedule(String keyOrPrefKey) {
        String featureStorageKey = stripSchedulePrefix(keyOrPrefKey);
        return featureStorageKey != null
                && !featureStorageKey.isEmpty()
                && alarmRuntime.store().hasSchedule(featureStorageKey);
    }

    public Map<String, ?> getAllScheduleMetadata() {
        return schedulePrefs.getAll();
    }

    public boolean writeScheduleRaw(String keyOrPrefKey, String raw) {
        String prefKey = normalizeSchedulePrefKey(keyOrPrefKey);
        if (prefKey == null || raw == null) return false;
        return schedulePrefs.edit().putString(prefKey, raw).commit();
    }

    public boolean removeScheduleIfOwned(
            String keyOrPrefKey,
            String expectedOperationVersion) {
        String featureStorageKey = stripSchedulePrefix(keyOrPrefKey);
        return alarmRuntime.store().removeScheduleIfOwnedLocked(
                featureStorageKey,
                expectedOperationVersion);
    }

    public boolean removeSchedule(String keyOrPrefKey) {
        String featureStorageKey = stripSchedulePrefix(keyOrPrefKey);
        if (featureStorageKey == null || featureStorageKey.isEmpty()) {
            return false;
        }
        return alarmRuntime.store().removeScheduleLocked(featureStorageKey);
    }

    public boolean hasCancellationTombstone(String occurrenceKey) {
        return occurrenceKey != null
                && !occurrenceKey.isEmpty()
                && alarmRuntime.store().hasCancellationTombstoneLocked(occurrenceKey);
    }

    public boolean isEffectivelyCancelled(String occurrenceKey) {
        return occurrenceKey != null
                && !occurrenceKey.isEmpty()
                && alarmRuntime.store().isEffectivelyCancelledLocked(occurrenceKey);
    }

    public boolean clearCancellationTombstone(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        return alarmRuntime.store().removeCancellationTombstoneLocked(
                occurrenceKey);
    }

    public static boolean isMetadataOwnedByVersion(
            String currentJson,
            String expectedVersion) {
        return ExactAlarmStore.isMetadataOwnedByOperationVersion(
                currentJson,
                expectedVersion);
    }

    public static String extractOperationVersion(JSONObject metadata) {
        return ExactAlarmStore.extractOperationVersion(metadata);
    }

    public static String extractOperationVersion(String raw) {
        return ExactAlarmStore.extractOperationVersion(raw);
    }

    public static long[] parseOrdering(String raw) {
        return ExactAlarmStore.parseOrdering(raw);
    }

    public static boolean isOrderingNewer(
            long firstMillis,
            long firstSequence,
            long secondMillis,
            long secondSequence) {
        return ExactAlarmStore.isOrderingNewer(
                firstMillis,
                firstSequence,
                secondMillis,
                secondSequence);
    }

    private static String stripSchedulePrefix(String keyOrPrefKey) {
        if (keyOrPrefKey == null) return null;
        return keyOrPrefKey.startsWith(ExactAlarmContract.SCHEDULE_KEY_PREFIX)
                ? keyOrPrefKey.substring(
                        ExactAlarmContract.SCHEDULE_KEY_PREFIX.length())
                : keyOrPrefKey;
    }

    private static String normalizeSchedulePrefKey(String keyOrPrefKey) {
        if (keyOrPrefKey == null || keyOrPrefKey.isEmpty()) return null;
        return keyOrPrefKey.startsWith(
                ExactAlarmContract.SCHEDULE_KEY_PREFIX)
                ? keyOrPrefKey
                : ExactAlarmContract.SCHEDULE_KEY_PREFIX + keyOrPrefKey;
    }

    public static final class ScheduleResult {
        public final boolean ok;
        public final String error;
        public final String occurrenceKey;

        private ScheduleResult(
                boolean ok,
                String error,
                String occurrenceKey) {
            this.ok = ok;
            this.error = error;
            this.occurrenceKey = occurrenceKey;
        }

        static ScheduleResult success(String occurrenceKey) {
            return new ScheduleResult(true, null, occurrenceKey);
        }

        static ScheduleResult failure(String error) {
            return new ScheduleResult(false, error, null);
        }
    }
}
