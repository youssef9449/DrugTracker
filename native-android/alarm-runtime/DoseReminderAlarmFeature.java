package app.drugtracker.alarmruntime;

import android.content.Context;
import android.util.Log;

/**
 * Dose Reminder lifecycle adapter for the shared alarm lifecycle.
 *
 * <p>Dose Reminder recurrence is still owned by the repository-owned
 * TimedNotificationPublisher and DoseReminderRecurrenceStore in this phase.
 * The shared lifecycle layer must not duplicate that recurrence mechanism or
 * move Dose Reminder business rules into the core.</p>
 *
 * <p>This adapter is intentionally a lifecycle integration point, not a
 * second receiver and not a second scheduler. Future Dose Reminder migration
 * can replace the no-op body with feature-owned native restore without
 * changing the shared dispatcher contract.</p>
 */
public final class DoseReminderAlarmFeature
        implements ExactAlarmFeatureAdapter {

    private static final String TAG = "DoseReminderAlarmFeature";

    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        Log.d(
                TAG,
                reason
                        + ": Dose Reminder adapter dispatched; "
                        + "native recurrence remains owned by "
                        + "TimedNotificationPublisher.");
    }
}
