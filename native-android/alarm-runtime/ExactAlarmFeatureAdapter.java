package app.drugtracker.alarmruntime;

import android.content.Context;

/**
 * Feature-owned lifecycle recovery entry point.
 *
 * <p>The shared dispatcher supplies the current exact-alarm capability state;
 * feature code does not duplicate the platform permission probe.</p>
 */
public interface ExactAlarmFeatureAdapter {
    void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted);
}
