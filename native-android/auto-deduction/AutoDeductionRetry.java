package app.drugtracker.autodeduction;

import android.content.Context;
import android.util.Log;
import app.drugtracker.autodeduction.AutoDeductionScheduler.FireResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.ScheduleResult;

/** Focused Auto-Deduction responsibility collaborator: AutoDeductionRetry. */
final class AutoDeductionRetry {
    interface Host {
        Context appContext();
        boolean isOccurrenceCancelledKey(String occurrenceKey);
        AutoDeductionSchedulingAdapter schedulingAdapter();
        long getRecurrenceGenerationLocked(String medicationId, String doseId);
        AutoDeductionFailurePolicy failurePolicy();
        AutoDeductionEventStore eventStore();
        boolean persistSuccessorObligation(
                String medicationId, String doseId, String calendarDate,
                String timeHhmm, double amount, String treatmentEndDate,
                String operationVersion, long recurrenceGeneration);
        boolean markSuccessorObligationStockApplied(
                String medicationId, String doseId, String calendarDate);
        ScheduleResult scheduleNextOccurrenceFromIndependentEvidenceLocked(
                String medicationId, String doseId, String calendarDate,
                AutoDeductionPersistenceModels.RetryEvidenceRecord evidence);
        boolean clearSuccessorObligation(
                String medicationId, String doseId, String calendarDate);
    }

    private final Host host;
    private final AutoDeductionRetryEvidenceStore evidenceStore;

    AutoDeductionRetry(Host host) {
        this.host = host;
        this.evidenceStore = new AutoDeductionRetryEvidenceStore(
                host.appContext());
    }

boolean scheduleFireRetry(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String timeHhmm,
            String requestedTreatmentEndDate,
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
        synchronized (AutoDeductionScheduler.class) {
            if (host.isOccurrenceCancelledKey(key)) {
                return false;
            }
            AutoDeductionPersistenceModels.ScheduleRecord current =
                    host.schedulingAdapter().getScheduleRecord(prefKey);
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
                    : (requestedTreatmentEndDate == null ? "" : requestedTreatmentEndDate);
            if (current == null && (treatmentEndDate == null || treatmentEndDate.isEmpty())
                    && existingEvidence != null) {
                treatmentEndDate = existingEvidence.treatmentEndDate;
            }
            if (current != null) {
                long activeGen =
                        host.getRecurrenceGenerationLocked(medicationId, doseId);
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
                long activeGen = host.getRecurrenceGenerationLocked(
                        medicationId, doseId);
                if (existingEvidence == null
                        || existingEvidence.recurrenceGeneration != activeGen
                        || recurrenceGeneration != activeGen
                        || operationVersion == null
                        || !operationVersion.equals(existingEvidence.operationVersion)
                        || timeHhmm == null
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
            return host.schedulingAdapter().scheduleFireRetry(
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
                            treatmentEndDate,
                            recurrenceGeneration,
                            operationVersion,
                            count,
                            System.currentTimeMillis());
            boolean ok = evidenceStore.save(record, host.failurePolicy());
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
        synchronized (AutoDeductionScheduler.class) {
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
        synchronized (AutoDeductionScheduler.class) {
            AutoDeductionPersistenceModels.RetryEvidenceRecord evidence =
                    evidenceStore.get(medicationId, doseId, calendarDate);
            if (evidence == null) {
                if (host.isOccurrenceCancelledKey(key)) {
                    return FireResult.cancelled();
                }
                return new FireResult(FireResult.Status.FAILED, false);
            }

            // Independent retry evidence is durable proof that the fire delivery
            // reached the Auto fire boundary. A later cancellation or replacement
            // may invalidate recurrence continuation, but it must not erase the
            // already-authorized occurrence or prevent its Native stock recovery.
            final boolean occurrenceCancelled =
                    host.isOccurrenceCancelledKey(key);
            AutoDeductionPersistenceModels.ScheduleRecord current =
                    host.schedulingAdapter().getScheduleRecord(key);
            long activeGeneration = host.getRecurrenceGenerationLocked(
                    medicationId, doseId);
            final boolean ownsCurrentSchedule =
                    !occurrenceCancelled
                            && current != null
                            && evidence.recurrenceGeneration == activeGeneration
                            && evidence.operationVersion != null
                            && evidence.operationVersion.equals(current.operationVersion)
                            && evidence.timeHhmm.equals(current.timeHhmm)
                            && Double.compare(evidence.amount, current.amount) == 0
                            && evidence.treatmentEndDate.equals(current.treatmentEndDate);

            // A current schedule that replaced the evidence, or a recurrence
            // generation that was disabled/revoked, invalidates the retry before
            // any FIRED row or stock mutation can be created. A missing schedule
            // with the same active generation is different: it can represent the
            // one-shot alarm having already been consumed, so its durable evidence
            // remains recoverable.
            if (current != null && !ownsCurrentSchedule) {
                clearIndependentFireRetryEvidenceLocked(key);
                return FireResult.cancelled();
            }
            if (current == null
                    && activeGeneration > 0L
                    && evidence.recurrenceGeneration != activeGeneration) {
                clearIndependentFireRetryEvidenceLocked(key);
                return FireResult.cancelled();
            }

            AutoDeductionEventStore.InsertFiredResult ir =
                    host.eventStore().insertFiredIfAbsent(
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

            // Only the current schedule owner may continue the recurrence chain.
            // Historical evidence from a removed/replaced/cancelled source still
            // receives its one-time Native stock recovery, but it cannot create D+1.
            String obligationTime = current == null ? "" : current.timeHhmm;
            String obligationEndDate = current == null
                    ? evidence.treatmentEndDate
                    : current.treatmentEndDate;
            String obligationVersion = current == null
                    ? evidence.operationVersion
                    : current.operationVersion;

            if (ownsCurrentSchedule
                    && !host.persistSuccessorObligation(
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
                    new AutoDeductionStockStore(host.appContext()).applyAutoDeductionForRecovery(
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

            if (ownsCurrentSchedule
                    && !host.markSuccessorObligationStockApplied(
                            medicationId, doseId, calendarDate)) {
                return new FireResult(FireResult.Status.FAILED, false);
            }

            if (!ownsCurrentSchedule) {
                // The occurrence was historically authorized, but recurrence
                // ownership is gone. Stock recovery is complete; stop here without
                // resurrecting a successor from obsolete configuration.
                clearIndependentFireRetryEvidenceLocked(key);
                return result;
            }

            ScheduleResult successor =
                    host.scheduleNextOccurrenceFromIndependentEvidenceLocked(
                            medicationId, doseId, calendarDate, evidence);
            if (successor.ok) {
                host.clearSuccessorObligation(
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
                host.clearSuccessorObligation(
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
