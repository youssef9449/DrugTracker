package app.drugtracker.autodeduction;

import android.content.Context;
import android.util.Log;

/**
 * Shared lifecycle recovery for Phase 2 auto-deduction.
 * Used by {@link AutoDeductionSystemReceiver} after boot / exact-alarm
 * permission changes / timezone changes. Does NOT handle ACTION_AUTO_DEDUCTION fires.
 */
public final class AutoDeductionLifecycle {

    private static final String TAG = "AutoDeductionLifecycle";

    private AutoDeductionLifecycle() {}

    /**
     * Promote pending-fire records, then restore future alarms from durable
     * schedule metadata when exact-alarm permission allows.
     */
    public static void promoteAndRestore(Context context, String reason) {
        try {
            AutoDeductionEventStore store = new AutoDeductionEventStore(context);
            int promoted = store.promotePendingFires();
            if (promoted > 0) {
                Log.i(TAG, reason + ": promoted " + promoted + " pending-fire record(s)");
            }
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
            if (!scheduler.canScheduleExactAlarms()) {
                Log.w(TAG, reason + ": exact alarm permission not granted — skip restore");
                return;
            }
            int n = scheduler.restoreFutureSchedules();
            Log.i(TAG, reason + ": restored " + n + " future auto-deduction alarms");
        } catch (Exception e) {
            Log.e(TAG, reason + " promoteAndRestore failed", e);
        }
    }
}
