package app.drugtracker.alarmruntime;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import app.drugtracker.criticalstock.CriticalStockAlarmAdapter;
import app.drugtracker.notificationruntime.NotificationRuntime;

/**
 * Shared-lifecycle adapter for Critical Stock.
 *
 * <p>Critical Stock owns the decision that an episode has a future crossing;
 * this adapter only restores the already-persisted one-shot exact alarm.</p>
 */
public final class CriticalStockAlarmFeature
        implements ExactAlarmFeatureAdapter {

    private static final String TAG = "CriticalStockAlarmFeature";

    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        if (!exactAlarmPermissionGranted) {
            return;
        }
        if (!new NotificationRuntime(context).areNotificationsEnabled()) {
            return;
        }

        CriticalStockAlarmAdapter adapter =
                new CriticalStockAlarmAdapter(context);
        for (String medicationId :
                adapter.listScheduledMedicationIds()) {
            JSONObject meta =
                    adapter.getScheduleMetadata(medicationId);
            if (meta == null) {
                continue;
            }

            String medicationName = meta.optString(
                    "medicationName", "");
            String unit = meta.optString(
                    "unit", "قرص");
            String calendarDate = meta.optString(
                    "alarmDate", "");
            String alarmTime = meta.optString(
                    "alarmTime", "");
            String operationVersion = meta.optString(
                    ExactAlarmContract.FIELD_OPERATION_VERSION,
                    ExactAlarmContract.LEGACY_FIELD_SCHEDULE_VERSION);

            long trigger = resolve(calendarDate, alarmTime);
            long now = System.currentTimeMillis();
            if (trigger <= 0L) {
                continue;
            }

            // Preserve the previous Local Notifications recovery contract:
            // a past-due critical notification gets a short delivery window
            // after boot instead of being silently lost.
            if (trigger <= now) {
                trigger = now + 15_000L;
            }

            CriticalStockAlarmAdapter.ScheduleResult result =
                    adapter.schedule(
                            medicationId,
                            medicationName,
                            unit,
                            trigger,
                            operationVersion.isEmpty()
                                    ? null
                                    : operationVersion);
            if (!result.ok) {
                Log.w(
                        TAG,
                        reason
                                + ": failed to restore "
                                + medicationId
                                + " ("
                                + result.error
                                + ")");
            }
        }
    }

    private static long resolve(
            String calendarDate,
            String alarmTime) {
        if (calendarDate == null
                || calendarDate.isEmpty()
                || alarmTime == null
                || alarmTime.isEmpty()) {
            return -1L;
        }
        try {
            java.text.SimpleDateFormat format =
                    new java.text.SimpleDateFormat(
                            "yyyy-MM-dd HH:mm",
                            java.util.Locale.US);
            format.setLenient(false);
            java.util.Date parsed =
                    format.parse(calendarDate + " " + alarmTime);
            return parsed == null ? -1L : parsed.getTime();
        } catch (Exception e) {
            return -1L;
        }
    }
}
