package app.drugtracker.dosereminder;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;

/**
 * Capacitor bridge for Dose Reminder's exact-alarm boundary.
 *
 * <p>This plugin never posts notifications. Exact timing and cancellation are
 * delegated to DoseReminderAlarmAdapter → ExactAlarmRuntime.</p>
 */
@CapacitorPlugin(name = "DoseReminder")
public final class DoseReminderPlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String reminderTime = call.getString("reminderTime");
        Double amount = call.getDouble("amount");
        String medicationName = call.getString("medicationName", "");
        String unit = call.getString("unit", "قرص");
        String doseDescription = call.getString("doseDescription", "");
        String treatmentEndDate = call.getString("treatmentEndDate", "");
        Boolean allowManualTakeAction = call.getBoolean("allowManualTakeAction", true);
        Long triggerAt = call.getLong("triggerAtEpochMs");

        if (amount == null || triggerAt == null) {
            call.reject("invalid_schedule");
            return;
        }

        ExactAlarmRuntime.executeAsync(() -> {
            try {
                DoseReminderAlarmAdapter.ScheduleResult result =
                        new DoseReminderAlarmAdapter(getContext()).scheduleOccurrence(
                                medicationId,
                                doseId,
                                reminderTime,
                                amount,
                                medicationName,
                                unit,
                                doseDescription,
                                Boolean.TRUE.equals(allowManualTakeAction),
                                triggerAt,
                                null,
                                treatmentEndDate.isEmpty() ? null : treatmentEndDate);

                JSObject ret = new JSObject();
                ret.put("ok", result.ok);
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("dose_reminder_schedule_failed");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");

        ExactAlarmRuntime.executeAsync(() -> {
            try {
                DoseReminderAlarmAdapter.CancelResult result =
                        new DoseReminderAlarmAdapter(getContext())
                                .cancelOccurrence(medicationId, doseId);

                JSObject ret = new JSObject();
                ret.put("ok", result.isOk());
                ret.put("status", result.status.name());
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("dose_reminder_cancel_failed");
            }
        });
    }

    @PluginMethod
    public void scheduleSnooze(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String reminderTime = call.getString("reminderTime", "");
        Double amount = call.getDouble("amount");
        String medicationName = call.getString("medicationName", "");
        String unit = call.getString("unit", "قرص");
        String doseDescription = call.getString("doseDescription", "");
        Boolean allowManualTakeAction = call.getBoolean("allowManualTakeAction", true);
        Long triggerAt = call.getLong("triggerAtEpochMs");

        if (amount == null || triggerAt == null) {
            call.reject("invalid_snooze");
            return;
        }

        ExactAlarmRuntime.executeAsync(() -> {
            try {
                DoseReminderAlarmAdapter.ScheduleResult result =
                        new DoseReminderAlarmAdapter(getContext()).scheduleSnooze(
                                medicationId,
                                doseId,
                                reminderTime,
                                amount,
                                medicationName,
                                unit,
                                triggerAt,
                                Boolean.TRUE.equals(allowManualTakeAction),
                                doseDescription);

                JSObject ret = new JSObject();
                ret.put("ok", result.ok);
                if (result.operationVersion != null) {
                    ret.put("operationVersion", result.operationVersion);
                }
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("dose_reminder_snooze_schedule_failed");
            }
        });
    }

    @PluginMethod
    public void cancelSnooze(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");

        ExactAlarmRuntime.executeAsync(() -> {
            try {
                DoseReminderAlarmAdapter.CancelResult result =
                        new DoseReminderAlarmAdapter(getContext())
                                .cancelSnooze(medicationId, doseId);
                JSObject ret = new JSObject();
                ret.put("ok", result.isOk());
                ret.put("status", result.status.name());
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("dose_reminder_snooze_cancel_failed");
            }
        });
    }

    @PluginMethod
    public void checkOccurrenceOwnership(PluginCall call) {
        String medicationId = call.getString("medicationId", "");
        String doseId = call.getString("doseId", "");
        String operationVersion = call.getString("operationVersion", "");
        boolean owned = new DoseReminderAlarmAdapter(getContext())
                .ownsActiveOccurrence(medicationId, doseId, operationVersion);
        JSObject ret = new JSObject();
        ret.put("owned", owned);
        call.resolve(ret);
    }

    @PluginMethod
    public void isScheduled(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        DoseReminderAlarmAdapter adapter =
                new DoseReminderAlarmAdapter(getContext());
        ExactAlarmRuntime.PendingStateResult pending =
                adapter.getPendingState(medicationId, doseId);

        JSObject ret = new JSObject();
        if (!pending.isOk()) {
            call.reject(pending.error == null
                    ? "dose_reminder_pending_state_failed"
                    : pending.error);
            return;
        }
        ret.put("scheduled", pending.isPending());
        org.json.JSONObject metadata =
                adapter.getScheduleMetadata(medicationId, doseId);
        if (metadata != null) {
            ret.put(
                    "triggerAtEpochMs",
                    metadata.optLong(
                            app.drugtracker.alarmruntime.ExactAlarmContract
                                    .FIELD_TRIGGER_AT_EPOCH_MS,
                            -1L));
            ret.put(
                    "operationVersion",
                    metadata.optString(
                            app.drugtracker.alarmruntime.ExactAlarmContract
                                    .FIELD_OPERATION_VERSION,
                            ""));
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void listScheduled(PluginCall call) {
        java.util.List<String> keys =
                new DoseReminderAlarmAdapter(getContext()).listScheduledKeys();
        JSArray arr = new JSArray();
        for (String key : keys) arr.put(key);
        JSObject ret = new JSObject();
        ret.put("keys", arr);
        call.resolve(ret);
    }
}
