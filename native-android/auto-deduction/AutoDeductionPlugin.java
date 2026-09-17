package app.drugtracker.autodeduction;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.List;

/**
 * Minimal Capacitor bridge for Phase 2 auto-deduction.
 * Does NOT reconcile stock into React state (Phase 3).
 */
@CapacitorPlugin(name = "AutoDeduction")
public class AutoDeductionPlugin extends Plugin {

    private static final String TAG = "AutoDeductionPlugin";

    @PluginMethod
    public void scheduleOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        String timeHhmm = call.getString("timeHhmm");
        Double amountObj = call.getDouble("amount");
        Long scheduledAt = call.getLong("scheduledAtEpochMs");

        if (amountObj == null) {
            call.reject("invalid_amount");
            return;
        }
        double amount = amountObj;
        long epoch = scheduledAt != null ? scheduledAt : 0L;

        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        AutoDeductionScheduler.ScheduleResult result = scheduler.scheduleOccurrence(
                medicationId, doseId, calendarDate, timeHhmm, amount, epoch);

        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        if (result.error != null) ret.put("error", result.error);
        if (result.occurrenceKey != null) ret.put("occurrenceKey", result.occurrenceKey);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        AutoDeductionScheduler.CancelResult result = scheduler.cancelOccurrence(
                medicationId, doseId, calendarDate);
        JSObject ret = new JSObject();
        ret.put("ok", result.isOk());
        ret.put("status", result.status.name());
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }

    /**
     * Issue #217: medication+dose recurrence disable — bumps durable generation under
     * SCHEDULE_LOCK and cancels all future scheduled occurrences for that dose slot.
     */
    @PluginMethod
    public void invalidateRecurrenceAuthorization(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()) {
            call.reject("invalid_args");
            return;
        }
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        AutoDeductionScheduler.InvalidateResult result =
                scheduler.invalidateRecurrenceAuthorization(medicationId, doseId);
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        if (result.error != null) ret.put("error", result.error);
        if (result.ok) ret.put("generation", result.generation);
        call.resolve(ret);
    }

    @PluginMethod
    public void listFiredEvents(PluginCall call) {
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        List<JSONObject> events = store.listFiredEvents();
        JSArray arr = new JSArray();
        for (JSONObject o : events) {
            try {
                arr.put(toJSObject(o));
            } catch (Exception e) {
                Log.w(TAG, "skip event", e);
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void listEvents(PluginCall call) {
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        List<JSONObject> events = store.listEvents();
        JSArray arr = new JSArray();
        for (JSONObject o : events) {
            try {
                arr.put(toJSObject(o));
            } catch (Exception e) {
                Log.w(TAG, "skip event", e);
            }
        }
        JSObject ret = new JSObject();
        ret.put("events", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void markReconciled(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        AutoDeductionEventStore store = new AutoDeductionEventStore(getContext());
        AutoDeductionEventStore.MarkResult result = store.markReconciled(medicationId, doseId, calendarDate);
        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        ret.put("changed", result.changed);
        call.resolve(ret);
    }

    @PluginMethod
    public void canScheduleExactAlarms(PluginCall call) {
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        JSObject ret = new JSObject();
        ret.put("granted", scheduler.canScheduleExactAlarms());
        call.resolve(ret);
    }

    @PluginMethod
    public void restoreFutureSchedules(PluginCall call) {
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        int n = scheduler.restoreFutureSchedules();
        JSObject ret = new JSObject();
        ret.put("restored", n);
        call.resolve(ret);
    }

    /**
     * List durable schedule metadata so JS can cancel stale occurrences
     * after process restart (trackedRef is empty).
     */
    @PluginMethod
    public void listScheduledOccurrences(PluginCall call) {
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
        java.util.List<JSONObject> rows = scheduler.listScheduledOccurrences();
        JSArray arr = new JSArray();
        for (JSONObject o : rows) {
            JSObject js = new JSObject();
            js.put("medicationId", o.optString("medicationId", ""));
            js.put("doseId", o.optString("doseId", ""));
            js.put("calendarDate", o.optString("calendarDate", ""));
            js.put("timeHhmm", o.optString("timeHhmm", ""));
            js.put("amount", o.optDouble("amount", 0));
            js.put("scheduledAtEpochMs", o.optLong("scheduledAtEpochMs", 0L));
            arr.put(js);
        }
        JSObject ret = new JSObject();
        ret.put("schedules", arr);
        call.resolve(ret);
    }


    /**
     * Phase 4 — atomic occurrence snapshot for Manual Take amount authority.
     * Runs under SCHEDULE_LOCK on the native side.
     */
    @PluginMethod
    public void getOccurrenceSnapshot(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String calendarDate = call.getString("calendarDate");
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || calendarDate == null || calendarDate.isEmpty()) {
            call.reject("missing_params");
            return;
        }
        try {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(getContext());
            AutoDeductionScheduler.OccurrenceSnapshot snap =
                    scheduler.getOccurrenceSnapshot(medicationId, doseId, calendarDate);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("status", snap.status.name());
            if (snap.amount != null) {
                ret.put("amount", snap.amount.doubleValue());
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "snapshot_failed");
        }
    }

    private static JSObject toJSObject(JSONObject o) {
        JSObject js = new JSObject();
        js.put("medicationId", o.optString("medicationId", ""));
        js.put("doseId", o.optString("doseId", ""));
        js.put("calendarDate", o.optString("calendarDate", ""));
        js.put("scheduledAtEpochMs", o.optLong("scheduledAtEpochMs", 0L));
        js.put("amount", o.optDouble("amount", 0));
        js.put("status", o.optString("status", ""));
        js.put("createdAtEpochMs", o.optLong("createdAtEpochMs", 0L));
        if (!o.isNull("reconciledAtEpochMs")) {
            js.put("reconciledAtEpochMs", o.optLong("reconciledAtEpochMs", 0L));
        } else {
            js.put("reconciledAtEpochMs", (Object) null);
        }
        return js;
    }
}
