package app.drugtracker.criticalstock;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Thin Capacitor bridge; scheduling remains entirely in CriticalStockAlarmAdapter. */
@CapacitorPlugin(name = "CriticalStock")
public final class CriticalStockPlugin extends Plugin {

    @PluginMethod
    public void schedule(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String medicationName = call.getString("medicationName");
        String unit = call.getString("unit");
        String notificationTitle = call.getString("notificationTitle");
        String notificationBody = call.getString("notificationBody");
        Long triggerAt = call.getLong("triggerAtEpochMs");
        if (triggerAt == null
                || notificationTitle == null
                || notificationBody == null) {
            call.reject("missing_schedule_fields");
            return;
        }

        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                CriticalStockAlarmAdapter.ScheduleResult result =
                        new CriticalStockAlarmAdapter(getContext()).schedule(
                                medicationId,
                                medicationName,
                                triggerAt,
                                unit,
                                notificationTitle,
                                notificationBody,
                                null);

                JSObject ret = new JSObject();
                ret.put("ok", result.ok);
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("critical_stock_schedule_failed");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String medicationId = call.getString("medicationId");

        app.drugtracker.alarmruntime.ExactAlarmRuntime.executeAsync(() -> {
            try {
                CriticalStockAlarmAdapter.CancelResult result =
                        new CriticalStockAlarmAdapter(getContext()).cancel(medicationId);

                JSObject ret = new JSObject();
                ret.put("ok", result.isOk());
                ret.put("status", result.status.name());
                if (result.error != null) ret.put("error", result.error);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("critical_stock_cancel_failed");
            }
        });
    }

    @PluginMethod
    public void verify(PluginCall call) {
        String medicationId = call.getString("medicationId");
        Long expectedAt = call.getLong("alarmTimeMs");
        boolean ok = expectedAt != null
                && new CriticalStockAlarmAdapter(getContext())
                        .verify(medicationId, expectedAt.longValue());
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
