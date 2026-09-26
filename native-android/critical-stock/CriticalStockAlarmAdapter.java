package app.drugtracker.criticalstock;
import android.content.Context;
import android.os.Bundle;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Calendar;
import java.util.List;
import java.util.ArrayList;
import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmFeatureAdapter;
import app.drugtracker.alarmruntime.ExactAlarmRestorePolicy;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;
/** Critical Stock boundary over the shared exact-alarm runtime. */
public final class CriticalStockAlarmAdapter
        implements ExactAlarmFeatureAdapter {
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
    /** Required by ExactAlarmLifecycle for manifest-driven recovery dispatch. */
    public CriticalStockAlarmAdapter() {
        runtime = null;
    }
    public CriticalStockAlarmAdapter(Context context) {
        runtime = new ExactAlarmRuntime(
                context,
                PREFS_SCHEDULES,
                PREFS_CANCELLED,
                PREFS_ORDERING,
                PENDING_INTENT_REQUEST_CODE);
    }
    /**
     * Recovery delay (ms) for a stale Critical Stock occurrence found during
     * restore: re-armed slightly in the future so the delivery path runs with
     * fresh state instead of firing instantly mid-recovery (#513).
     */
    private static final long CRITICAL_RECOVERY_DELAY_MS = 15_000L;

    /**
     * Shared lifecycle recovery entry point. Only durable Critical Stock
     * schedules are restored here; episode/claim policy remains in TypeScript.
     * Every durable record reaches a terminal state through the shared
     * restoration policy (#506): valid → restore; stale → resolve; malformed
     * → remove with a structured reason; ownership conflict → preserve.
     */
    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        CriticalStockAlarmAdapter adapter =
                new CriticalStockAlarmAdapter(context);
        if (!exactAlarmPermissionGranted) {
            for (String medicationId : adapter.listScheduledMedicationIds()) {
                CancelResult result = adapter.cancel(medicationId);
                if (!result.isOk()) {
                    android.util.Log.w(
                            "CriticalStockAlarmAdapter",
                            reason + ": failed to clean denied-permission alarm "
                                    + medicationId + " (" + result.error + ")");
                }
            }
            return;
        }
        for (String medicationId : adapter.listScheduledMedicationIds()) {
            JSONObject metadata =
                    adapter.getScheduleMetadata(medicationId);
            if (metadata == null) {
                // #506: a durable key without usable metadata is removed with
                // a structured reason instead of being silently skipped.
                CancelResult removed = adapter.cancel(medicationId);
                android.util.Log.w(
                        "CriticalStockAlarmAdapter",
                        reason + ": alarm record without metadata removed "
                                + medicationId + " (removed=" + removed.isOk() + ")");
                continue;
            }
            String operationVersion = metadata.optString(
                    ExactAlarmContract.FIELD_OPERATION_VERSION, "");

            String medicationName = metadata.optString("medicationName", "");
            String unit = metadata.optString("unit", "قرص");
            String notificationTitle =
                    metadata.optString("notificationTitle", "");
            String notificationBody =
                    metadata.optString("notificationBody", "");
            if ("accepted".equals(metadata.optString("deliveryState", ""))
                    && !operationVersion.isEmpty()) {
                if (!adapter.completeOneShot(medicationId, operationVersion)) {
                    android.util.Log.w(
                            "CriticalStockAlarmAdapter",
                            reason + ": completion retry failed " + medicationId);
                }
                continue;
            }

            String date = metadata.optString("alarmDate", "");
            String time = metadata.optString("alarmTime", "");
            long triggerAt = ExactAlarmContract.resolveLocalDateTimeEpochMs(date, time, false);
            // #506: shared restoration policy decides the terminal state for
            // every record; ownership conflicts would preserve the newer
            // authoritative record (not applicable in this single-writer loop).
            ExactAlarmRestorePolicy.Outcome outcome = ExactAlarmRestorePolicy.evaluate(
                    /* cancelled */ false,
                    /* identityKeyValid */ medicationId != null && !medicationId.isEmpty(),
                    /* metadataPresent */ true,
                    /* missingRequiredField */ null,
                    /* triggerDatetimeValid */ triggerAt > 0L,
                    /* triggerInPast */ triggerAt > 0L && triggerAt <= System.currentTimeMillis(),
                    /* ownershipConflict */ false);
            if (outcome.action == ExactAlarmRestorePolicy.Action.PRESERVE) {
                continue;
            }
            if (outcome.action == ExactAlarmRestorePolicy.Action.REMOVE_MALFORMED) {
                CancelResult removed = adapter.cancel(medicationId);
                if (!removed.isOk()) {
                    android.util.Log.w(
                            "CriticalStockAlarmAdapter",
                            reason + ": malformed alarm record not removable "
                                    + medicationId + " (" + removed.error + ")");
                } else {
                    android.util.Log.w(
                            "CriticalStockAlarmAdapter",
                            reason + ": removed malformed alarm record "
                                    + medicationId + " (" + outcome.reason + ")");
                }
                continue;
            }
            long now = System.currentTimeMillis();
            if (outcome.action == ExactAlarmRestorePolicy.Action.RESOLVE_STALE) {
                // Feature resolution for a stale occurrence: re-arm slightly
                // in the future so delivery runs with fresh state.
                triggerAt = now + CRITICAL_RECOVERY_DELAY_MS;
            }
            ScheduleResult result = adapter.schedule(
                    medicationId,
                    medicationName,
                    triggerAt,
                    unit,
                    notificationTitle,
                    notificationBody,
                    operationVersion.isEmpty()
                            ? null
                            : operationVersion);
            if (!result.ok) {
                android.util.Log.w(
                        "CriticalStockAlarmAdapter",
                        reason + ": failed to restore " + medicationId
                                + " (" + result.error + ")");
            }
        }
    }
    public ScheduleResult schedule(
            String medicationId,
            String medicationName,
            long triggerAtEpochMs,
            String unit,
            String notificationTitle,
            String notificationBody,
            String expectedOperationVersion) {
        if (medicationId == null || medicationId.isEmpty()
                || triggerAtEpochMs <= 0L
                || notificationTitle == null
                || notificationBody == null) {
            return ScheduleResult.failure("invalid_request");
        }
        JSONObject metadata = new JSONObject();
        try {
            Calendar cal = Calendar.getInstance();
            cal.setTimeInMillis(triggerAtEpochMs);
            String date = String.format(
                    java.util.Locale.US,
                    "%04d-%02d-%02d",
                    cal.get(Calendar.YEAR),
                    cal.get(Calendar.MONTH) + 1,
                    cal.get(Calendar.DAY_OF_MONTH));
            String time = String.format(
                    java.util.Locale.US,
                    "%02d:%02d",
                    cal.get(Calendar.HOUR_OF_DAY),
                    cal.get(Calendar.MINUTE));
            metadata.put("medicationId", medicationId);
            metadata.put("medicationName", medicationName == null ? "" : medicationName);
            metadata.put("unit", unit == null ? "" : unit);
            metadata.put("alarmDate", date);
            metadata.put("alarmTime", time);
            metadata.put("notificationTitle", notificationTitle);
            metadata.put("notificationBody", notificationBody);
        } catch (JSONException e) {
            return ScheduleResult.failure("metadata_build_failed");
        }
        Bundle extras = new Bundle();
        extras.putString("medicationId", medicationId);
        extras.putString("notificationTitle", notificationTitle);
        extras.putString("notificationBody", notificationBody);
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
    public boolean verify(
            String medicationId,
            long expectedAlarmTimeMs) {
        JSONObject metadata = getScheduleMetadata(medicationId);
        if (metadata == null
                || metadata.optLong(
                        ExactAlarmContract.FIELD_TRIGGER_AT_EPOCH_MS,
                        Long.MIN_VALUE) != expectedAlarmTimeMs) {
            return false;
        }
        ExactAlarmRuntime.PendingStateResult pending =
                runtime.getPendingState(
                        occurrenceUri(medicationId),
                        ACTION_CRITICAL_STOCK,
                        CriticalStockAlarmReceiver.class);
        return pending.isPending();
    }
    JSONObject getScheduleMetadata(String medicationId) {
        return runtime.getScheduleMetadata(occurrenceKey(medicationId));
    }
    List<String> listScheduledMedicationIds() {
        List<String> keys = runtime.listScheduledStorageKeys();
        List<String> result = new ArrayList<>();
        for (String key : keys) {
            if (key != null && key.startsWith("critical:")) {
                result.add(key.substring("critical:".length()));
            }
        }
        return result;
    }
    boolean completeOneShot(String medicationId, String operationVersion) {
        return runtime.completeOneShot(
                occurrenceKey(medicationId),
                operationVersion);
    }

    boolean ownsActiveSchedule(String medicationId, String operationVersion) {
        return runtime.ownsActiveSchedule(
                occurrenceKey(medicationId),
                operationVersion);
    }

    boolean claimOneShotDelivery(String medicationId, String operationVersion) {
        return runtime.claimOneShotDelivery(
                occurrenceKey(medicationId),
                operationVersion);
    }

    void releaseOneShotDeliveryClaim(
            String medicationId,
            String operationVersion) {
        runtime.releaseOneShotDeliveryClaim(
                occurrenceKey(medicationId),
                operationVersion);
    }

    boolean markOneShotDelivered(String medicationId, String operationVersion) {
        return runtime.markOneShotDelivered(
                occurrenceKey(medicationId),
                operationVersion);
    }

    boolean isOneShotDelivered(String medicationId) {
        return runtime.isOneShotDelivered(occurrenceKey(medicationId));
    }
    public static String occurrenceKey(String medicationId) {
        return "critical:" + (medicationId == null ? "" : medicationId);
    }
    public static String occurrenceUri(String medicationId) {
        return ExactAlarmContract.buildIdentityUri(
                "content",
                "app.drugtracker.alarm",
                "alarm",
                "critical-stock",
                medicationId == null ? "" : medicationId).toString();
    }
    public static final class ScheduleResult {
        public final boolean ok;
        public final String error;
        public final String operationVersion;
        private ScheduleResult(String error, String operationVersion, boolean ok) {
            this.ok = ok;
            this.error = error;
            this.operationVersion = operationVersion;
        }
        static ScheduleResult success(String operationVersion) {
            return new ScheduleResult(null, operationVersion, true);
        }
        static ScheduleResult failure(String error) {
            return new ScheduleResult(error, null, false);
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