package app.drugtracker.autodeduction;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * System lifecycle receiver only — boot and exact-alarm permission changes.
 * Does NOT handle {@link AutoDeductionContract#ACTION_AUTO_DEDUCTION}.
 * Must not accept custom medication payloads.
 */
public class AutoDeductionSystemReceiver extends BroadcastReceiver {

    private static final String TAG = "AutoDeductionSystemRx";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            AutoDeductionLifecycle.promoteAndRestore(context, "BOOT");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            AutoDeductionLifecycle.promoteAndRestore(context, "EXACT_ALARM_PERMISSION");
            return;
        }

        Log.w(TAG, "ignored action: " + action);
    }
}
