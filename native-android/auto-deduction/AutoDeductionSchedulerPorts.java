package app.drugtracker.autodeduction;

import android.content.Context;
import java.util.Map;
import app.drugtracker.autodeduction.AutoDeductionScheduler.CancelResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.FireResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.ScheduleResult;

/**
 * Port adapters binding the Auto-Deduction collaborators (recurrence, fire,
 * recovery, retry, cancellation, occurrence state) to the central
 * coordinator (#489).
 *
 * Responsibility-oriented extraction from {@link AutoDeductionScheduler}:
 * the coordinator keeps orchestration, ownership, and the public API, while
 * THIS class owns the single-focused job of adapting the coordinator to the
 * narrowed collaborator ports. Each factory captures the coordinator
 * instance and delegates lazily — identical semantics to the previous
 * inner anonymous classes, with the coordinator class now readable without
 * ~330 lines of port glue.
 */
final class AutoDeductionSchedulerPorts {
    private AutoDeductionSchedulerPorts() {}

    static AutoDeductionRecurrence.Host recurrenceHost(final AutoDeductionScheduler scheduler) {
        return new AutoDeductionRecurrence.Host() {
            @Override public Context appContext() { return scheduler.appContext(); }
            @Override public AutoSuccessorObligationStore successorObligationStore() {
                return scheduler.successorObligationStore();
            }
            @Override public AutoDeductionScheduler.CancelResult cancelAllSchedulesForDoseLocked(String medicationId, String doseId) {
                return scheduler.cancelAllSchedulesForDoseLocked(medicationId, doseId);
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return scheduler.failurePolicy();
            }
            @Override public boolean removeScheduleMetadataIfVersionLocked(String prefKey, String expectedVersion) {
                return scheduler.removeScheduleMetadataIfVersionLocked(prefKey, expectedVersion);
            }
            @Override public boolean removeScheduleMetadataIfVersion(
                    String prefKey, String expectedVersion) {
                return scheduler.removeScheduleMetadataIfVersion(
                        prefKey, expectedVersion);
            }
            @Override public Map<String, String> getAllScheduleMetadata() {
                return scheduler.getAllScheduleMetadata();
            }
            @Override public boolean hasCancellationTombstone(String occurrenceKey) {
                return scheduler.hasCancellationTombstone(occurrenceKey);
            }
            @Override public boolean clearCancellationTombstoneLocked(String occurrenceKey) {
                return scheduler.clearCancellationTombstoneLocked(occurrenceKey);
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return scheduler.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return scheduler.schedulingAdapter();
            }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return scheduler.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionEventStore eventStore() {
                return scheduler.eventStore();
            }
            @Override public long recoveryNowForService() {
                return scheduler.recoveryNowForService();
            }
            @Override public AutoDeductionScheduler.FireResult recoverMissedOccurrence(
                    String medicationId, String doseId, String calendarDate,
                    long scheduledAt, double amount, long generation,
                    String treatmentEndDate, String fallbackTimeHhmm) {
                return scheduler.recoverMissedOccurrence(
                        medicationId, doseId, calendarDate, scheduledAt, amount, generation,
                        treatmentEndDate, fallbackTimeHhmm);
            }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return scheduler.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
        };
    }

