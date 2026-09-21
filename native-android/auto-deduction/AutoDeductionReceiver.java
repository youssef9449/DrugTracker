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
 * Durable fire work performs synchronous commit() disk I/O, so it runs on a
 * background thread via {@link #goAsync()}: the main thread is never blocked
 * (ANR safety) and the broadcast result is held until the work finishes.
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
 *   <li>FAILED without pending — do not advance recurrence; schedule a bounded
 *       same-occurrence retry alarm (see
 *       {@link AutoDeductionScheduler#scheduleFireRetry})</li>
 * </ul>
 * The receiver payload for a duplicate D delivery is not authoritative recurrence
 * configuration for an existing D+1.
 */
public class AutoDeductionReceiver extends BroadcastReceiver {

    private static final String TAG = "AutoDeductionReceiver";

    /**
     * JS is woken only when this delivery produced NEW durable FIRED evidence:
     * a newly-created main FIRED row or a durable pending-fire fallback.
     * ALREADY_EXISTS is deliberately not re-emitted because that occurrence
     * already produced its wake-up when it first became durable.
     */
    static boolean shouldNotifyJavascript(AutoDeductionScheduler.FireResult result) {
        return result != null
                && (result.status == AutoDeductionScheduler.FireResult.Status.CREATED
                || (result.status == AutoDeductionScheduler.FireResult.Status.FAILED
                && result.pendingRecorded));
    }

    /**
     * Retry gate for a FAILED fire without durable pending evidence: retry while
     * the bounded per-occurrence retry budget is not exhausted. Pure decision —
     * unit tested without Robolectric.
     */
    static boolean shouldScheduleFireRetry(
            AutoDeductionScheduler.FireResult result, int fireRetryCount) {
        return result != null
                && result.status == AutoDeductionScheduler.FireResult.Status.FAILED
                && !result.pendingRecorded
                && fireRetryCount < AutoDeductionContract.MAX_FIRE_RETRIES;
    }

    /**
     * Native stock application failure is retryable even when FIRED persistence
     * itself succeeded (CREATED / ALREADY_EXISTS). Re-delivery is occurrence-
     * idempotent and therefore safe for stock repair.
     */
    static boolean shouldScheduleStockRetry(
            AutoDeductionScheduler.FireResult result, int fireRetryCount) {
        return result != null
                && result.allowsRecurrence()
                && fireRetryCount < AutoDeductionContract.MAX_FIRE_RETRIES;
    }

    static void notifyJavascript(
            Context context,
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount
    ) {
        Intent event = new Intent(AutoDeductionContract.ACTION_AUTO_DEDUCTION_FIRED);
        event.setPackage(context.getPackageName());
        event.putExtra(AutoDeductionContract.EXTRA_MEDICATION_ID, medicationId);
        event.putExtra(AutoDeductionContract.EXTRA_DOSE_ID, doseId);
        event.putExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE, calendarDate);
        event.putExtra(AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, scheduledAt);
        event.putExtra(AutoDeductionContract.EXTRA_AMOUNT, amount);
        context.sendBroadcast(event);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (!AutoDeductionContract.ACTION_AUTO_DEDUCTION.equals(action)) {
            return;
        }

        final String medicationId = intent.getStringExtra(
                AutoDeductionContract.EXTRA_MEDICATION_ID);
        final String doseId = intent.getStringExtra(AutoDeductionContract.EXTRA_DOSE_ID);
        final String calendarDate = intent.getStringExtra(
                AutoDeductionContract.EXTRA_CALENDAR_DATE);
        final long scheduledAt = intent.getLongExtra(
                AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, 0L);
        final double amount = intent.getDoubleExtra(
                AutoDeductionContract.EXTRA_AMOUNT, Double.NaN);
        final String timeHhmm = intent.getStringExtra(AutoDeductionContract.EXTRA_TIME_HHMM);
        final long recurrenceGeneration = intent.getLongExtra(
                AutoDeductionContract.EXTRA_RECURRENCE_GENERATION, 0L);
        final String deliveryOperationVersion = intent.getStringExtra(
                AutoDeductionContract.EXTRA_OPERATION_VERSION);
        final String legacyScheduleVersion = intent.getStringExtra(
                AutoDeductionContract.EXTRA_SCHEDULE_VERSION);
        final String operationVersion =
                deliveryOperationVersion != null && !deliveryOperationVersion.isEmpty()
                        ? deliveryOperationVersion
                        : legacyScheduleVersion;
        final int fireRetryCount = intent.getIntExtra(
                AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT, 0);

        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w(TAG, "reject fire: invalid payload");
            return;
        }

        // Durable fire work below performs synchronous commit() disk I/O. Move it
        // off the main thread and keep the broadcast alive (goAsync) until the
        // work finishes so the process is not frozen mid-write.
        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                handleFireDelivery(
                        appContext, medicationId, doseId, calendarDate,
                        scheduledAt, amount, timeHhmm,
                        recurrenceGeneration, operationVersion, fireRetryCount);
            } catch (Exception e) {
                Log.e(TAG, "auto-deduction fire delivery failed", e);
            } finally {
                pendingResult.finish();
            }
        }, "auto-deduction-fire").start();
    }

    /**
     * Full durable fire delivery for one occurrence identity. Package-private
     * static so JVM tests can exercise the exact receiver path synchronously.
     */
    static void handleFireDelivery(
            Context context,
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String operationVersion,
            int fireRetryCount
    ) {
        AutoDeductionScheduler scheduler = new AutoDeductionScheduler(context);

        boolean hasIndependentEvidence = scheduler.getIndependentFireRetryEvidence(
                medicationId, doseId, calendarDate) != null;
        // Explicit path: independent recovery vs live authorized fire.
        final boolean independentRecoveryPath =
                hasIndependentEvidence || fireRetryCount > 0;

        AutoDeductionScheduler.FireResult result;
        if (independentRecoveryPath) {
            // Complete an already-authorized fire from durable independent evidence.
            // Does NOT require sch: and must NOT schedule recurrence successors.
            result = scheduler.recoverFireFromIndependentEvidence(
                    medicationId, doseId, calendarDate);
            if (result.status == AutoDeductionScheduler.FireResult.Status.FAILED
                    && !result.pendingRecorded
                    && !hasIndependentEvidence) {
                // Retry delivery without evidence — fall back to live path once.
                result = scheduler.fireOccurrenceIfNotCancelled(
                        medicationId, doseId, calendarDate, scheduledAt, amount,
                        operationVersion, recurrenceGeneration);
                // Fall-through became a live fire path.
                handleLiveFireResult(
                        context, scheduler, result,
                        medicationId, doseId, calendarDate, scheduledAt, amount,
                        timeHhmm, recurrenceGeneration, operationVersion, fireRetryCount);
                return;
            }
            handleIndependentRecoveryResult(
                    context, scheduler, result,
                    medicationId, doseId, calendarDate, scheduledAt, amount,
                    timeHhmm, recurrenceGeneration, operationVersion, fireRetryCount);
            return;
        }

        // Live authorized alarm delivery — ownership tokens apply.
        result = scheduler.fireOccurrenceIfNotCancelled(
                medicationId, doseId, calendarDate, scheduledAt, amount,
                operationVersion, recurrenceGeneration);
        handleLiveFireResult(
                context, scheduler, result,
                medicationId, doseId, calendarDate, scheduledAt, amount,
                timeHhmm, recurrenceGeneration, operationVersion, fireRetryCount);
    }

    /** Independent evidence recovery: FIRED/pending only — never scheduleNext. */
    private static void handleIndependentRecoveryResult(
            Context context,
            AutoDeductionScheduler scheduler,
            AutoDeductionScheduler.FireResult result,
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String operationVersion,
            int fireRetryCount
    ) {
        if (shouldNotifyJavascript(result)) {
            notifyJavascript(
                    context, medicationId, doseId, calendarDate, scheduledAt, amount);
        }

        if (result.allowsRecurrence()) {
            AutoDeductionStockStore.AutoApplyResult stockResult =
                    new AutoDeductionStockStore(context).applyAutoDeduction(
                            medicationId, doseId, calendarDate, amount);
            if (!stockResult.ok) {
                Log.e(TAG, "independent recovery native stock apply failed: "
                        + medicationId + "/" + doseId + "/" + calendarDate
                        + " — " + stockResult.error);
                if (shouldScheduleStockRetry(result, fireRetryCount)) {
                    boolean retryScheduled = scheduler.scheduleFireRetry(
                            medicationId, doseId, calendarDate, scheduledAt, amount,
                            timeHhmm, recurrenceGeneration, operationVersion,
                            fireRetryCount + 1);
                    if (retryScheduled) {
                        Log.w(TAG, "independent recovery stock failure — retry #"
                                + (fireRetryCount + 1) + " scheduled");
                    }
                }
                return;
            }
        }

        switch (result.status) {
            case CANCELLED:
                Log.i(TAG, "independent recovery cancelled (no prior evidence): "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                break;
            case CREATED:
            case ALREADY_EXISTS:
                Log.i(TAG, "independent recovery durable FIRED (no successor): "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                // Intentionally no scheduleNextIfPossible — past fire recovery only.
                break;
            case FAILED:
                if (result.pendingRecorded) {
                    Log.w(TAG, "independent recovery pending recorded (no successor): "
                            + medicationId + "/" + doseId + "/" + calendarDate);
                } else if (shouldScheduleStockRetry(result, fireRetryCount)) {
                    boolean retryScheduled = scheduler.scheduleFireRetry(
                            medicationId, doseId, calendarDate, scheduledAt, amount,
                            timeHhmm, recurrenceGeneration, operationVersion,
                            fireRetryCount + 1);
                    if (retryScheduled) {
                        Log.w(TAG, "independent recovery FAILED — retry #"
                                + (fireRetryCount + 1) + " scheduled: "
                                + medicationId + "/" + doseId + "/" + calendarDate);
                    } else {
                        Log.e(TAG, "independent recovery FAILED and retry not scheduled: "
                                + medicationId + "/" + doseId + "/" + calendarDate);
                    }
                } else {
                    Log.e(TAG, "independent recovery FAILED after max retries: "
                            + medicationId + "/" + doseId + "/" + calendarDate);
                }
                break;
        }
    }

    /** Live authorized fire — may advance recurrence when fire is durable. */
    private static void handleLiveFireResult(
            Context context,
            AutoDeductionScheduler scheduler,
            AutoDeductionScheduler.FireResult result,
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String operationVersion,
            int fireRetryCount
    ) {
        if (shouldNotifyJavascript(result)) {
            notifyJavascript(
                    context, medicationId, doseId, calendarDate, scheduledAt, amount);
        }

        if (result.allowsRecurrence()) {
            AutoDeductionStockStore.AutoApplyResult stockResult =
                    new AutoDeductionStockStore(context).applyAutoDeduction(
                            medicationId, doseId, calendarDate, amount);
            if (!stockResult.ok) {
                Log.e(TAG, "live fire native stock apply failed: "
                        + medicationId + "/" + doseId + "/" + calendarDate
                        + " — " + stockResult.error);
                if (shouldScheduleFireRetry(result, fireRetryCount)) {
                    boolean retryScheduled = scheduler.scheduleFireRetry(
                            medicationId, doseId, calendarDate, scheduledAt, amount,
                            timeHhmm, recurrenceGeneration, operationVersion,
                            fireRetryCount + 1);
                    if (retryScheduled) {
                        Log.w(TAG, "live fire stock failure — retry #"
                                + (fireRetryCount + 1) + " scheduled");
                    }
                }
                return;
            }
        }

        switch (result.status) {
            case CANCELLED:
                Log.i(TAG, "stale fire ignored (cancel linearized first): "
                        + medicationId + "/" + doseId + "/" + calendarDate);
                break;
            case CREATED:
                Log.i(TAG, "FIRED event persisted: "
                        + medicationId + "/" + doseId + "/" + calendarDate);
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
                } else if (shouldScheduleFireRetry(result, fireRetryCount)) {
                    boolean retryScheduled = scheduler.scheduleFireRetry(
                            medicationId, doseId, calendarDate, scheduledAt, amount,
                            timeHhmm, recurrenceGeneration, operationVersion,
                            fireRetryCount + 1);
                    if (retryScheduled) {
                        Log.w(TAG, "FIRED persistence FAILED (no pending) — retry #"
                                + (fireRetryCount + 1) + " scheduled: "
                                + medicationId + "/" + doseId + "/" + calendarDate);
                    } else {
                        Log.e(TAG, "FIRED persistence FAILED (no pending) and retry "
                                + "could not be scheduled: "
                                + medicationId + "/" + doseId + "/" + calendarDate);
                    }
                } else {
                    Log.e(TAG, "FIRED persistence FAILED (no pending) after max retries "
                            + "— occurrence recovery deferred to next restore: "
                            + medicationId + "/" + doseId + "/" + calendarDate);
                }
                break;
        }
    }

    private static void scheduleNextIfPossible(
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