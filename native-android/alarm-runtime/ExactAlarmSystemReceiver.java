package app.drugtracker.alarmruntime;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/** Shared system receiver for exact-alarm lifecycle recovery. */
public final class ExactAlarmSystemReceiver
        extends BroadcastReceiver {
    private static final String TAG =
            "ExactAlarmSystemReceiver";

    @Override
    public void onReceive(
            Context context,
            Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        final String reason;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON"
                        .equals(action)) {
            reason = "BOOT";
        } else if (Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            reason = "TIMEZONE_CHANGED";
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && AlarmManager
                        .ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED
                        .equals(action)) {
            reason = "EXACT_ALARM_PERMISSION";
        } else {
            Log.w(TAG,
                    "ignored lifecycle action: " + action);
            return;
        }

        final PendingResult pendingResult = goAsync();
        final Context appContext =
                context.getApplicationContext();

        new Thread(() -> {
            try {
                ExactAlarmLifecycle.restoreAll(
                        appContext,
                        reason);
            } finally {
                pendingResult.finish();
            }
        }, "exact-alarm-restore").start();
    }
}
