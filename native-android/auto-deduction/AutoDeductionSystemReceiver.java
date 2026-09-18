package app.drugtracker.autodeduction;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * System lifecycle receiver only — boot, exact-alarm permission, and timezone changes.
 * Does NOT handle {@link AutoDeductionContract#ACTION_AUTO_DEDUCTION}.
 * Must not accept custom medication payloads.
 *
 * Restore work ({@code promotePendingFires} + {@code restoreFutureSchedules})
 * performs potentially many synchronous commit() disk writes, so it runs on a
 * background thread via {@link #goAsync()}: the main thread is never blocked
 * (ANR safety) and the broadcast result is held until the restore finishes.
 */
public class AutoDeductionSystemReceiver extends BroadcastReceiver {

    private static final String TAG = "AutoDeductionSystemRx";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        final String reason;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            reason = "BOOT";
        } else if (Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            // Rebuild future exact alarms from durable schedule metadata using the
            // new default timezone. Does not synthesize duplicate FIRED events;
            // historical FIRED/RECONCILED rows are left unchanged.
            reason = "TIMEZONE_CHANGED";
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            reason = "EXACT_ALARM_PERMISSION";
        } else {
            Log.w(TAG, "ignored action: " + action);
            return;
        }

        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                // promoteAndRestore catches its own unexpected exceptions, so
                // finish() always runs.
                AutoDeductionLifecycle.promoteAndRestore(appContext, reason);
            } finally {
                pendingResult.finish();
            }
        }, "auto-deduction-restore").start();
    }
}
