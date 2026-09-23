package app.drugtracker.dosereminder;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import app.drugtracker.notificationruntime.NotificationRuntime;

/**
 * Exact-alarm delivery receiver for Dose Reminder.
 *
 * <p>Exact timing is owned by ExactAlarmRuntime. Notification presentation is
 * delegated to NotificationRuntime. Daily recurrence is kept here as Dose
 * Reminder feature behavior.</p>
 */
public final class DoseReminderAlarmReceiver extends BroadcastReceiver {
    private static final String NAMESPACE = "dose-reminder";
    private static final String BG_CHANNEL_ID = "dose-reminder-v3";
    private static final String BG_CHANNEL_NAME = "تذكير الجرعات";
    private static final String FG_CHANNEL_ID = "dose-reminder-foreground-v1";
    private static final String FG_CHANNEL_NAME = "تذكير الجرعات (أثناء التشغيل)";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!DoseReminderAlarmAdapter.ACTION_DOSE_REMINDER.equals(action)
                && !DoseReminderAlarmAdapter.ACTION_DOSE_SNOOZE.equals(action)) {
            return;
        }

        PendingResult pendingResult = goAsync();
        Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                deliver(appContext, intent, action);
            } finally {
                pendingResult.finish();
            }
        }, "dose-reminder-alarm").start();
    }

    private void deliver(Context context, Intent intent, String action) {
        String medicationId = intent.getStringExtra("medicationId");
        String doseId = intent.getStringExtra("doseId");
        String medicationName = intent.getStringExtra("medicationName");
        String unit = intent.getStringExtra("unit");
        String doseDescription = intent.getStringExtra("doseDescription");
        String reminderTime = intent.getStringExtra("reminderTime");
        double amount = intent.getDoubleExtra("amount", 0d);
        boolean allowManualTakeAction = intent.getBooleanExtra(
                "allowManualTakeAction", true);
        String operationVersion = intent.getStringExtra(
                app.drugtracker.alarmruntime.ExactAlarmContract.EXTRA_OPERATION_VERSION);

        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || amount <= 0d
                || operationVersion == null
                || operationVersion.isEmpty()) {
            return;
        }

        DoseReminderAlarmAdapter adapter =
                new DoseReminderAlarmAdapter(context);
        boolean snooze =
                DoseReminderAlarmAdapter.ACTION_DOSE_SNOOZE.equals(action);

        // Ownership check is the delivery linearization point. A cancellation
        // or replacement that acquires the shared lock first invalidates this
        // delivery before notification side effects are allowed.
        if (snooze) {
            if (!adapter.ownsActiveSnooze(
                    medicationId,
                    doseId,
                    operationVersion)) {
                return;
            }

            // Consume the durable one-shot before posting. This closes the
            // reboot/process-death replay window: a delivered snooze has no
            // durable row left to restore.
            if (!adapter.completeSnooze(
                    medicationId,
                    doseId,
                    operationVersion)) {
                return;
            }
        } else {
            if (!adapter.ownsActiveOccurrence(
                    medicationId,
                    doseId,
                    operationVersion)) {
                return;
            }

            org.json.JSONObject metadata =
                    adapter.getScheduleMetadata(
                            medicationId,
                            doseId);
            if (metadata == null
                    || !app.drugtracker.alarmruntime.ExactAlarmContract
                            .isMetadataOwnedByOperationVersion(
                                    metadata,
                                    operationVersion)) {
                return;
            }

            String treatmentEndDate =
                    metadata.optString("treatmentEndDate", "");
            String scheduledCalendarDate =
                    metadata.optString("calendarDate", "");
            if (!treatmentEndDate.isEmpty()
                    && (!app.drugtracker.alarmruntime.ExactAlarmContract
                            .isValidCalendarDate(treatmentEndDate)
                    || !app.drugtracker.alarmruntime.ExactAlarmContract
                            .isValidCalendarDate(scheduledCalendarDate)
                    || scheduledCalendarDate.compareTo(treatmentEndDate) > 0)) {
                return;
            }

            // Arm D+1 before posting D. If the process is killed after the
            // notification is posted, the successor is already durable and
            // pending. A failed successor installation leaves the current
            // durable row retryable; the current notification can still be
            // delivered.
            scheduleNextDay(
                    context,
                    medicationId,
                    doseId,
                    medicationName,
                    unit,
                    doseDescription,
                    reminderTime,
                    amount,
                    allowManualTakeAction,
                    operationVersion,
                    scheduledCalendarDate);
        }

        boolean foreground = app.drugtracker.notificationruntime.AppForegroundState.isForeground();
        String channelId = foreground ? FG_CHANNEL_ID : BG_CHANNEL_ID;
        String channelName = foreground ? FG_CHANNEL_NAME : BG_CHANNEL_NAME;
        int importance = foreground ? 2 : 4;

        NotificationRuntime.Action notificationAction = null;
        if (allowManualTakeAction) {
            notificationAction = new NotificationRuntime.Action(
                    "take_dose",
                    "تم أخذ الجرعة",
                    true);
        }

        String title = snooze
                ? "تذكير مجدد: " + medicationName
                : "حان موعد دواء: " + medicationName;
        String description = doseDescription == null ? "" : doseDescription.trim();
        String body = snooze
                ? "جرعتك المقررة: " + amount + " " + (unit == null ? "قرص" : unit)
                : "موعد الجرعة الساعة " + (reminderTime == null ? "" : reminderTime)
                        + ". جرعتك المقررة: " + amount + " "
                        + (unit == null ? "قرص" : unit);
        if (!description.isEmpty()) {
            body += ". طريقة تناول الجرعة: " + description;
        }
        body += ".";

        NotificationRuntime.Request request =
                new NotificationRuntime.Request(
                        NAMESPACE,
                        medicationId + "::" + doseId,
                        title,
                        body,
                        channelId,
                        channelName,
                        importance,
                        1,
                        "ic_launcher",
                        true,
                        false,
                        notificationAction);
        NotificationRuntime runtime = new NotificationRuntime(context);
        NotificationRuntime.PostResult result = runtime.post(request);
        if (!result.accepted && !"notifications_disabled".equals(result.error)) {
            try {
                Thread.sleep(1000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            result = runtime.post(request);
            if (!result.accepted && !"notifications_disabled".equals(result.error)) {
                try {
                    Thread.sleep(4000L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                runtime.post(request);
            }
        }
    }

    private void scheduleNextDay(
            Context context,
            String medicationId,
            String doseId,
            String medicationName,
            String unit,
            String doseDescription,
            String reminderTime,
            double amount,
            boolean allowManualTakeAction,
            String expectedOperationVersion,
            String firedCalendarDate) {
        if (reminderTime == null || reminderTime.length() < 4) return;
        String[] parts = reminderTime.split(":");
        if (parts.length < 2) return;
        int hour;
        int minute;
        try {
            hour = Integer.parseInt(parts[0]);
            minute = Integer.parseInt(parts[1]);
        } catch (NumberFormatException e) {
            return;
        }
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;

        java.util.Calendar next = java.util.Calendar.getInstance();
        if (firedCalendarDate != null
                && app.drugtracker.alarmruntime.ExactAlarmContract
                        .isValidCalendarDate(firedCalendarDate)) {
            try {
                String[] dateParts = firedCalendarDate.split("-");
                next.clear();
                next.set(
                        Integer.parseInt(dateParts[0]),
                        Integer.parseInt(dateParts[1]) - 1,
                        Integer.parseInt(dateParts[2]),
                        0,
                        0,
                        0);
                next.set(java.util.Calendar.MILLISECOND, 0);
            } catch (RuntimeException ignored) {
                return;
            }
        }
        next.add(java.util.Calendar.DAY_OF_MONTH, 1);
        next.set(java.util.Calendar.HOUR_OF_DAY, hour);
        next.set(java.util.Calendar.MINUTE, minute);
        next.set(java.util.Calendar.SECOND, 0);
        next.set(java.util.Calendar.MILLISECOND, 0);

        DoseReminderAlarmAdapter adapter =
                new DoseReminderAlarmAdapter(context);
        org.json.JSONObject metadata =
                adapter.getScheduleMetadata(medicationId, doseId);
        String treatmentEndDate = metadata == null
                ? ""
                : metadata.optString("treatmentEndDate", "");
        String nextDate = String.format(
                java.util.Locale.US,
                "%04d-%02d-%02d",
                next.get(java.util.Calendar.YEAR),
                next.get(java.util.Calendar.MONTH) + 1,
                next.get(java.util.Calendar.DAY_OF_MONTH));
        if (!treatmentEndDate.isEmpty()
                && (!app.drugtracker.alarmruntime.ExactAlarmContract
                        .isValidCalendarDate(treatmentEndDate)
                || nextDate.compareTo(treatmentEndDate) > 0)) {
            return;
        }
        adapter.scheduleOccurrence(
                medicationId,
                doseId,
                reminderTime,
                amount,
                medicationName,
                unit,
                doseDescription,
                allowManualTakeAction,
                next.getTimeInMillis(),
                expectedOperationVersion,
                treatmentEndDate.isEmpty() ? null : treatmentEndDate);
    }
}
