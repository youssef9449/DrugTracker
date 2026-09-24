package app.drugtracker.autodeduction;

import android.content.Context;
import android.util.Log;
import app.drugtracker.autodeduction.AutoDeductionScheduler.FireResult;

/** Focused Auto-Deduction responsibility collaborator: AutoDeductionFireService. */
final class AutoDeductionFireService {
    private final AutoDeductionScheduler scheduler;

    AutoDeductionFireService(AutoDeductionScheduler scheduler) {
        this.scheduler = scheduler;
    }

public FireResult fireOccurrenceIfNotCancelled(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String deliveryOperationVersion,
            long deliveryRecurrenceGeneration
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w("AutoDeductionScheduler", "fireOccurrenceIfNotCancelled: invalid payload");
            return new FireResult(FireResult.Status.FAILED, false);
        }
        final String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (AutoDeductionScheduler.class) {
            // Re-entrant: isOccurrenceCancelledKey also synchronizes on AutoDeductionScheduler.class.
            if (scheduler.isOccurrenceCancelledKey(key)) {
                Log.i("AutoDeductionScheduler", "fire linearization: CANCELLED wins for " + key);
                return FireResult.cancelled();
            }
            // delivery must own the *current* schedule row.
            final String prefKey = key;
            final AutoDeductionPersistenceModels.ScheduleRecord schedule =
                    scheduler.schedulingAdapter().getScheduleRecord(prefKey);
            if (schedule == null) {
                Log.i("AutoDeductionScheduler", "fire linearization: STALE (no active schedule metadata) for " + key);
                return FireResult.cancelled();
            }
            // Tokenized delivery must own the current schedule row exactly.
            // Missing or mismatched operationVersion / recurrenceGeneration → STALE.
            String treatmentEndDate = schedule.treatmentEndDate;
            if (!treatmentEndDate.isEmpty()
                    && calendarDate.compareTo(treatmentEndDate) > 0) {
                Log.i("AutoDeductionScheduler",
                        "fire linearization: treatment expired for " + key);
                return FireResult.cancelled();
            }
            String activeVersion = schedule.operationVersion;
            long activeGen = scheduler.getRecurrenceGenerationLocked(medicationId, doseId);
            if (deliveryOperationVersion == null || deliveryOperationVersion.isEmpty()
                    || deliveryRecurrenceGeneration <= 0L) {
                Log.i("AutoDeductionScheduler",
                        "fire linearization: STALE delivery tokens for " + key);
                return FireResult.cancelled();
            }
            if (!deliveryOperationVersion.equals(activeVersion)
                    || deliveryRecurrenceGeneration != activeGen) {
                Log.i("AutoDeductionScheduler",
                        "fire linearization: STALE ownership tokens for " + key);
                return FireResult.cancelled();
            }
            AutoDeductionEventStore store = scheduler.eventStore();
            AutoDeductionEventStore.InsertFiredResult ir = store.insertFiredIfAbsent(
                    medicationId, doseId, calendarDate, scheduledAtEpochMs, amount);
            FireResult result = FireResult.fromInsert(ir);
            if (result.allowsRecurrence()) {
                String obligationTime = schedule.timeHhmm;
                String obligationEndDate = schedule.treatmentEndDate;
                // Persist the successor obligation BEFORE stock execution. The
                // obligation is the crash-recovery journal: if the process dies
                // anywhere after FIRED, recovery can idempotently re-apply stock
                // and then install the successor.
                boolean obligationSaved = scheduler.persistSuccessorObligation(
                        medicationId,
                        doseId,
                        calendarDate,
                        obligationTime,
                        amount,
                        obligationEndDate,
                        deliveryOperationVersion,
                        deliveryRecurrenceGeneration);
                if (!obligationSaved) {
                    scheduler.recordIndependentFireRetryEvidenceLocked(
                            medicationId, doseId, calendarDate, scheduledAtEpochMs,
                            amount, obligationTime, obligationEndDate,
                             deliveryRecurrenceGeneration,
                             deliveryOperationVersion, /*nextRetryCount=*/1);
                    Log.e("AutoDeductionScheduler",
                            "fire linearization: successor obligation persistence failed for " + key);
                    return new FireResult(FireResult.Status.FAILED, false);
                }
                AutoDeductionStockStore.AutoApplyResult stockResult =
                        new AutoDeductionStockStore(scheduler.appContext()).applyAutoDeductionForRecovery(
                                medicationId, doseId, calendarDate, amount);
                if (!stockResult.ok) {
                    Log.e("AutoDeductionScheduler", "fire linearization: Native stock apply failed for "
                            + key + " — " + stockResult.error);
                    scheduler.recordIndependentFireRetryEvidenceLocked(
                            medicationId, doseId, calendarDate, scheduledAtEpochMs,
                            amount, obligationTime, obligationEndDate,
                             deliveryRecurrenceGeneration,
                             deliveryOperationVersion, /*nextRetryCount=*/1);
                    return new FireResult(FireResult.Status.FAILED, false);
                }
                // Native stock is now durable. Mark that stage in the obligation.
                // A crash before this write is still safe because stock application
                // is occurrence-idempotent on recovery.
                if (!scheduler.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate)) {
                    scheduler.recordIndependentFireRetryEvidenceLocked(
                            medicationId, doseId, calendarDate, scheduledAtEpochMs,
                            amount, obligationTime, obligationEndDate,
                             deliveryRecurrenceGeneration,
                             deliveryOperationVersion, /*nextRetryCount=*/1);
                    Log.e("AutoDeductionScheduler",
                            "fire linearization: successor obligation stock state commit failed for " + key);
                    return new FireResult(FireResult.Status.FAILED, false);
                }
                scheduler.clearIndependentFireRetryEvidenceLocked(key);
            } else if (result.status == FireResult.Status.FAILED
                    && !result.pendingRecorded) {
                // FIRED persistence itself failed without an independent pending
                // record: keep retry evidence so the exact occurrence can be
                // reconstructed even if schedule metadata disappears.
                String timeHhmm = schedule.timeHhmm;
                String operationVersion = deliveryOperationVersion;
                long gen = deliveryRecurrenceGeneration;
                scheduler.recordIndependentFireRetryEvidenceLocked(
                        medicationId, doseId, calendarDate, scheduledAtEpochMs,
                        amount, timeHhmm, schedule.treatmentEndDate,
                         gen, operationVersion, /*nextRetryCount=*/1);
            }
            Log.i("AutoDeductionScheduler", "fire linearization: " + result.status
                    + " pendingRecorded=" + result.pendingRecorded + " for " + key);
            return result;
        }
    }

