package app.drugtracker.alarmruntime;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Shared Capacitor bridge for Android exact-alarm capability/settings.
 * It exposes platform capability only; feature policy remains outside.
 */
@CapacitorPlugin(name = "ExactAlarmRuntime")
public final class ExactAlarmPlugin extends Plugin {

    @PluginMethod
    public void canScheduleExactAlarms(PluginCall call) {
        boolean granted = ExactAlarmRuntime.canScheduleExactAlarms(
                getContext());
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }

        try {
            Intent intent = new Intent(
                    android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            ret.put("error", "open_settings_failed");
            call.resolve(ret);
        }
    }

}
