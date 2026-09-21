package app.drugtracker.autodeduction;

import android.content.Context;
import android.util.Log;

/**
 * Feature lifecycle recovery for Phase 2 auto-deduction; the shared
 * alarm runtime dispatches system lifecycle events to this feature.
 * Invoked by the shared exact-alarm lifecycle receiver after boot /
 * exact-alarm permission changes / timezone changes. Does NOT handle
 * ACTION_AUTO_DEDUCTION fires.
 */
public final class AutoDeductionLifecycle {

    private static final String TAG = "AutoDeductionLifecycle";

    private AutoDeductionLifecycle() {}

    /**
     * Promote pending-fire records, then restore schedules from durable metadata
     * when the shared lifecycle dispatcher reports exact-alarm permission available. Past snapshots use multi-day catch-up
     * (Issue #243): every due occurrence is recovered as FIRED (no horizon), then
     * the first future occurrence is installed.
     */
    public static void promoteAndRestore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        try {
            AutoDeductionEventStore store = new AutoDeductionEventStore(context);
            int promoted = store.promotePendingFiresResult().promoted;
            if (promoted > 0) {
                Log.i(TAG, reason + ": promoted " + promoted + " pending-fire record(s)");
            }
            if (!exactAlarmPermissionGranted) {
                Log.w(TAG, reason
                        + ": exact alarm permission not granted — skip alarm restore");
                return;
            }

            AutoDeductionScheduler scheduler =
                    new AutoDeductionScheduler(context);

            // Native FIRED events can outlive the JS process. Before restoring
            // schedules, make sure their stock side is also durable even when
            // the WebView remains unavailable during boot/recovery.
            AutoDeductionScheduler.RestoreResult stockRecovery =
                    scheduler.recoverFiredStockPass();
            if (stockRecovery.ok) {
                Log.i(TAG, reason + ": recovered Native stock for "
                        + stockRecovery.restored + " FIRED occurrence(s)");
            } else {
                Log.e(TAG, reason + ": Native FIRED stock recovery incomplete: "
                        + stockRecovery.error + " recovered="
                        + stockRecovery.restored + " failed=" + stockRecovery.failed);
            }

            AutoDeductionScheduler.RestoreResult rr =
                    scheduler.restoreFutureSchedules();
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