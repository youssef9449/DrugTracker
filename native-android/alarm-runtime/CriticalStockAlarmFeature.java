package app.drugtracker.alarmruntime;

import android.content.Context;
import android.util.Log;

/**
 * Critical Stock lifecycle adapter for the shared alarm lifecycle.
 *
 * <p>Critical Stock is still notification-plugin-owned in this phase:
 * its future one-shot schedule is persisted by Capacitor Local Notifications,
 * while the feature's episode/claim policy remains in JavaScript. There is
 * therefore no app-process-independent Critical Stock native recovery routine
 * to invoke here yet.</p>
 *
 * <p>This adapter is intentionally a lifecycle integration point, not a
 * second receiver and not a second scheduler. Future Critical Stock runtime
 * migration can replace the no-op body with feature-owned native restore
 * without changing the shared dispatcher contract.</p>
 */
public final class CriticalStockAlarmFeature
        implements ExactAlarmFeatureAdapter {

    private static final String TAG = "CriticalStockAlarmFeature";

    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        Log.d(
                TAG,
                reason
                        + ": Critical Stock adapter dispatched; "
                        + "native notification persistence remains owned by "
                        + "Capacitor Local Notifications.");
    }
}
