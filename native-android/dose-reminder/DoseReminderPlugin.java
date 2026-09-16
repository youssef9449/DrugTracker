package app.drugtracker.dosereminder;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.capacitorjs.plugins.localnotifications.DoseReminderRecurrenceStore;

/**
 * JS bridge for temporary dose-reminder delivery/re-arm evidence written by
 * TimedNotificationPublisher after a successful next-day AlarmManager arm.
 *
 * Does not schedule or cancel alarms — query/clear only. Validity requires
 * the current desired reminderTime so stale config cannot block repair.
 */
@CapacitorPlugin(name = "DoseReminder")
public class DoseReminderPlugin extends Plugin {

    /**
     * Options: medicationId (required), doseId (optional), reminderTime (required for validity).
     * Resolves: { valid: boolean, nextOccurrenceMs: number } where
     * nextOccurrenceMs is -1 when absent. valid is true only when entry matches
     * current schedule identity and next occurrence is still future.
     */
    @PluginMethod
    public void getNextOccurrence(PluginCall call) {
        String medicationId = call.getString("medicationId");
        String doseId = call.getString("doseId");
        String reminderTime = call.getString("reminderTime");
        if (medicationId == null || medicationId.isEmpty()) {
            call.reject("invalid_medicationId");
            return;
        }
        long next = DoseReminderRecurrenceStore.getNextOccurrenceMs(
                getContext(), medicationId, doseId);
        boolean valid = DoseReminderRecurrenceStore.isValidReArm(
                getContext(),
                medicationId,
                doseId,
                System.currentTimeMillis(),
                reminderTime);
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
