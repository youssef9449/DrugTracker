package app.drugtracker.criticalstock;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Capacitor bridge for Critical Stock's exact-alarm boundary. */
@CapacitorPlugin(name = "CriticalStock")
public final class CriticalStockPlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String medicationName = call.getString("medicationName");
        String unit = call.getString("unit");
        Long triggerAt = call.getLong("triggerAtEpochMs");
        if (triggerAt == null) {
            call.reject("missing_trigger");
            return;
        }

        CriticalStockAlarmAdapter.ScheduleResult result =
                new CriticalStockAlarmAdapter(getContext()).schedule(
                        medicationId,
                        medicationName,
                        unit,
                        triggerAt,
                        null);

        JSObject ret = new JSObject();
        ret.put("ok", result.ok);
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String medicationId = call.getString("medicationId");
        CriticalStockAlarmAdapter.CancelResult result =
                new CriticalStockAlarmAdapter(getContext()).cancel(medicationId);

        JSObject ret = new JSObject();
        ret.put("ok", result.isOk());
        ret.put("status", result.status.name());
        if (result.error != null) ret.put("error", result.error);
        call.resolve(ret);
    }

    @PluginMethod
    public void verify(PluginCall call) {
        String medicationId = call.getString("medicationId");
        Long expectedAt = call.getLong("alarmTimeMs");
        boolean ok = false;
        if (expectedAt != null) {
            org.json.JSONObject meta =
                    new CriticalStockAlarmAdapter(getContext())
                            .getScheduleMetadata(medicationId);
            if (meta != null) {
                long actual = meta.optLong("triggerAtEpochMs", Long.MIN_VALUE);
                // ExactAlarmRuntime stores triggerAtEpochMs as generic metadata.
                // The metadata field is authoritative for the shared runtime.
                ok = actual == expectedAt.longValue();
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void listScheduled(PluginCall call) {
        java.util.List<String> ids =
                new CriticalStockAlarmAdapter(getContext())
                        .listScheduledMedicationIds();
        JSArray arr = new JSArray();
        for (String id : ids) arr.put(id);
        JSObject ret = new JSObject();
        ret.put("ids", arr);
        call.resolve(ret);
    }
}
