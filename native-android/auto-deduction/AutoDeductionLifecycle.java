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
     * Promote pending-fire records, then restore schedules from durable metadata
     * when exact-alarm permission allows. Past snapshots use multi-day catch-up
     * (Issue #243): every due occurrence is recovered as FIRED (no horizon), then
     * the first future occurrence is installed.
     */
    public static void promoteAndRestore(Context context, String reason) {
        try {
            AutoDeductionEventStore store = new AutoDeductionEventStore(context);
            int promoted = store.promotePendingFiresResult().promoted;
            if (promoted > 0) {
                Log.i(TAG, reason + ": promoted " + promoted + " pending-fire record(s)");
            }
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
            if (!scheduler.canScheduleExactAlarms()) {
                Log.w(TAG, reason + ": exact alarm permission not granted — skip restore");
                return;
            }
            AutoDeductionScheduler.RestoreResult rr = scheduler.restoreFutureSchedules();
            if (rr.ok) {
                Log.i(TAG, reason + ": restored " + rr.restored
                        + " future auto-deduction alarms (failed=" + rr.failed + ")");
            } else {
                Log.e(TAG, reason + ": restoreFutureSchedules incomplete: "
                        + rr.error + " restored=" + rr.restored + " failed=" + rr.failed);
            }
        } catch (Exception e) {
            Log.e(TAG, reason + " promoteAndRestore failed", e);
        }
    }
}