public FireResult recoverMissedOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            long expectedRecurrenceGeneration) {
        return recoverMissedOccurrence(
                medicationId,
                doseId,
                calendarDate,
                scheduledAtEpochMs,
                amount,
                expectedRecurrenceGeneration,
                "",
                "");
    }

public FireResult recoverMissedOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            long expectedRecurrenceGeneration,
            String treatmentEndDate,
            String fallbackTimeHhmm
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w("AutoDeductionScheduler", "recoverMissedOccurrence: invalid payload");
            return new FireResult(FireResult.Status.FAILED, false);
        }
        treatmentEndDate = treatmentEndDate == null ? "" : treatmentEndDate;
        fallbackTimeHhmm = fallbackTimeHhmm == null ? "" : fallbackTimeHhmm;
        if (!treatmentEndDate.isEmpty()
                && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
            return new FireResult(FireResult.Status.FAILED, false);
        }

        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (AutoDeductionScheduler.class) {
            if (scheduler.isOccurrenceCancelledKey(key)) {
                Log.i("AutoDeductionScheduler", "recoverMissed: CANCELLED occurrence " + key);
                return FireResult.cancelled();
            }
            if (!scheduler.isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                Log.i("AutoDeductionScheduler", "recoverMissed: generation not authorized for " + key
                        + " expectedGen=" + expectedRecurrenceGeneration);
                return FireResult.cancelled();
            }

            AutoDeductionEventStore store = scheduler.eventStore();
            AutoDeductionEventStore.InsertFiredResult ir = store.insertFiredIfAbsent(
                    medicationId, doseId, calendarDate, scheduledAtEpochMs, amount);
            FireResult result = FireResult.fromInsert(ir);
            if (!result.allowsRecurrence()) {
                return result;
            }

            AutoDeductionPersistenceModels.ScheduleRecord schedule =
                    scheduler.schedulingAdapter().getScheduleRecord(key);
            String obligationTime = schedule == null ? fallbackTimeHhmm : schedule.timeHhmm;
            if (!AutoDeductionContract.isValidTimeHhmm(obligationTime)) {
                return new FireResult(FireResult.Status.FAILED, false);
            }
            String obligationEndDate =
                    schedule == null || schedule.treatmentEndDate.isEmpty()
                            ? treatmentEndDate
                            : schedule.treatmentEndDate;
            String obligationVersion =
                    schedule == null ? "" : schedule.operationVersion;

            // Every recovered occurrence establishes its successor hand-off before
            // Native stock execution. An empty operationVersion explicitly denotes
            // an overdue catch-up occurrence whose consumed schedule row no longer
            // exists; recurrenceGeneration remains the ownership guard.
            if (!scheduler.persistSuccessorObligation(
                    medicationId,
                    doseId,
                    calendarDate,
                    obligationTime,
                    amount,
                    obligationEndDate,
                    obligationVersion,
                    expectedRecurrenceGeneration)) {
                Log.e("AutoDeductionScheduler",
                        "recoverMissed: successor obligation persistence failed for " + key);
                return new FireResult(FireResult.Status.FAILED, false);
            }

            AutoDeductionStockStore.AutoApplyResult stockResult =
                    new AutoDeductionStockStore(scheduler.appContext()).applyAutoDeductionForRecovery(
                            medicationId, doseId, calendarDate, amount);
            if (!stockResult.ok) {
                Log.e("AutoDeductionScheduler", "recoverMissed: Native stock apply failed for " + key
                        + " — " + stockResult.error);
                return new FireResult(FireResult.Status.FAILED, false);
            }

            if (!scheduler.markSuccessorObligationStockApplied(
                    medicationId, doseId, calendarDate)) {
                Log.e("AutoDeductionScheduler",
                        "recoverMissed: successor obligation stock state commit failed for " + key);
                return new FireResult(FireResult.Status.FAILED, false);
            }

            scheduler.clearIndependentFireRetryEvidenceLocked(key);
            return result;
        }
    }


    FireResult recoverMissedOccurrenceForCompensation(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            long generation,
            String treatmentEndDate,
            String fallbackTimeHhmm) {
        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (AutoDeductionScheduler.class) {
            if (!scheduler.isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, generation)) {
                return FireResult.cancelled();
            }
            if (!AutoDeductionContract.isValidTimeHhmm(fallbackTimeHhmm)) {
                return new FireResult(FireResult.Status.FAILED, false);
            }
            if (!scheduler.schedulingAdapter().clearCancellationTombstone(key)) {
                return new FireResult(FireResult.Status.FAILED, false);
            }
            return recoverMissedOccurrence(
                    medicationId,
                    doseId,
                    calendarDate,
                    scheduledAt,
                    amount,
                    generation,
                    treatmentEndDate,
                    fallbackTimeHhmm);
        }
    }

}
