package app.drugtracker.criticalstock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.List;
import java.util.Locale;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmFeatureAdapter;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;
import app.drugtracker.notificationruntime.NotificationRuntime;

/**
 * Single Critical Stock native boundary over the shared exact-alarm runtime.
 *
 * <p>Scheduling/cancellation/verification plus the private delivery and
 * lifecycle-recovery plumbing live here. Episode, claim, generation, and
 * notification-opportunity policy remain in TypeScript.</p>
 */
@CapacitorPlugin(name = "CriticalStock")
public final class CriticalStockAlarmAdapter extends Plugin
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

    private static final String DEFAULT_CHANNEL_ID = "low-stock";
    private static final String DEFAULT_CHANNEL_NAME = "تنبيهات النفاذ";
    private static final int DEFAULT_CHANNEL_IMPORTANCE = 4;
    private static final int DEFAULT_CHANNEL_VISIBILITY = 1;
    private static final String DEFAULT_SMALL_ICON = "ic_launcher";

    @PluginMethod
    public void schedule(PluginCall call) {
        NotificationPayload payload = NotificationPayload.fromCall(call);
        ScheduleResult result = schedule(
                getContext(),
                call.getString("medicationId"),
                call.getString("localDate"),
                call.getString("localTime"),
                payload,
                null);

        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        if (result.error != null) ret.put("error", result.error);
        if (result.operationVersion != null) {
            ret.put("operationVersion", result.operationVersion);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        CancelResult result =
                cancel(getContext(), call.getString("medicationId"));

        JSObject ret = new JSObject();
        ret.put("ok", result.isOk());
        ret.put("status", result.status.name());
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }

    @PluginMethod
    public void verify(PluginCall call) {
        VerificationResult result =
                verify(getContext(), call.getString("medicationId"));

        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        ret.put("triggerAtEpochMs", result.triggerAtEpochMs);
        call.resolve(ret);
    }

    /** Shared lifecycle recovery entry point for Critical Stock. */
    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        if (!exactAlarmPermissionGranted) return;

        ExactAlarmRuntime runtime = runtime(context);
        List<String> keys = runtime.listScheduledStorageKeys();

        for (String key : keys) {
            if (key == null || !key.startsWith("critical:")) continue;

            String medicationId = key.substring("critical:".length());
            if (medicationId.isEmpty()) continue;

            JSONObject metadata = runtime.getScheduleMetadata(key);
            if (metadata == null) continue;

            String localDate = metadata.optString("alarmDate", "");
            String localTime = metadata.optString("alarmTime", "");
            if (localDate.isEmpty() || localTime.isEmpty()) continue;

            long triggerAt = resolveLocalDateTime(localDate, localTime);
            long now = System.currentTimeMillis();
            if (triggerAt <= 0L) continue;

            // Preserve the Phase-6 recovery behavior for past-due schedules.
            if (triggerAt <= now) {
                triggerAt = now + 15_000L;
                localDate = localDate(triggerAt);
                localTime = localTime(triggerAt);
            }

            String operationVersion = metadata.optString(
                    ExactAlarmContract.FIELD_OPERATION_VERSION,
                    ExactAlarmContract.LEGACY_FIELD_SCHEDULE_VERSION);

            ScheduleResult result = schedule(
                    context,
                    medicationId,
                    localDate,
                    localTime,
                    NotificationPayload.fromMetadata(metadata),
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

    private static ScheduleResult schedule(
            Context context,
            String medicationId,
            String localDate,
            String localTime,
            NotificationPayload payload,
            String expectedOperationVersion) {
        if (context == null
                || medicationId == null
                || medicationId.isEmpty()
                || localDate == null
                || localDate.isEmpty()
                || localTime == null
                || localTime.isEmpty()
                || payload == null) {
            return ScheduleResult.failure("invalid_request");
        }

        long triggerAtEpochMs =
                resolveLocalDateTime(localDate, localTime);
        if (triggerAtEpochMs <= 0L) {
            return ScheduleResult.failure("invalid_local_datetime");
        }

        JSONObject metadata = new JSONObject();
        try {
            metadata.put("medicationId", medicationId);
            metadata.put("alarmDate", localDate);
            metadata.put("alarmTime", localTime);
            metadata.put("title", payload.title);
            metadata.put("body", payload.body);
            metadata.put("channelId", payload.channelId);
            metadata.put("channelName", payload.channelName);
            metadata.put("channelImportance", payload.channelImportance);
            metadata.put("channelVisibility", payload.channelVisibility);
            metadata.put("smallIcon", payload.smallIcon);
            metadata.put("autoCancel", payload.autoCancel);
            metadata.put("ongoing", payload.ongoing);
        } catch (JSONException e) {
            return ScheduleResult.failure("metadata_build_failed");
        }

        Bundle extras = payload.toBundle();
        extras.putString("medicationId", medicationId);

        ExactAlarmRuntime.ScheduleResult result = runtime(context).schedule(
                new ExactAlarmRuntime.ScheduleRequest(
                        occurrenceUri(medicationId),
                        occurrenceKey(medicationId),
                        ACTION_CRITICAL_STOCK,
                        AlarmReceiver.class,
                        triggerAtEpochMs,
                        metadata,
                        extras,
                        expectedOperationVersion));

        if (!result.ok) {
            return ScheduleResult.failure(result.error);
        }
        return ScheduleResult.success(result.operationVersion);
    }

    private static CancelResult cancel(
            Context context,
            String medicationId) {
        if (context == null
                || medicationId == null
                || medicationId.isEmpty()) {
            return CancelResult.failure("invalid_cancel_request");
        }

        ExactAlarmRuntime.CancelResult result = runtime(context).cancel(
                occurrenceUri(medicationId),
                occurrenceKey(medicationId),
                ACTION_CRITICAL_STOCK,
                AlarmReceiver.class);

        if (result.status
                == ExactAlarmRuntime.CancelResult.Status.ALREADY_ABSENT) {
            return CancelResult.alreadyAbsent();
        }
        if (!result.isOk()) {
            return CancelResult.failure(result.error);
        }
        return CancelResult.success();
    }

    private static VerificationResult verify(
            Context context,
            String medicationId) {
        if (context == null
                || medicationId == null
                || medicationId.isEmpty()) {
            return VerificationResult.failed();
        }

        ExactAlarmRuntime runtime = runtime(context);
        JSONObject metadata = runtime.getScheduleMetadata(
                occurrenceKey(medicationId));
        if (metadata == null) return VerificationResult.failed();

        long triggerAt = metadata.optLong(
                ExactAlarmContract.FIELD_TRIGGER_AT_EPOCH_MS,
                -1L);
        if (triggerAt <= 0L) return VerificationResult.failed();

        boolean pending = runtime.isPending(
                occurrenceUri(medicationId),
                ACTION_CRITICAL_STOCK,
                AlarmReceiver.class);

        return new VerificationResult(pending, triggerAt);
    }

    private static boolean completeOneShot(
            Context context,
            String medicationId,
            String operationVersion) {
        if (context == null
                || medicationId == null
                || medicationId.isEmpty()
                || operationVersion == null
                || operationVersion.isEmpty()) {
            return false;
        }
        return runtime(context).completeOneShot(
                occurrenceKey(medicationId),
                operationVersion);
    }

    private static ExactAlarmRuntime runtime(Context context) {
        return new ExactAlarmRuntime(
                context,
                PREFS_SCHEDULES,
                PREFS_CANCELLED,
                PREFS_ORDERING,
                PENDING_INTENT_REQUEST_CODE);
    }

    private static long resolveLocalDateTime(
            String date,
            String time) {
        if (date == null || date.length() != 10
                || time == null || time.length() != 5
                || date.charAt(4) != '-'
                || date.charAt(7) != '-'
                || time.charAt(2) != ':') {
            return -1L;
        }
        try {
            int year = Integer.parseInt(date.substring(0, 4));
            int month = Integer.parseInt(date.substring(5, 7));
            int day = Integer.parseInt(date.substring(8, 10));
            int hour = Integer.parseInt(time.substring(0, 2));
            int minute = Integer.parseInt(time.substring(3, 5));

            Calendar calendar = Calendar.getInstance();
            calendar.clear();
            calendar.setLenient(false);
            calendar.set(year, month - 1, day, hour, minute, 0);
            long result = calendar.getTimeInMillis();

            Calendar check = Calendar.getInstance();
            check.setTimeInMillis(result);
            if (check.get(Calendar.YEAR) != year
                    || check.get(Calendar.MONTH) != month - 1
                    || check.get(Calendar.DAY_OF_MONTH) != day
                    || check.get(Calendar.HOUR_OF_DAY) != hour
                    || check.get(Calendar.MINUTE) != minute) {
                return -1L;
            }
            return result;
        } catch (Exception e) {
            return -1L;
        }
    }

    private static String localDate(long epochMs) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(epochMs);
        return String.format(
                Locale.US,
                "%04d-%02d-%02d",
                calendar.get(Calendar.YEAR),
                calendar.get(Calendar.MONTH) + 1,
                calendar.get(Calendar.DAY_OF_MONTH));
    }

    private static String localTime(long epochMs) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(epochMs);
        return String.format(
                Locale.US,
                "%02d:%02d",
                calendar.get(Calendar.HOUR_OF_DAY),
                calendar.get(Calendar.MINUTE));
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

        private ScheduleResult(
                boolean ok,
                String error,
                String operationVersion) {
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

    private static final class VerificationResult {
        final boolean ok;
        final long triggerAtEpochMs;

        VerificationResult(boolean ok, long triggerAtEpochMs) {
            this.ok = ok;
            this.triggerAtEpochMs = triggerAtEpochMs;
        }

        static VerificationResult failed() {
            return new VerificationResult(false, -1L);
        }
    }

    private static final class NotificationPayload {
        final String title;
        final String body;
        final String channelId;
        final String channelName;
        final int channelImportance;
        final int channelVisibility;
        final String smallIcon;
        final boolean autoCancel;
        final boolean ongoing;

        NotificationPayload(
                String title,
                String body,
                String channelId,
                String channelName,
                int channelImportance,
                int channelVisibility,
                String smallIcon,
                boolean autoCancel,
                boolean ongoing) {
            this.title = title == null ? "" : title;
            this.body = body == null ? "" : body;
            this.channelId = channelId == null || channelId.isEmpty()
                    ? DEFAULT_CHANNEL_ID
                    : channelId;
            this.channelName = channelName == null || channelName.isEmpty()
                    ? DEFAULT_CHANNEL_NAME
                    : channelName;
            this.channelImportance = channelImportance <= 0
                    ? DEFAULT_CHANNEL_IMPORTANCE
                    : channelImportance;
            this.channelVisibility = channelVisibility == 0
                    ? DEFAULT_CHANNEL_VISIBILITY
                    : channelVisibility;
            this.smallIcon = smallIcon == null || smallIcon.isEmpty()
                    ? DEFAULT_SMALL_ICON
                    : smallIcon;
            this.autoCancel = autoCancel;
            this.ongoing = ongoing;
        }

        static NotificationPayload fromCall(PluginCall call) {
            Integer importance = call.getInt("channelImportance");
            Integer visibility = call.getInt("channelVisibility");
            Boolean autoCancel = call.getBoolean("autoCancel");
            Boolean ongoing = call.getBoolean("ongoing");

            return new NotificationPayload(
                    call.getString("title"),
                    call.getString("body"),
                    call.getString("channelId"),
                    call.getString("channelName"),
                    importance == null
                            ? DEFAULT_CHANNEL_IMPORTANCE
                            : importance,
                    visibility == null
                            ? DEFAULT_CHANNEL_VISIBILITY
                            : visibility,
                    call.getString("smallIcon"),
                    autoCancel == null || autoCancel,
                    ongoing != null && ongoing);
        }

        static NotificationPayload fromMetadata(JSONObject metadata) {
            return new NotificationPayload(
                    metadata.optString("title", ""),
                    metadata.optString("body", ""),
                    metadata.optString(
                            "channelId",
                            DEFAULT_CHANNEL_ID),
                    metadata.optString(
                            "channelName",
                            DEFAULT_CHANNEL_NAME),
                    metadata.optInt(
                            "channelImportance",
                            DEFAULT_CHANNEL_IMPORTANCE),
                    metadata.optInt(
                            "channelVisibility",
                            DEFAULT_CHANNEL_VISIBILITY),
                    metadata.optString(
                            "smallIcon",
                            DEFAULT_SMALL_ICON),
                    metadata.optBoolean("autoCancel", true),
                    metadata.optBoolean("ongoing", false));
        }

        Bundle toBundle() {
            Bundle extras = new Bundle();
            extras.putString("title", title);
            extras.putString("body", body);
            extras.putString("channelId", channelId);
            extras.putString("channelName", channelName);
            extras.putInt("channelImportance", channelImportance);
            extras.putInt("channelVisibility", channelVisibility);
            extras.putString("smallIcon", smallIcon);
            extras.putBoolean("autoCancel", autoCancel);
            extras.putBoolean("ongoing", ongoing);
            return extras;
        }
    }

    /**
     * Exact-alarm delivery stays private to this adapter. It only posts the
     * already-selected notification payload and completes the owned one-shot.
     */
    public static final class AlarmReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null
                    || !ACTION_CRITICAL_STOCK.equals(
                            intent.getAction())) {
                return;
            }

            PendingResult pendingResult = goAsync();
            Context appContext = context.getApplicationContext();

            new Thread(() -> {
                try {
                    String medicationId = intent.getStringExtra(
                            "medicationId");
                    String operationVersion = intent.getStringExtra(
                            ExactAlarmContract.EXTRA_OPERATION_VERSION);
                    if (medicationId == null || medicationId.isEmpty()) {
                        return;
                    }

                    new NotificationRuntime(appContext).post(
                            new NotificationRuntime.Request(
                                    "critical-stock",
                                    medicationId,
                                    intent.getStringExtra("title"),
                                    intent.getStringExtra("body"),
                                    intent.getStringExtra("channelId"),
                                    intent.getStringExtra("channelName"),
                                    intent.getIntExtra(
                                            "channelImportance",
                                            DEFAULT_CHANNEL_IMPORTANCE),
                                    intent.getIntExtra(
                                            "channelVisibility",
                                            DEFAULT_CHANNEL_VISIBILITY),
                                    intent.getStringExtra("smallIcon"),
                                    intent.getBooleanExtra(
                                            "autoCancel",
                                            true),
                                    intent.getBooleanExtra(
                                            "ongoing",
                                            false),
                                    null));

                    completeOneShot(
                            appContext,
                            medicationId,
                            operationVersion);
                } finally {
                    pendingResult.finish();
                }
            }, "critical-stock-alarm").start();
        }
    }
}
