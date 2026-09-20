package app.drugtracker.criticalalarm;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS bridge for Critical Stock future-alarm lifecycle metadata.
 * scheduleCriticalAlarm records after native ScheduleResult success;
 * cancelCriticalAlarm removes the record.
 */
@CapacitorPlugin(name = "CriticalAlarm")
public class CriticalAlarmPlugin extends Plugin {

    @PluginMethod
    public void recordArmed(PluginCall call) {
        String medicationId = call.getString("medicationId");
        Integer notificationId = call.getInt("notificationId");
        String targetDate = call.getString("targetDate");
        String targetLocalTime = call.getString("targetLocalTime");
        Long fireAtMs = call.getLong("fireAtMs");
        String timezoneId = call.getString("timezoneId");
        String title = call.getString("title");
        String body = call.getString("body");
        if (medicationId == null || medicationId.isEmpty()
                || notificationId == null || targetDate == null
                || targetLocalTime == null || fireAtMs == null) {
            call.reject("invalid_args");
            return;
        }
        if (timezoneId == null) timezoneId = java.util.TimeZone.getDefault().getID();
        if (title == null) title = "";
        if (body == null) body = "";
        CriticalAlarmStore.put(
                getContext(),
                medicationId,
                notificationId,
                targetDate,
                targetLocalTime,
                fireAtMs,
                timezoneId,
                title,
                body
        );
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearArmed(PluginCall call) {
        String medicationId = call.getString("medicationId");
        if (medicationId == null || medicationId.isEmpty()) {
            call.reject("invalid_medicationId");
            return;
        }
        CriticalAlarmStore.remove(getContext(), medicationId);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
