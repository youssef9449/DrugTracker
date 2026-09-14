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
        boolean cancelled = scheduler.cancelOccurrence(medicationId, doseId, calendarDate);
        JSObject ret = new JSObject();
        ret.put("ok", cancelled);
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
        boolean changed = store.markReconciled(medicationId, doseId, calendarDate);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("changed", changed);
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
