package app.drugtracker.autodeduction;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;

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

    public volatile boolean forceOrderingTokenAllocationFailureForTest;
    public volatile boolean forceTombstoneCommitFailureForTest;
    public volatile boolean forceScheduleMetadataRemovalFailureForTest;

    public AutoDeductionSchedulingAdapter(Context context) {
        appContext = context.getApplicationContext();
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
    public CancelResult cancelOccurrence(
            String medicationId,
            String doseId,
            String calendarDate) {
        syncTestControls();
        ExactAlarmRuntime.CancelResult result = alarmRuntime.cancel(
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
        if (result.status == ExactAlarmRuntime.CancelResult.Status.ALREADY_ABSENT) {
            return CancelResult.alreadyAbsent();
        }
        if (!result.isOk()) {
            return CancelResult.failure(result.error);
        }
        return CancelResult.success();
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

    public static final class CancelResult {
        public enum Status {
            SUCCESS,
            ALREADY_ABSENT,
            FAILED
        }

        public final Status status;
        public final String error;

        private CancelResult(Status status, String error) {
            this.status = status;
            this.error = error;
        }

        public boolean isOk() {
            return status != Status.FAILED;
        }

        static CancelResult success() {
            return new CancelResult(Status.SUCCESS, null);
        }

        static CancelResult alreadyAbsent() {
            return new CancelResult(Status.ALREADY_ABSENT, null);
        }

        static CancelResult failure(String error) {
            return new CancelResult(Status.FAILED, error);
        }
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
