package app.drugtracker.alarmruntime;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import app.drugtracker.dosereminder.DoseReminderAlarmAdapter;

/**
 * Shared-lifecycle adapter for Dose Reminder.
 *
 * <p>The adapter restores durable Dose Reminder exact alarms without making
 * React or Capacitor Local Notifications the source of timing truth.</p>
 */
public final class DoseReminderAlarmFeature
        implements ExactAlarmFeatureAdapter {

    private static final String TAG = "DoseReminderAlarmFeature";

    @Override
    public void restore(
            Context context,
            String reason,
            boolean exactAlarmPermissionGranted) {
        if (!exactAlarmPermissionGranted) {
            return;
        }

        DoseReminderAlarmAdapter adapter =
                new DoseReminderAlarmAdapter(context);
        for (String key : adapter.listScheduledKeys()) {
            String[] parts = key.split("::", 2);
            if (parts.length != 2
                    || parts[0].isEmpty()
                    || parts[1].isEmpty()) {
                continue;
            }

            String medicationId = parts[0];
            String doseId = parts[1];
            JSONObject meta = adapter.getScheduleMetadata(
                    medicationId,
                    doseId);
            if (meta == null) {
                continue;
            }

            String reminderTime = meta.optString("reminderTime", "");
            if (reminderTime.isEmpty()) {
                continue;
            }
            String medicationName = meta.optString(
                    "medicationName", "");
            String unit = meta.optString("unit", "قرص");
            String doseDescription = meta.optString("doseDescription", "");
            double amount = meta.optDouble("amount", 0d);
            boolean allowManualTakeAction = meta.optBoolean(
                    "allowManualTakeAction", true);
            String calendarDate = meta.optString(
                    "calendarDate", "");
            String operationVersion = meta.optString(
                    ExactAlarmContract.FIELD_OPERATION_VERSION,
                    ExactAlarmContract.LEGACY_FIELD_SCHEDULE_VERSION);

            long trigger = ExactAlarmContract.resolveLocalDateTimeEpochMs(calendarDate, reminderTime, false);
            long now = System.currentTimeMillis();
            if (trigger <= now) {
                trigger = advanceOneCalendarDay(
                        calendarDate,
                        reminderTime,
                        now);
            }
            if (trigger <= now || amount <= 0d) {
                continue;
            }

            DoseReminderAlarmAdapter.ScheduleResult result =
                    adapter.scheduleOccurrence(
                            medicationId,
                            doseId,
                            reminderTime,
                            amount,
                            medicationName,
                            unit,
                            doseDescription,
                            allowManualTakeAction,
                            trigger,
                            operationVersion.isEmpty()
                                    ? null
                                    : operationVersion);
            if (!result.ok) {
                Log.w(
                        TAG,
                        reason
                                + ": failed to restore "
                                + key
                                + " ("
                                + result.error
                                + ")");
            }
        }
    }

    private static long advanceOneCalendarDay(
            String calendarDate,
            String reminderTime,
            long now) {
        long trigger = ExactAlarmContract.resolveLocalDateTimeEpochMs(calendarDate, reminderTime, false);
        if (trigger <= 0L) {
            return -1L;
        }
        java.util.Calendar cal =
                java.util.Calendar.getInstance();
        cal.setTimeInMillis(trigger);
        do {
            cal.add(
                    java.util.Calendar.DAY_OF_MONTH,
                    1);
            trigger = cal.getTimeInMillis();
        } while (trigger <= now);
        return trigger;
    }
}