    static AutoDeductionRecovery.Host recoveryHost(final AutoDeductionScheduler scheduler) {
        return new AutoDeductionRecovery.Host() {
            @Override public boolean isRecurrenceGenerationAuthorizedLocked(
                    String medicationId, String doseId, long expected) {
                return scheduler.isRecurrenceGenerationAuthorizedLocked(
                        medicationId, doseId, expected);
            }
            @Override public boolean removeScheduleMetadataIfVersionLocked(
                    String prefKey, String expectedVersion) {
                return scheduler.removeScheduleMetadataIfVersionLocked(
                        prefKey, expectedVersion);
            }
            @Override public long recoveryNowForService() {
                return scheduler.recoveryNowForService();
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return scheduler.schedulingAdapter();
            }
            @Override public AutoDeductionScheduler.ScheduleResult installFutureSuccessorIfGenerationHolds(
                    String medicationId, String doseId, String futureDate, String timeHhmm,
                    double amount, long triggerAt, long expectedGen,
                    String pastPrefKey, String observedVersion, String treatmentEndDateOverride) {
                return scheduler.installFutureSuccessorIfGenerationHolds(
                        medicationId, doseId, futureDate, timeHhmm, amount, triggerAt,
                        expectedGen, pastPrefKey, observedVersion, treatmentEndDateOverride);
            }
            @Override public AutoDeductionScheduler.FireResult recoverMissedOccurrence(
                    String medicationId, String doseId, String calendarDate,
                    long scheduledAt, double amount, long generation,
                    String treatmentEndDate, String fallbackTimeHhmm) {
                return scheduler.recoverMissedOccurrence(
                        medicationId, doseId, calendarDate, scheduledAt, amount, generation,
                        treatmentEndDate, fallbackTimeHhmm);
            }
            @Override public boolean removeScheduleMetadataIfVersion(
                    String prefKey, String expectedVersion) {
                return scheduler.removeScheduleMetadataIfVersion(
                        prefKey, expectedVersion);
            }
            @Override public AutoDeductionScheduler.ScheduleResult scheduleNextOccurrenceIfSnapshotOwnsPast(
                    String medicationId, String doseId, String fromDate, String timeHhmm,
                    double amount, String pastPrefKey, String observedVersion) {
                return scheduler.scheduleNextOccurrenceIfSnapshotOwnsPast(
                        medicationId, doseId, fromDate, timeHhmm, amount,
                        pastPrefKey, observedVersion);
            }
            @Override public Context appContext() { return scheduler.appContext(); }
            @Override public AutoDeductionEventStore eventStore() {
                return scheduler.eventStore();
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return scheduler.getRecurrenceGenerationLocked(medicationId, doseId);
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return scheduler.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public AutoSuccessorObligationStore successorObligationStore() {
                return scheduler.successorObligationStore();
            }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return scheduler.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
            @Override public AutoDeductionRetryEvidenceStore retryEvidenceStore() {
                return scheduler.retryEvidenceStore();
            }
            @Override public AutoDeductionScheduler.FireResult recoverFireFromIndependentEvidence(
                    String medicationId, String doseId, String calendarDate) {
                return scheduler.recoverFireFromIndependentEvidence(
                        medicationId, doseId, calendarDate);
            }
            @Override public boolean scheduleFireRetry(
                    String medicationId, String doseId, String calendarDate, long scheduledAt,
                    double amount, String timeHhmm, long generation, String operationVersion,
                    int nextRetryCount) {
                return scheduler.scheduleFireRetry(
                        medicationId, doseId, calendarDate, scheduledAt, amount, timeHhmm,
                        generation, operationVersion, nextRetryCount);
            }
            @Override public boolean recoverSuccessorObligations() {
                return scheduler.recoverSuccessorObligations();
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return scheduler.failurePolicy();
            }
            @Override public Map<String, String> getAllScheduleMetadata() {
                return scheduler.getAllScheduleMetadata();
            }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return scheduler.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public boolean hasCancellationTombstone(String occurrenceKey) {
                return scheduler.hasCancellationTombstone(occurrenceKey);
            }
            @Override public boolean clearCancellationTombstoneLocked(String occurrenceKey) {
                return scheduler.clearCancellationTombstoneLocked(occurrenceKey);
            }
            @Override public AutoDeductionScheduler.ScheduleResult scheduleOccurrenceLocked(
                    String prefKey, AutoDeductionPersistenceModels.ScheduleRecord record,
                    String requiredVersion) {
                return scheduler.scheduleOccurrenceLocked(
                        prefKey, record, requiredVersion);
            }
            @Override public boolean compactTerminalState() {
                return scheduler.compactTerminalState();
            }
        };
    }

    static AutoDeductionFireService.Host fireHost(final AutoDeductionScheduler scheduler) {
        return new AutoDeductionFireService.Host() {
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return scheduler.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return scheduler.schedulingAdapter();
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return scheduler.getRecurrenceGenerationLocked(medicationId, doseId);
            }
            @Override public AutoDeductionEventStore eventStore() {
                return scheduler.eventStore();
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return scheduler.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public boolean recordIndependentFireRetryEvidenceLocked(
                    String medicationId, String doseId, String calendarDate, long scheduledAt,
                    double amount, String timeHhmm, String treatmentEndDate, long generation,
                    String operationVersion, int nextRetryCount) {
                return scheduler.recordIndependentFireRetryEvidenceLocked(
                        medicationId, doseId, calendarDate, scheduledAt, amount, timeHhmm,
                        treatmentEndDate, generation, operationVersion, nextRetryCount);
            }
            @Override public Context appContext() { return scheduler.appContext(); }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return scheduler.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
            @Override public void clearIndependentFireRetryEvidenceLocked(String occurrenceKey) {
                scheduler.clearIndependentFireRetryEvidenceLocked(occurrenceKey);
            }
            @Override public boolean isRecurrenceGenerationAuthorizedLocked(
                    String medicationId, String doseId, long expectedGeneration) {
                return scheduler.isRecurrenceGenerationAuthorizedLocked(
                        medicationId, doseId, expectedGeneration);
            }
        };
    }

    static AutoDeductionCancellation.Host cancellationHost(final AutoDeductionScheduler scheduler) {
        return new AutoDeductionCancellation.Host() {
            @Override public Map<String, String> getAllScheduleMetadata() {
                return scheduler.getAllScheduleMetadata();
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return scheduler.schedulingAdapter();
            }
            @Override public boolean quarantineMalformedScheduleMetadata(
                    String prefKey, String expectedRaw, String reason) {
                return scheduler.quarantineMalformedScheduleMetadata(
                        prefKey, expectedRaw, reason);
            }
            @Override public boolean hasCancellationTombstoneStored(String occurrenceKey) {
                return scheduler.hasCancellationTombstoneStored(occurrenceKey);
            }
            @Override public boolean isEffectivelyCancelledStored(String occurrenceKey) {
                return scheduler.isEffectivelyCancelledStored(occurrenceKey);
            }
            @Override public boolean clearCancellationTombstoneStored(String occurrenceKey) {
                return scheduler.clearCancellationTombstoneStored(occurrenceKey);
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return scheduler.getRecurrenceGenerationLocked(medicationId, doseId);
            }
        };
    }

    static AutoDeductionOccurrenceState.Host occurrenceStateHost(final AutoDeductionScheduler scheduler) {
        return new AutoDeductionOccurrenceState.Host() {
            @Override public Context appContext() { return scheduler.appContext(); }
            @Override public Map<String, String> getAllScheduleMetadata() {
                return scheduler.getAllScheduleMetadata();
            }
            @Override public AutoDeductionEventStore eventStore() {
                return scheduler.eventStore();
            }
            @Override public AutoDeductionRetryEvidenceStore retryEvidenceStore() {
                return scheduler.retryEvidenceStore();
            }
            @Override public AutoSuccessorObligationStore successorObligationStore() {
                return scheduler.successorObligationStore();
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return scheduler.failurePolicy();
            }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return scheduler.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return scheduler.schedulingAdapter();
            }
        };
    }

    static AutoDeductionRetry.Host retryHost(final AutoDeductionScheduler scheduler) {
        return new AutoDeductionRetry.Host() {
            @Override public Context appContext() { return scheduler.appContext(); }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return scheduler.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return scheduler.schedulingAdapter();
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return scheduler.getRecurrenceGenerationLocked(medicationId, doseId);
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return scheduler.failurePolicy();
            }
            @Override public AutoDeductionEventStore eventStore() {
                return scheduler.eventStore();
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return scheduler.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return scheduler.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
            @Override public AutoDeductionScheduler.ScheduleResult scheduleNextOccurrenceFromIndependentEvidenceLocked(
                    String medicationId, String doseId, String calendarDate,
                    AutoDeductionPersistenceModels.RetryEvidenceRecord evidence) {
                return scheduler.scheduleNextOccurrenceFromIndependentEvidenceLocked(
                        medicationId, doseId, calendarDate, evidence);
            }
            @Override public void clearSuccessorObligation(
                    String medicationId, String doseId, String calendarDate) {
                scheduler.clearSuccessorObligation(
                        medicationId, doseId, calendarDate);
            }
        };
    }
}
