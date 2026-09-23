package app.drugtracker.autodeduction;

import android.util.Log;
import app.drugtracker.autodeduction.AutoDeductionScheduler.FireResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.ScheduleResult;

/** Focused Auto-Deduction responsibility collaborator: AutoDeductionRetry. */
final class AutoDeductionRetry {
    private final AutoDeductionScheduler scheduler;
    private final AutoDeductionRetryEvidenceStore evidenceStore;

    AutoDeductionRetry(AutoDeductionScheduler scheduler) {
        this.scheduler = scheduler;
        this.evidenceStore = new AutoDeductionRetryEvidenceStore(
                scheduler.appContext());
    }

boolean scheduleFireRetry(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String timeHhmm,
            String treatmentEndDate,
            long recurrenceGeneration,
            String operationVersion,
            int nextRetryCount
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)
                || nextRetryCount <= 0
                || nextRetryCount > AutoDeductionContract.MAX_FIRE_RETRIES) {
            return false;
        }
        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        final String prefKey = key;
        synchronized (scheduler.scheduleLock()) {
            if (scheduler.isOccurrenceCancelledKey(key)) {
                return false;
            }
            AutoDeductionPersistenceModels.ScheduleRecord current =
                    scheduler.schedulingAdapter().getScheduleRecord(prefKey);
            AutoDeductionPersistenceModels.RetryEvidenceRecord existingEvidence =
                    evidenceStore.get(medicationId, doseId, calendarDate);
            int priorRetryCount = existingEvidence == null
                    ? 0
                    : existingEvidence.retryCount;
            int persistedRetryCount = Math.max(
                    priorRetryCount,
                    nextRetryCount);
            String treatmentEndDate = current != null
                    ? current.treatmentEndDate
                    : (existingEvidence == null ? "" : existingEvidence.treatmentEndDate);
            if (current != null) {
                long activeGen =
                        scheduler.getRecurrenceGenerationLocked(medicationId, doseId);
                if (operationVersion == null || operationVersion.isEmpty()
                        || recurrenceGeneration <= 0L
                        || !operationVersion.equals(current.operationVersion)
                        || recurrenceGeneration != activeGen) {
                    return false;
                }
            } else {
                // A missing schedule is allowed only for an already-durable historical
                // retry source. The evidence itself must still belong to the active
                // recurrence generation and the requested retry payload must match it.
                long activeGen = scheduler.getRecurrenceGenerationLocked(
                        medicationId, doseId);
                if (existingEvidence == null
                        || existingEvidence.recurrenceGeneration != activeGen
                        || recurrenceGeneration != activeGen
                        || operationVersion == null
                        || !operationVersion.equals(existingEvidence.operationVersion)
                        || !timeHhmm.equals(existingEvidence.timeHhmm)
                        || Double.compare(amount, existingEvidence.amount) != 0) {
                    return false;
                }
            }
            if (!recordIndependentFireRetryEvidenceLocked(
                    medicationId, doseId, calendarDate,
                    scheduledAtEpochMs, amount, timeHhmm, treatmentEndDate,
                    recurrenceGeneration, operationVersion,
                    persistedRetryCount)) {
                return false;
            }
            return scheduler.schedulingAdapter().scheduleFireRetry(
                    medicationId,
                    doseId,
                    calendarDate,
                    scheduledAtEpochMs,
                    amount,
                    timeHhmm,
                    recurrenceGeneration,
                    operationVersion,
                    persistedRetryCount);
        }
    }

boolean recordIndependentFireRetryEvidenceLocked(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String timeHhmm,
            String treatmentEndDate,
            long recurrenceGeneration,
            String operationVersion,
            int nextRetryCount
    ) {
        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        int prior = 0;
        AutoDeductionPersistenceModels.RetryEvidenceRecord existing =
                evidenceStore.get(medicationId, doseId, calendarDate);
        if (existing != null) prior = existing.retryCount;
        int count = Math.min(
                AutoDeductionContract.MAX_FIRE_RETRIES,
                Math.max(prior, Math.max(1, nextRetryCount)));
        try {
            AutoDeductionPersistenceModels.RetryEvidenceRecord record =
                    new AutoDeductionPersistenceModels.RetryEvidenceRecord(
                            new AutoDeductionPersistenceModels.OccurrenceId(
                                    medicationId, doseId, calendarDate),
                            scheduledAtEpochMs,
                            amount,
                            timeHhmm,
                            recurrenceGeneration,
                            operationVersion,
                            count,
                            System.currentTimeMillis());
            boolean ok = evidenceStore.save(record, scheduler.failurePolicy());
            if (!ok) {
                Log.e("AutoDeductionScheduler",
                        "independent fire-retry evidence commit failed for " + key);
            }
            return ok;
        } catch (RuntimeException e) {
            Log.e("AutoDeductionScheduler",
                    "independent fire-retry evidence build failed for " + key, e);
            return false;
        }
    }

boolean clearIndependentFireRetryEvidenceLocked(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        boolean ok = evidenceStore.clear(occurrenceKey);
        if (!ok) {
            Log.w("AutoDeductionScheduler",
                    "independent fire-retry evidence clear failed for " + occurrenceKey);
        }
        return ok;
    }

void clearIndependentFireRetryEvidenceAfterStock(
            String medicationId,
            String doseId,
            String calendarDate
    ) {
        if (medicationId == null || doseId == null || calendarDate == null) return;
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (scheduler.scheduleLock()) {
            clearIndependentFireRetryEvidenceLocked(key);
        }
    }

