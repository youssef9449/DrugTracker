package app.drugtracker.autodeduction;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Dedicated BroadcastReceiver for exact-time auto-deduction alarms.
 * Persists FIRED events only — does NOT mutate stock or depend on WebView.
 *
 * Handles:
 * <ul>
 *   <li>{@link AutoDeductionContract#ACTION_AUTO_DEDUCTION} — exact fire path</li>
 *   <li>{@link Intent#ACTION_BOOT_COMPLETED} / QUICKBOOT — restore future schedules</li>
 *   <li>{@link AlarmManager#ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED}
 *       — re-restore when exact-alarm permission is granted again (API 31+)</li>
 * </ul>
 *
 * FIRED insertion result drives next-occurrence scheduling:
 * <ul>
 *   <li>CREATED / ALREADY_EXISTS — current occurrence is durably recorded;
 *       schedule next is safe/idempotent</li>
 *   <li>FAILED — current occurrence is NOT confirmed in the main ledger;
 *       a pending-fire record may have been written for later promotion.
 *       Do not advance recurrence as though the fire succeeded.</li>
 * </ul>
 */
public class AutoDeductionReceiver extends BroadcastReceiver {

    private static final String TAG = "AutoDeductionReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            onBootOrPermissionRestored(context, "BOOT");
            return;
        }

        // API 31+: exact-alarm permission granted/revoked. When granted again,
        // re-install future alarms from durable schedule metadata.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                && AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            onBootOrPermissionRestored(context, "EXACT_ALARM_PERMISSION");
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
        AutoDeductionEventStore.InsertFiredResult result = store.insertFiredIfAbsent(
                medicationId, doseId, calendarDate, scheduledAt, amount);

        switch (result.status) {
            case CREATED:
                Log.i(TAG, "FIRED event persisted: " + medicationId + "/" + doseId + "/" + calendarDate);
                scheduleNextIfPossible(context, medicationId, doseId, calendarDate, timeHhmm, amount);
                break;
            case ALREADY_EXISTS:
                Log.i(TAG, "duplicate fire ignored (idempotent): "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                scheduleNextIfPossible(context, medicationId, doseId, calendarDate, timeHhmm, amount);
                break;
            case FAILED:
                Log.e(TAG, "FIRED persistence FAILED (pendingRecorded="
                        + result.pendingRecorded + ") — not advancing next occurrence: "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                break;
        }
    }

    private void scheduleNextIfPossible(
            Context context,
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount
    ) {
        if (timeHhmm == null || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            return;
        }
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
        AutoDeductionScheduler.ScheduleResult next = scheduler.scheduleNextOccurrence(
                medicationId, doseId, calendarDate, timeHhmm, amount);
        if (!next.ok) {
            Log.w(TAG, "next occurrence not scheduled: " + next.error);
        }
    }

    private void onBootOrPermissionRestored(Context context, String reason) {
        try {
            AutoDeductionEventStore store = new AutoDeductionEventStore(context);
            int promoted = store.promotePendingFires();
            if (promoted > 0) {
                Log.i(TAG, reason + ": promoted " + promoted + " pending-fire record(s) to FIRED");
            }
            AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
            if (!scheduler.canScheduleExactAlarms()) {
                Log.w(TAG, reason + ": exact alarm permission not granted — skip restore");
                return;
            }
            int n = scheduler.restoreFutureSchedules();
            Log.i(TAG, reason + ": restored " + n + " future auto-deduction alarms");
        } catch (Exception e) {
            Log.e(TAG, reason + " restore failed", e);
        }
    }
}
