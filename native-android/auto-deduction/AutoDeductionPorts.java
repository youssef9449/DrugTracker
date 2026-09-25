package app.drugtracker.autodeduction;

import android.content.Context;

import java.util.Map;

/**
 * Narrow capability ports for the Auto-Deduction service decomposition
 * (#466).
 *
 * Each extracted service previously declared its own broad Host callback
 * interface and routed everything back through the parent scheduler. The
 * ports below name the recurring CAPABILITIES once; service Host interfaces
 * extend only the ports they actually consume, so a service depends on the
 * capabilities it needs — not on the full scheduler surface. The scheduler
 * keeps implementing every capability; no lock/order invariant changes.
 *
 * Feature-neutral by construction: no port knows about medication policy —
 * they are pure scheduler capabilities keyed by opaque ids/keys.
 */
final class AutoDeductionPorts {

    private AutoDeductionPorts() {}

    /** Application context capability. */
    interface AppContextPort {
        Context appContext();
    }

    /** Schedule storage access (records, raw rows, metadata listing). */
    interface ScheduleStoragePort {
        AutoDeductionSchedulingAdapter schedulingAdapter();
        Map<String, String> getAllScheduleMetadata();
        boolean removeScheduleMetadataIfVersion(String prefKey, String expectedVersion);
    }

    /** Recurrence-generation authorization capability. */
    interface GenerationPort {
        long getRecurrenceGenerationLocked(String medicationId, String doseId);
        boolean isRecurrenceGenerationAuthorizedLocked(
                String medicationId, String doseId, long expectedGeneration);
    }

    /** Recovery evidence access (events, retry evidence, recovery clock). */
    interface RecoveryEvidencePort {
        AutoDeductionEventStore eventStore();
        long recoveryNowForService();
    }

    /** Occurrence cancellation/tombstone capability. */
    interface CancellationPort {
        boolean isOccurrenceCancelledKey(String occurrenceKey);
        boolean hasCancellationTombstone(String occurrenceKey);
        boolean clearCancellationTombstoneLocked(String occurrenceKey);
    }

    /** Failure-injection policy port (test/reliability seams). */
    interface FailurePolicyPort {
        AutoDeductionFailurePolicy failurePolicy();
    }

    /** Durable successor-obligation access. */
    interface SuccessorObligationPort {
        AutoSuccessorObligationStore successorObligationStore();
        boolean persistSuccessorObligation(
                String medicationId, String doseId, String calendarDate,
                String timeHhmm, double amount, String treatmentEndDate,
                String operationVersion, long recurrenceGeneration);
        boolean markSuccessorObligationStockApplied(
                String medicationId, String doseId, String calendarDate);
    }
}
