package app.drugtracker.alarmruntime;

import android.app.AlarmManager;
import android.content.Context;
import android.os.Build;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Shared system-lifecycle dispatcher.
 *
 * <p>This class owns adapter discovery and the single platform exact-alarm
 * permission check. Feature business rules remain in adapters.</p>
 */
public final class ExactAlarmLifecycle {
    private static final String TAG = "ExactAlarmLifecycle";

    public static final String FEATURE_ADAPTERS_META_DATA =
            "app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS";

    private ExactAlarmLifecycle() {}

    /** Shared exact-alarm capability check for all lifecycle-aware features. */
    public static boolean canScheduleExactAlarms(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        AlarmManager manager = (AlarmManager) context
                .getApplicationContext()
                .getSystemService(Context.ALARM_SERVICE);
        return manager != null && manager.canScheduleExactAlarms();
    }

    public static void restoreAll(
            Context context,
            String reason) {
        Context appContext = context.getApplicationContext();
        boolean exactAlarmPermissionGranted =
                canScheduleExactAlarms(appContext);

        for (String className : adapterClassNames(appContext)) {
            try {
                Class<?> clazz = Class.forName(className);
                if (!ExactAlarmFeatureAdapter.class
                        .isAssignableFrom(clazz)) {
                    Log.e(TAG,
                            "ignored non-feature adapter: "
                                    + className);
                    continue;
                }

                @SuppressWarnings("deprecation")
                ExactAlarmFeatureAdapter adapter =
                        (ExactAlarmFeatureAdapter) clazz.newInstance();
                adapter.restore(
                        appContext,
                        reason,
                        exactAlarmPermissionGranted);
            } catch (Exception e) {
                Log.e(TAG,
                        "feature exact-alarm restore failed: "
                                + className,
                        e);
            }
        }
    }

    private static List<String> adapterClassNames(
            Context context) {
        List<String> result = new ArrayList<>();
        try {
            ApplicationInfo info =
                    context.getPackageManager()
                            .getApplicationInfo(
                                    context.getPackageName(),
                                    PackageManager.GET_META_DATA);
            Bundle metaData = info.metaData;
            if (metaData == null) return result;

            String csv = metaData.getString(
                    FEATURE_ADAPTERS_META_DATA,
                    "");
            if (csv == null || csv.trim().isEmpty()) {
                return result;
            }

            for (String raw : csv.split(",")) {
                String className = raw.trim();
                if (!className.isEmpty()) {
                    result.add(className);
                }
            }
        } catch (Exception e) {
            Log.e(TAG,
                    "failed to read exact-alarm adapters",
                    e);
        }
        return result;
    }
}
