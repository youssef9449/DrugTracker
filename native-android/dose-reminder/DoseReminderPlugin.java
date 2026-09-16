package app.drugtracker.dosereminder;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.capacitorjs.plugins.localnotifications.DoseReminderRecurrenceStore;

/**
 * JS bridge for durable dose-reminder delivery/re-arm evidence written by
 * TimedNotificationPublisher after a successful next-day AlarmManager arm.
 *
 * Does not schedule or cancel alarms — query only.
 */
@CapacitorPlugin(name = "DoseReminder")
public class DoseReminderPlugin extends Plugin {

    /**
     * Options: medicationId (required), doseId (optional; omit/empty = legacy).
     * Resolves: { valid: boolean, nextOccurrenceMs: number } where
     * nextOccurrenceMs is -1 when absent.
     */
    @PluginMethod
    public void getNextOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        if (medicationId == null || medicationId.isEmpty()) {
            call.reject("invalid_medicationId");
            return;
        }
        long next = DoseReminderRecurrenceStore.getNextOccurrenceMs(
                getContext(), medicationId, doseId);
        boolean valid = DoseReminderRecurrenceStore.isValidReArm(
                getContext(), medicationId, doseId, System.currentTimeMillis());
        JSObject ret = new JSObject();
        ret.put("valid", valid);
        ret.put("nextOccurrenceMs", next);
        call.resolve(ret);
    }

    /**
     * Clear persisted re-arm evidence for a dose slot (cancel / config change).
     * Options: medicationId (required), doseId (optional).
     */
    @PluginMethod
    public void clearReArm(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        if (medicationId == null || medicationId.isEmpty()) {
            call.reject("invalid_medicationId");
            return;
        }
        DoseReminderRecurrenceStore.clear(getContext(), medicationId, doseId);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
