package app.drugtracker.dosereminder;

import android.content.Context;
import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;

/**
 * Dose Reminder boundary over the shared exact-alarm mechanism.
 *
 * <p>Only translates Dose Reminder identity/payload into the shared runtime.
 * It does not post notifications and it does not decide recurrence policy.</p>
 */
public final class DoseReminderAlarmAdapter {
    public static final String PREFS_SCHEDULES =
            "drugtracker_dose_reminder_alarm_schedules_v1";
    public static final String PREFS_CANCELLED =
            "drugtracker_dose_reminder_alarm_cancelled_v1";
    public static final String PREFS_ORDERING =
            "drugtracker_dose_reminder_alarm_ordering_v1";
    public static final int PENDING_INTENT_REQUEST_CODE = 0xD05E001;

    public static final String ACTION_DOSE_REMINDER =
            "app.drugtracker.action.DOSE_REMINDER_ALARM";
    public static final String ACTION_DOSE_SNOOZE =
            "app.drugtracker.action.DOSE_REMINDER_SNOOZE";

    private final ExactAlarmRuntime runtime;

    public DoseReminderAlarmAdapter(Context context) {
        runtime = new ExactAlarmRuntime(
                context,
                PREFS_SCHEDULES,
                PREFS_CANCELLED,
                PREFS_ORDERING,
                PENDING_INTENT_REQUEST_CODE);
    }

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String reminderTime,
            double amount,
            String medicationName,
            String unit,
            String doseDescription,
            boolean allowManualTakeAction,
            long triggerAtEpochMs,
            String expectedOperationVersion) {
        return scheduleOccurrence(
                medicationId,
                doseId,
                reminderTime,
                amount,
                medicationName,
                unit,
                doseDescription,
                allowManualTakeAction,
                triggerAtEpochMs,
                expectedOperationVersion,
                null);
    }

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String reminderTime,
            double amount,
            String medicationName,
            String unit,
            String doseDescription,
            boolean allowManualTakeAction,
            long triggerAtEpochMs,
            String expectedOperationVersion,
            String treatmentEndDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || reminderTime == null || reminderTime.isEmpty()
                || triggerAtEpochMs <= 0L) {
            return ScheduleResult.failure("invalid_request");
        }
        if (treatmentEndDate != null && !treatmentEndDate.isEmpty()
                && !app.drugtracker.alarmruntime.ExactAlarmContract
                        .isValidCalendarDate(treatmentEndDate)) {
            return ScheduleResult.failure("invalid_treatment_end_date");
        }

        String storageKey = occurrenceKey(medicationId, doseId);
        String identityUri = occurrenceUri(medicationId, doseId);

        JSONObject metadata = new JSONObject();
        try {
            metadata.put("medicationId", medicationId);
            metadata.put("doseId", doseId);
            metadata.put("reminderTime", reminderTime);
            java.util.Calendar scheduled = java.util.Calendar.getInstance();
            scheduled.setTimeInMillis(triggerAtEpochMs);
            metadata.put(
                    "calendarDate",
                    String.format(
                            java.util.Locale.US,
                            "%04d-%02d-%02d",
                            scheduled.get(java.util.Calendar.YEAR),
                            scheduled.get(java.util.Calendar.MONTH) + 1,
                            scheduled.get(java.util.Calendar.DAY_OF_MONTH)));
            metadata.put("amount", amount);
            if (treatmentEndDate != null && !treatmentEndDate.isEmpty()) {
                metadata.put("treatmentEndDate", treatmentEndDate);
            }
            metadata.put("medicationName", medicationName == null ? "" : medicationName);
            metadata.put("unit", unit == null ? "" : unit);
            metadata.put("doseDescription", doseDescription == null ? "" : doseDescription.trim());
            metadata.put("allowManualTakeAction", allowManualTakeAction);
        } catch (JSONException e) {
            return ScheduleResult.failure("metadata_build_failed");
        }

        Bundle extras = new Bundle();
        extras.putString("medicationId", medicationId);
        extras.putString("doseId", doseId);
        extras.putString("reminderTime", reminderTime);
        extras.putDouble("amount", amount);
        extras.putString("medicationName", medicationName == null ? "" : medicationName);
        extras.putString("unit", unit == null ? "" : unit);
        extras.putString("doseDescription", doseDescription == null ? "" : doseDescription.trim());
        extras.putBoolean("allowManualTakeAction", allowManualTakeAction);

        ExactAlarmRuntime.ScheduleResult result = runtime.schedule(
                new ExactAlarmRuntime.ScheduleRequest(
                        identityUri,
                        storageKey,
                        ACTION_DOSE_REMINDER,
                        DoseReminderAlarmReceiver.class,
                        triggerAtEpochMs,
                        metadata,
                        extras,
                        expectedOperationVersion));

        if (!result.ok) {
            return ScheduleResult.failure(result.error);
        }
        return ScheduleResult.success(result.operationVersion);
    }

    public CancelResult cancelOccurrence(String medicationId, String doseId) {
        String storageKey = occurrenceKey(medicationId, doseId);
        ExactAlarmRuntime.CancelResult result = runtime.cancel(
                occurrenceUri(medicationId, doseId),
                storageKey,
                ACTION_DOSE_REMINDER,
                DoseReminderAlarmReceiver.class);
        if (result.status == ExactAlarmRuntime.CancelResult.Status.ALREADY_ABSENT) {
            return CancelResult.alreadyAbsent();
        }
        if (!result.isOk()) {
            return CancelResult.failure(result.error);
        }
        return CancelResult.success();
    }

    public ScheduleResult scheduleSnooze(
            String medicationId,
            String doseId,
            String reminderTime,
            double amount,
            String medicationName,
            String unit,
            long triggerAtEpochMs,
            boolean allowManualTakeAction,
            String doseDescription) {
        return scheduleSnooze(
                medicationId,
                doseId,
                reminderTime,
                amount,
                medicationName,
                unit,
                triggerAtEpochMs,
                allowManualTakeAction,
                doseDescription,
                null);
    }

    public ScheduleResult scheduleSnooze(
            String medicationId,
            String doseId,
            String reminderTime,
            double amount,
            String medicationName,
            String unit,
            long triggerAtEpochMs,
            boolean allowManualTakeAction,
            String doseDescription,
            String expectedOperationVersion) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || triggerAtEpochMs <= 0L
                || amount <= 0d) {
            return ScheduleResult.failure("invalid_snooze_request");
        }

        JSONObject metadata = new JSONObject();
        try {
            metadata.put("medicationId", medicationId);
            metadata.put("doseId", doseId);
            metadata.put("reminderTime", reminderTime == null ? "" : reminderTime);
            metadata.put("amount", amount);
            metadata.put("medicationName", medicationName == null ? "" : medicationName);
            metadata.put("unit", unit == null ? "" : unit);
            metadata.put("doseDescription", doseDescription == null ? "" : doseDescription.trim());
            metadata.put("allowManualTakeAction", allowManualTakeAction);
        } catch (JSONException e) {
            return ScheduleResult.failure("metadata_build_failed");
        }

        Bundle extras = new Bundle();
        extras.putString("medicationId", medicationId);
        extras.putString("doseId", doseId);
        extras.putString("reminderTime", reminderTime == null ? "" : reminderTime);
        extras.putDouble("amount", amount);
        extras.putString("medicationName", medicationName == null ? "" : medicationName);
        extras.putString("unit", unit == null ? "" : unit);
        extras.putString("doseDescription", doseDescription == null ? "" : doseDescription.trim());
        extras.putBoolean("allowManualTakeAction", allowManualTakeAction);

        ExactAlarmRuntime.ScheduleResult result = runtime.schedule(
                new ExactAlarmRuntime.ScheduleRequest(
                        snoozeUri(medicationId, doseId),
                        snoozeKey(medicationId, doseId),
                        ACTION_DOSE_SNOOZE,
                        DoseReminderAlarmReceiver.class,
                        triggerAtEpochMs,
                        metadata,
                        extras,
                        expectedOperationVersion));
        return result.ok
                ? ScheduleResult.success(result.operationVersion)
                : ScheduleResult.failure(result.error);
    }

    public CancelResult cancelSnooze(String medicationId, String doseId) {
        ExactAlarmRuntime.CancelResult result = runtime.cancel(
                snoozeUri(medicationId, doseId),
                snoozeKey(medicationId, doseId),
                ACTION_DOSE_SNOOZE,
                DoseReminderAlarmReceiver.class);
        if (result.status == ExactAlarmRuntime.CancelResult.Status.ALREADY_ABSENT) {
            return CancelResult.alreadyAbsent();
        }
        if (!result.isOk()) {
            return CancelResult.failure(result.error);
        }
        return CancelResult.success();
    }

    public ExactAlarmRuntime.PendingStateResult getPendingState(
            String medicationId,
            String doseId) {
        return runtime.getPendingState(
                occurrenceUri(medicationId, doseId),
                ACTION_DOSE_REMINDER,
                DoseReminderAlarmReceiver.class);
    }

    public boolean ownsActiveOccurrence(
            String medicationId,
            String doseId,
            String operationVersion) {
        return runtime.ownsActiveSchedule(
                occurrenceKey(medicationId, doseId),
                operationVersion);
    }

    public boolean isOccurrenceEffectivelyCancelled(
            String medicationId,
            String doseId) {
        return runtime.isEffectivelyCancelled(
                occurrenceKey(medicationId, doseId));
    }

    public List<String> listScheduledKeys() {
        List<String> keys = runtime.listScheduledStorageKeys();
        List<String> result = new ArrayList<>();
        for (String key : keys) {
            if (key != null && key.startsWith("dose:")) {
                result.add(key.substring("dose:".length()));
            }
        }
        return result;
    }

    public JSONObject getScheduleMetadata(String medicationId, String doseId) {
        return runtime.getScheduleMetadata(occurrenceKey(medicationId, doseId));
    }

    public boolean completeOneShot(String medicationId, String doseId, String operationVersion) {
        return runtime.completeOneShot(
                occurrenceKey(medicationId, doseId),
                operationVersion);
    }

    public static String occurrenceKey(String medicationId, String doseId) {
        return "dose:" + (medicationId == null ? "" : medicationId)
                + "::"
                + (doseId == null ? "" : doseId);
    }

    public static String occurrenceUri(String medicationId, String doseId) {
        return ExactAlarmContract.buildIdentityUri(
                "content",
                "app.drugtracker.alarm",
                "alarm",
                "dose-reminder",
                medicationId == null ? "" : medicationId,
                doseId == null ? "" : doseId).toString();
    }

    public static String snoozeKey(String medicationId, String doseId) {
        return "snooze:" + (medicationId == null ? "" : medicationId)
                + "::"
                + (doseId == null ? "" : doseId);
    }

    public List<String> listScheduledSnoozeKeys() {
        List<String> keys = runtime.listScheduledStorageKeys();
        List<String> result = new ArrayList<>();
        for (String key : keys) {
            if (key != null && key.startsWith("snooze:")) {
                result.add(key.substring("snooze:".length()));
            }
        }
        return result;
    }

    public JSONObject getSnoozeMetadata(String medicationId, String doseId) {
        return runtime.getScheduleMetadata(snoozeKey(medicationId, doseId));
    }

    public boolean ownsActiveSnooze(
            String medicationId,
            String doseId,
            String operationVersion) {
        return runtime.ownsActiveSchedule(
                snoozeKey(medicationId, doseId),
                operationVersion);
    }

    public boolean isSnoozeEffectivelyCancelled(
            String medicationId,
            String doseId) {
        return runtime.isEffectivelyCancelled(
                snoozeKey(medicationId, doseId));
    }

    public boolean completeSnooze(
            String medicationId,
            String doseId,
            String operationVersion) {
        return runtime.completeOneShot(
                snoozeKey(medicationId, doseId),
                operationVersion);
    }

    public static String snoozeUri(String medicationId, String doseId) {
        return ExactAlarmContract.buildIdentityUri(
                "content",
                "app.drugtracker.alarm",
                "alarm",
                "dose-reminder-snooze",
                medicationId == null ? "" : medicationId,
                doseId == null ? "" : doseId).toString();
    }

    public static final class ScheduleResult {
        public final boolean ok;
        public final String error;
        public final String operationVersion;

        private ScheduleResult(boolean ok, String error, String operationVersion) {
            this.ok = ok;
            this.error = error;
            this.operationVersion = operationVersion;
        }

        static ScheduleResult success(String operationVersion) {
            return new ScheduleResult(true, null, operationVersion);
        }

        static ScheduleResult failure(String error) {
            return new ScheduleResult(false, error, null);
        }
    }

    public static final class CancelResult {
        public enum Status { SUCCESS, ALREADY_ABSENT, FAILED }

        public final Status status;
        public final String error;

        private CancelResult(Status status, String error) {
            this.status = status;
            this.error = error;
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

        public boolean isOk() {
            return status != Status.FAILED;
        }
    }
}
