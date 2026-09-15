package app.drugtracker.autodeduction;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Private exact-alarm delivery receiver for ACTION_AUTO_DEDUCTION only.
 * Registered android:exported="false" — targeted solely via explicit
 * AlarmManager PendingIntent. Does NOT handle boot or permission broadcasts.
 *
 * Fire vs cancel is linearized under the scheduler SCHEDULE_LOCK via
 * {@link AutoDeductionScheduler#fireOccurrenceIfNotCancelled}: the effective
 * cancellation check and durable FIRED/pending transition are one serialized
 * operation. If cancel linearizes first, this delivery is stale — no FIRED,
 * no pending, no next recurrence. If fire linearizes first, FIRED/pending is
 * durable before any concurrent cancel can observe the occurrence as still open.
 *
 * Fire linearization result drives next-occurrence scheduling:
 * <ul>
 *   <li>CREATED / ALREADY_EXISTS / FAILED with pending-fire — ensure next via
 *       {@link AutoDeductionScheduler#scheduleNextOccurrenceIfAbsent} (never
 *       overwrite an already-present successor with this delivery's payload)</li>
 *   <li>CANCELLED — no recurrence</li>
 *   <li>FAILED without pending — do not advance recurrence</li>
 * </ul>
 * The receiver payload for a duplicate D delivery is not authoritative recurrence
 * configuration for an existing D+1.
 */
public class AutoDeductionReceiver extends BroadcastReceiver {

    private static final String TAG = "AutoDeductionReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (!AutoDeductionContract.ACTION_AUTO_DEDUCTION.equals(action)) {
            return;
        }

        String medicationId = intent.getStringExtra(AutoDeductionContract.EXTRA_MEDICATION_ID);
        String doseId = intent.getStringExtra(AutoDeductionContract.EXTRA_DOSE_ID);
        String calendarDate = intent.getStringExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE);
        long scheduledAt = intent.getLongExtra(AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, 0L);
        double amount = intent.getDoubleExtra(AutoDeductionContract.EXTRA_AMOUNT, Double.NaN);
        String timeHhmm = intent.getStringExtra(AutoDeductionContract.EXTRA_TIME_HHMM);
        long recurrenceGeneration = intent.getLongExtra(
                AutoDeductionContract.EXTRA_RECURRENCE_GENERATION, 0L);
        String scheduleVersion = intent.getStringExtra(
                AutoDeductionContract.EXTRA_SCHEDULE_VERSION);

        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w(TAG, "reject fire: invalid payload");
            return;
        }

        // Serialized fire transition: cancel-check + FIRED/pending under SCHEDULE_LOCK.
        // Eliminates TOCTOU where cancel could interleave after a non-cancelled check
        // but before durable FIRED persistence.
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
        // Issue #240: pass delivery ownership tokens so a queued alarm from a
        // prior scheduleVersion/generation cannot FIRE after disable→reschedule.
        AutoDeductionScheduler.FireResult result = scheduler.fireOccurrenceIfNotCancelled(
                medicationId, doseId, calendarDate, scheduledAt, amount,
                scheduleVersion, recurrenceGeneration);

        switch (result.status) {
            case CANCELLED:
                Log.i(TAG, "stale fire ignored (cancel linearized first): "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                break;
            case CREATED:
                Log.i(TAG, "FIRED event persisted: " + medicationId + "/" + doseId + "/" + calendarDate);
                scheduleNextIfPossible(
                        context, medicationId, doseId, calendarDate, timeHhmm, amount,
                        recurrenceGeneration);
                break;
            case ALREADY_EXISTS:
                Log.i(TAG, "duplicate fire ignored (idempotent): "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                scheduleNextIfPossible(
                        context, medicationId, doseId, calendarDate, timeHhmm, amount,
                        recurrenceGeneration);
                break;
            case FAILED:
                if (result.pendingRecorded) {
                    Log.w(TAG, "FIRED primary failed but pending recorded — advancing recurrence: "
                            + medicationId + "/" + doseId + "/" + calendarDate);
                    scheduleNextIfPossible(
                            context, medicationId, doseId, calendarDate, timeHhmm, amount,
                            recurrenceGeneration);
                } else {
                    Log.e(TAG, "FIRED persistence FAILED (no pending) — not advancing next occurrence: "
                            + medicationId + "/" + doseId + "/" + calendarDate);
                }
                break;
        }
    }

    private void scheduleNextIfPossible(
            Context context,
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long recurrenceGeneration
    ) {
        if (timeHhmm == null || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            return;
        }
        // Create-if-absent: duplicate/stale D payload must not overwrite an
        // already-correct D+1 (amount/time) that durable schedule metadata holds.
        // Issue #217: pass firing generation so disable/cancel after FIRED cannot
        // create a successor for an invalidated recurrence chain.
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);
        AutoDeductionScheduler.ScheduleResult next = scheduler.scheduleNextOccurrenceIfAbsent(
                medicationId, doseId, calendarDate, timeHhmm, amount, recurrenceGeneration);
        if (!next.ok) {
            Log.w(TAG, "next occurrence not scheduled: " + next.error);
        }
    }
}
