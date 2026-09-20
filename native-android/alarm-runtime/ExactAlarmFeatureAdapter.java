package app.drugtracker.alarmruntime;

import android.content.Context;

/** Feature-owned lifecycle recovery entry point. */
public interface ExactAlarmFeatureAdapter {
    void restore(Context context, String reason);
}
