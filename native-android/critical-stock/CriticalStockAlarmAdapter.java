package app.drugtracker.criticalstock;

import android.content.Context;
import android.os.Bundle;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;

/** Critical Stock boundary over the shared exact-alarm runtime. */
public final class CriticalStockAlarmAdapter {
    private static final String PREFS_SCHEDULES =
            "drugtracker_critical_stock_alarm_schedules_v1";
    private static final String PREFS_CANCELLED =
            "drugtracker_critical_stock_alarm_cancelled_v1";
    private static final String PREFS_ORDERING =
            "drugtracker_critical_stock_alarm_ordering_v1";
    private static final int PENDING_INTENT_REQUEST_CODE = 0xC71C001;

    public static final String ACTION_CRITICAL_STOCK =
            "app.drugtracker.action.CRITICAL_STOCK_ALARM";

    private final ExactAlarmRuntime runtime;

    public CriticalStockAlarmAdapter(Context context) {
        runtime = new ExactAlarmRuntime(
                context,
                PREFS_SCHEDULES,
                PREFS_CANCELLED,
                PREFS_ORDERING,
                PENDING_INTENT_REQUEST_CODE);
    }

    public boolean canScheduleExactAlarms() {
        return runtime.canScheduleExactAlarms();
    }

    public ScheduleResult schedule(
            String medicationId,
            String medicationName,
            String unit,
            long triggerAtEpochMs,
            String expectedOperationVersion) {
        if (medicationId == null || medicationId.isEmpty()
                || triggerAtEpochMs <= 0L) {
            return ScheduleResult.failure("invalid_request");
        }

        JSONObject metadata = new JSONObject();
        try {
            java.util.Calendar cal = java.util.Calendar.getInstance();
            cal.setTimeInMillis(triggerAtEpochMs);
            String date = String.format(
                    java.util.Locale.US,
                    "%04d-%02d-%02d",
                    cal.get(java.util.Calendar.YEAR),
                    cal.get(java.util.Calendar.MONTH) + 1,
                    cal.get(java.util.Calendar.DAY_OF_MONTH));
            String time = String.format(
                    java.util.Locale.US,
                    "%02d:%02d",
                    cal.get(java.util.Calendar.HOUR_OF_DAY),
                    cal.get(java.util.Calendar.MINUTE));

            metadata.put("medicationId", medicationId);
            metadata.put("medicationName", medicationName == null ? "" : medicationName);
            metadata.put("unit", unit == null ? "" : unit);
            metadata.put("alarmDate", date);
            metadata.put("alarmTime", time);
        } catch (JSONException e) {
            return ScheduleResult.failure("metadata_build_failed");
        }

        Bundle extras = new Bundle();
        extras.putString("medicationId", medicationId);
        extras.putString("medicationName", medicationName == null ? "" : medicationName);
        extras.putString("unit", unit == null ? "" : unit);

        String storageKey = occurrenceKey(medicationId);
        ExactAlarmRuntime.ScheduleResult result = runtime.schedule(
                new ExactAlarmRuntime.ScheduleRequest(
                        occurrenceUri(medicationId),
                        storageKey,
                        ACTION_CRITICAL_STOCK,
                        CriticalStockAlarmReceiver.class,
                        triggerAtEpochMs,
                        metadata,
                        extras,
                        expectedOperationVersion));
        if (!result.ok) {
            return ScheduleResult.failure(result.error);
        }
        return ScheduleResult.success(result.operationVersion);
    }

    public CancelResult cancel(String medicationId) {
        ExactAlarmRuntime.CancelResult result = runtime.cancel(
                occurrenceUri(medicationId),
                occurrenceKey(medicationId),
                ACTION_CRITICAL_STOCK,
                CriticalStockAlarmReceiver.class);
        if (result.status == ExactAlarmRuntime.CancelResult.Status.ALREADY_ABSENT) {
            return CancelResult.alreadyAbsent();
        }
        if (!result.isOk()) {
            return CancelResult.failure(result.error);
        }
        return CancelResult.success();
    }

    public boolean isPending(String medicationId) {
        return runtime.isPending(
                occurrenceUri(medicationId),
                ACTION_CRITICAL_STOCK,
                CriticalStockAlarmReceiver.class);
    }

    public JSONObject getScheduleMetadata(String medicationId) {
        return runtime.getScheduleMetadata(occurrenceKey(medicationId));
    }

    public List<String> listScheduledMedicationIds() {
        List<String> keys = runtime.listScheduledStorageKeys();
        List<String> result = new ArrayList<>();
        for (String key : keys) {
            if (key != null && key.startsWith("critical:")) {
                result.add(key.substring("critical:".length()));
            }
        }
        return result;
    }

    public boolean completeOneShot(String medicationId, String operationVersion) {
        return runtime.completeOneShot(
                occurrenceKey(medicationId),
                operationVersion);
    }

    public static String occurrenceKey(String medicationId) {
        return "critical:" + (medicationId == null ? "" : medicationId);
    }

    public static String occurrenceUri(String medicationId) {
        return ExactAlarmContract.buildIdentityUri(
                "critical-stock",
                medicationId == null ? "" : medicationId).toString();
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
