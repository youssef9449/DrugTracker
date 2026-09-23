package app.drugtracker.autodeduction;

/**
 * Typed persistence records used by the native Auto-Deduction persistence
 * boundary. Business services consume these records instead of depending on
 * raw JSON field names.
 */
public final class AutoDeductionPersistenceModels {
    private AutoDeductionPersistenceModels() {}

    public static final class OccurrenceId {
        public final String medicationId;
        public final String doseId;
        public final String calendarDate;

        public OccurrenceId(
                String medicationId,
                String doseId,
                String calendarDate) {
            this.medicationId = medicationId;
            this.doseId = doseId;
            this.calendarDate = calendarDate;
        }

        public String canonicalKey() {
            return AutoDeductionContract.occurrenceKey(
                    medicationId, doseId, calendarDate);
        }
    }

    public static final class EventRecord {
        public final OccurrenceId occurrence;
        public final long scheduledAtEpochMs;
        public final double amount;
        public final String status;
        public final long createdAtEpochMs;
        public final Long reconciledAtEpochMs;
        public final Long rejectedAtEpochMs;
        public final String rejectionReason;

        public EventRecord(
                OccurrenceId occurrence,
                long scheduledAtEpochMs,
                double amount,
                String status,
                long createdAtEpochMs,
                Long reconciledAtEpochMs,
                Long rejectedAtEpochMs,
                String rejectionReason) {
            this.occurrence = occurrence;
            this.scheduledAtEpochMs = scheduledAtEpochMs;
            this.amount = amount;
            this.status = status;
            this.createdAtEpochMs = createdAtEpochMs;
            this.reconciledAtEpochMs = reconciledAtEpochMs;
            this.rejectedAtEpochMs = rejectedAtEpochMs;
            this.rejectionReason = rejectionReason;
        }

        public static EventRecord fired(
                OccurrenceId occurrence,
                long scheduledAtEpochMs,
                double amount,
                long createdAtEpochMs) {
            return new EventRecord(
                    occurrence,
                    scheduledAtEpochMs,
                    amount,
                    AutoDeductionContract.STATUS_FIRED,
                    createdAtEpochMs,
                    null,
                    null,
                    null);
        }

        public EventRecord withStatus(
                String nextStatus,
                Long nextReconciledAtEpochMs,
                Long nextRejectedAtEpochMs,
                String nextRejectionReason) {
            return new EventRecord(
                    occurrence,
                    scheduledAtEpochMs,
                    amount,
                    nextStatus,
                    createdAtEpochMs,
                    nextReconciledAtEpochMs,
                    nextRejectedAtEpochMs,
                    nextRejectionReason);
        }
    }

    public static final class ScheduleRecord {
        public final OccurrenceId occurrence;
        public final String timeHhmm;
        public final double amount;
        public final long scheduledAtEpochMs;
        public final String treatmentEndDate;
        public final String operationVersion;

        public ScheduleRecord(
                OccurrenceId occurrence,
                String timeHhmm,
                double amount,
                long scheduledAtEpochMs,
                String treatmentEndDate,
                String operationVersion) {
            this.occurrence = occurrence;
            this.timeHhmm = timeHhmm;
            this.amount = amount;
            this.scheduledAtEpochMs = scheduledAtEpochMs;
            this.treatmentEndDate = treatmentEndDate == null ? "" : treatmentEndDate;
            this.operationVersion = operationVersion == null ? "" : operationVersion;
        }
    }

    public static final class ScheduledOccurrenceRecord {
        public final ScheduleRecord schedule;
        public final int fireRetryCount;

        public ScheduledOccurrenceRecord(
                ScheduleRecord schedule,
                int fireRetryCount) {
            this.schedule = schedule;
            this.fireRetryCount = Math.max(0, fireRetryCount);
        }
    }

    public static final class RetryEvidenceRecord {
        public final OccurrenceId occurrence;
        public final long scheduledAtEpochMs;
        public final double amount;
        public final String timeHhmm;
        public final String treatmentEndDate;
        public final long recurrenceGeneration;
        public final String operationVersion;
        public final int retryCount;
        public final long updatedAtEpochMs;

        public RetryEvidenceRecord(
                OccurrenceId occurrence,
                long scheduledAtEpochMs,
                double amount,
                String timeHhmm,
                String treatmentEndDate,
                long recurrenceGeneration,
                String operationVersion,
                int retryCount,
                long updatedAtEpochMs) {
            this.occurrence = occurrence;
            this.scheduledAtEpochMs = scheduledAtEpochMs;
            this.amount = amount;
            this.timeHhmm = timeHhmm == null ? "" : timeHhmm;
            this.treatmentEndDate = treatmentEndDate == null ? "" : treatmentEndDate;
            this.recurrenceGeneration = recurrenceGeneration;
            this.operationVersion = operationVersion == null ? "" : operationVersion;
            this.retryCount = retryCount;
            this.updatedAtEpochMs = updatedAtEpochMs;
        }
    }

    public static final class SuccessorObligationRecord {
        public final OccurrenceId sourceOccurrence;
        public final String timeHhmm;
        public final double amount;
        public final String treatmentEndDate;
        public final String operationVersion;
        public final long recurrenceGeneration;
        /** True only after the occurrence-specific Native stock mutation is durable. */
        public final boolean stockApplied;
        public final long createdAtEpochMs;

        public SuccessorObligationRecord(
                OccurrenceId sourceOccurrence,
                String timeHhmm,
                double amount,
                String treatmentEndDate,
                String operationVersion,
                long recurrenceGeneration,
                boolean stockApplied,
                long createdAtEpochMs) {
            this.sourceOccurrence = sourceOccurrence;
            this.timeHhmm = timeHhmm;
            this.amount = amount;
            this.treatmentEndDate = treatmentEndDate;
            this.operationVersion = operationVersion;
            this.recurrenceGeneration = recurrenceGeneration;
            this.stockApplied = stockApplied;
            this.createdAtEpochMs = createdAtEpochMs;
        }
    }

    public static final class PendingFireRecord {
        public final EventRecord event;

        public PendingFireRecord(EventRecord event) {
            this.event = event;
        }
    }
}
