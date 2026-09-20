package app.drugtracker.alarmruntime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Single application receiver for Android system lifecycle events that can
 * require restoration of native alarm state.
 *
 * <p>Feature recovery is delegated through {@link ExactAlarmLifecycle};
 * this receiver contains no Auto/Critical/Dose business logic.</p>
 */
public final class DrugTrackerAlarmSystemReceiver
        extends BroadcastReceiver {
    private static final String TAG =
            "DrugTrackerAlarmSystemReceiver";

    private static final String ACTION_QUICKBOOT_POWERON =
            "android.intent.action.QUICKBOOT_POWERON";
    private static final String ACTION_EXACT_ALARM_PERMISSION =
            "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED";

    @Override
    public void onReceive(
            Context context,
            Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        final String action = intent.getAction();
        final String reason;

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || ACTION_QUICKBOOT_POWERON.equals(action)) {
            reason = "BOOT";
        } else if (Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            reason = "TIMEZONE_CHANGED";
        } else if (ACTION_EXACT_ALARM_PERMISSION.equals(action)) {
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
        }, "drugtracker-alarm-restore").start();
    }
}
