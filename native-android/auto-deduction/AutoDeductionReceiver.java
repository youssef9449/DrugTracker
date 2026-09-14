package app.drugtracker.autodeduction;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Dedicated BroadcastReceiver for exact-time auto-deduction alarms.
 * Persists FIRED events only — does NOT mutate stock or depend on WebView.
 */
public class AutoDeductionReceiver extends BroadcastReceiver {

    private static final String TAG = "AutoDeductionReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            onBoot(context);
            return;
        }

        if (!AutoDeductionContract.ACTION_AUTO_DEDUCTION.equals(action)) {
            return;
        }

        String medicationId = intent.getStringExtra(AutoDeductionContract.EXTRA_MEDICATION_ID);
        String doseId = intent.getStringExtra(AutoDeductionContract.EXTRA_DOSE_ID);
        String calendarDate = intent.getStringExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE);
        long scheduledAt = intent.getLongExtra(AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, 0L);
        double amount = intent.getDoubleExtra(AutoDeductionContract.EXTRA_AMOUNT, Double.NaN);
        String timeHhmm = intent.getStringExtra(AutoDeductionContract.EXTRA_TIME_HHMM);

        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w(TAG, "reject fire: invalid payload");
            return;
        }

        AutoDeductionEventStore store = new AutoDeductionEventStore(context);
        boolean created = store.insertFiredIfAbsent(
                medicationId, doseId, calendarDate, scheduledAt, amount);
        if (created) {
            Log.i(TAG, "FIRED event persisted: " + medicationId + "/" + doseId + "/" + calendarDate);
        } else {
            Log.i(TAG, "duplicate fire ignored (idempotent)");
        }

        if (timeHhmm != null && AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
            AutoDeductionScheduler.ScheduleResult next = scheduler.scheduleNextOccurrence(
                    medicationId, doseId, calendarDate, timeHhmm, amount);
            if (!next.ok) {
                Log.w(TAG, "next occurrence not scheduled: " + next.error);
            }
        }
    }

    private void onBoot(Context context) {
        try {
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
            int n = scheduler.restoreFutureSchedules();
            Log.i(TAG, "BOOT_COMPLETED: restored " + n + " future auto-deduction alarms");
        } catch (Exception e) {
            Log.e(TAG, "BOOT restore failed", e);
        }
    }
}