public FireResult recoverFireFromIndependentEvidence(
            String medicationId,
            String doseId,
            String calendarDate
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return new FireResult(FireResult.Status.FAILED, false);
        }

        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (scheduler.scheduleLock()) {
            AutoDeductionPersistenceModels.RetryEvidenceRecord evidence =
                    evidenceStore.get(medicationId, doseId, calendarDate);
            if (evidence == null) {
                if (scheduler.isOccurrenceCancelledKey(key)) {
                    return FireResult.cancelled();
                }
                return new FireResult(FireResult.Status.FAILED, false);
            }

            // Independent retry evidence may survive longer than the one-shot
            // delivery. It is not an authorization token by itself: before any
            // FIRED record or Native stock mutation is allowed, prove that the
            // evidence still belongs to the currently authorized schedule.
            // A missing/replaced schedule means the old retry must never resurrect
            // an occurrence after disable/edit/replacement.
            if (scheduler.isOccurrenceCancelledKey(key)) {
                clearIndependentFireRetryEvidenceLocked(key);
                return FireResult.cancelled();
            }
            AutoDeductionPersistenceModels.ScheduleRecord current =
                    scheduler.schedulingAdapter().getScheduleRecord(key);
            long activeGeneration = scheduler.getRecurrenceGenerationLocked(
                    medicationId, doseId);
            if (current == null
                    || evidence.recurrenceGeneration != activeGeneration
                    || !evidence.operationVersion.equals(current.operationVersion)
                    || !evidence.timeHhmm.equals(current.timeHhmm)
                    || Double.compare(evidence.amount, current.amount) != 0
                    || !evidence.treatmentEndDate.equals(current.treatmentEndDate)) {
                // This evidence no longer owns the current schedule. Retire the
                // obsolete retry source before returning so later recovery passes
                // cannot keep rediscovering the same stale obligation.
                clearIndependentFireRetryEvidenceLocked(key);
                return FireResult.cancelled();
            }

            AutoDeductionEventStore.InsertFiredResult ir =
                    scheduler.eventStore().insertFiredIfAbsent(
                            medicationId,
                            doseId,
                            calendarDate,
                            evidence.scheduledAtEpochMs,
                            evidence.amount);
            FireResult result = FireResult.fromInsert(ir);
            if (!result.allowsRecurrence()) {
                if (result.status == FireResult.Status.FAILED
                        && !result.pendingRecorded) {
                    recordIndependentFireRetryEvidenceLocked(
                            medicationId,
                            doseId,
                            calendarDate,
                            evidence.scheduledAtEpochMs,
                            evidence.amount,
                            evidence.timeHhmm,
                            evidence.treatmentEndDate,
                            evidence.recurrenceGeneration,
                            evidence.operationVersion,
                            Math.min(
                                    evidence.retryCount + 1,
                                    AutoDeductionContract.MAX_FIRE_RETRIES));
                }
                return result;
            }

            // The ownership check above proved this is the current schedule.
            // Reuse its definition rather than letting stale evidence override the
            // live configuration while rebuilding the successor obligation.
            String obligationTime = current.timeHhmm;
            String obligationEndDate = current.treatmentEndDate;
            String obligationVersion = current.operationVersion;

            if (!scheduler.persistSuccessorObligation(
                    medicationId,
                    doseId,
                    calendarDate,
                    obligationTime,
                    evidence.amount,
                    obligationEndDate,
                    obligationVersion,
                    evidence.recurrenceGeneration)) {
                return new FireResult(FireResult.Status.FAILED, false);
            }

            AutoDeductionStockStore.AutoApplyResult stockResult =
                    new AutoDeductionStockStore(scheduler.appContext()).applyAutoDeductionForRecovery(
                            medicationId,
                            doseId,
                            calendarDate,
                            evidence.amount);
            if (!stockResult.ok) {
                recordIndependentFireRetryEvidenceLocked(
                        medicationId,
                        doseId,
                        calendarDate,
                        evidence.scheduledAtEpochMs,
                        evidence.amount,
                        obligationTime,
                        obligationEndDate,
                        evidence.recurrenceGeneration,
                        obligationVersion,
                        evidence.retryCount);
                return new FireResult(FireResult.Status.FAILED, false);
            }

            if (!scheduler.markSuccessorObligationStockApplied(
                    medicationId, doseId, calendarDate)) {
                return new FireResult(FireResult.Status.FAILED, false);
            }

            ScheduleResult successor =
                    scheduler.scheduleNextOccurrenceFromIndependentEvidenceLocked(
                            medicationId, doseId, calendarDate, evidence);
            if (successor.ok) {
                scheduler.clearSuccessorObligation(
                        medicationId, doseId, calendarDate);
                clearIndependentFireRetryEvidenceLocked(key);
                return result;
            }

            // The original D fire and Native stock mutation are already durable.
            // A failed successor install is therefore not a successful recovery:
            // keep the obligation/evidence so the next native recovery boundary
            // can retry it. Stale ownership means the old obligation is obsolete
            // and may be retired without resurrecting the newer schedule.
            if ("recurrence_authorization_invalid".equals(successor.error)
                    || "snapshot_stale".equals(successor.error)
                    || "cancelled_skip".equals(successor.error)
                    || "treatment_ended".equals(successor.error)) {
                // D itself is already durably completed. Missing/replaced source
                // metadata only means there is no safe successor to create from
                // this evidence; do not relabel the successfully recovered D as
                // CANCELLED.
                scheduler.clearSuccessorObligation(
                        medicationId, doseId, calendarDate);
                clearIndependentFireRetryEvidenceLocked(key);
                return result;
            }
            return new FireResult(FireResult.Status.FAILED, false);
        }
    }

    AutoDeductionPersistenceModels.RetryEvidenceRecord getIndependentFireRetryEvidence(
            String medicationId,
            String doseId,
            String calendarDate) {
        return evidenceStore.get(medicationId, doseId, calendarDate);
    }
}
