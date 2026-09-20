package app.drugtracker.criticalalarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * System lifecycle receiver for Critical Stock future alarms.
 * Handles {@link Intent#ACTION_TIMEZONE_CHANGED} with the same goAsync()
 * background-work pattern as AutoDeductionSystemReceiver.
 * Does not perform long synchronous storage work on the main thread.
 */
public class CriticalAlarmSystemReceiver extends BroadcastReceiver {
    private static final String TAG = "CriticalAlarmSystemRx";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;
        if (!Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            Log.w(TAG, "ignored action: " + action);
            return;
        }

        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                CriticalAlarmLifecycle.rebaseOnTimezoneChange(appContext);
            } finally {
                pendingResult.finish();
            }
        }, "critical-alarm-tz-rebase").start();
    }
}
