package app.drugtracker.autodeduction;

import android.content.Context;

import app.drugtracker.alarmruntime.ExactAlarmFeatureAdapter;

/** Auto Deduction adapter for shared exact-alarm lifecycle recovery. */
public final class AutoDeductionAlarmFeature
        implements ExactAlarmFeatureAdapter {
    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        AutoDeductionLifecycle.promoteAndRestore(
                context,
                reason,
                exactAlarmPermissionGranted);
    }
}
