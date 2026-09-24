package app.drugtracker.autodeduction;
import android.content.Context;
import android.util.Log;
import java.util.Map;
/**
 * Auto Deduction facade/orchestrator. Feature business responsibilities are
 * implemented by focused collaborators; exact Alarm Android mechanics remain
 * behind AutoDeductionSchedulingAdapter → ExactAlarmRuntime.
 *
 * The facade owns only shared serialization, collaborator wiring, boundary
 * delegates, and small cross-feature result contracts. Recurrence, fire,
 * cancellation, retry, recovery, occurrence state, and persistence logic do not
 * live here.
 *
 * Fire/cancel linearization:
 *   SCHEDULE_LOCK remains the common serialization boundary between Auto's
 *   durable FIRED/event-store transitions and the scheduling adapter so exactly
 *   one fire/cancel operation linearizes first. The adapter then delegates the
 *   actual AlarmManager transaction to ExactAlarmRuntime.
 *
 * Native scheduling identity and PendingIntent mechanics are not implemented here;
 * AutoDeductionSchedulingAdapter translates the feature identity and payload into
 * the shared runtime request.
 *
 * Fire-vs-cancel linearization (same SCHEDULE_LOCK):
 *   fireOccurrenceIfNotCancelled performs the effective-cancellation check and
 *   the durable FIRED/pending transition under one continuous critical section
 *   shared with cancelOccurrence. Exactly one of fire or cancel linearizes first.
 *   If cancel linearizes first, a stale alarm delivery cannot create FIRED/pending
 *   or advance recurrence. If fire linearizes first, a later cancel cannot
 *   retroactively erase that fire.
 *   Lock order is always SCHEDULE_LOCK then (nested) EventStore.LOCK — never the
 *   reverse — so nesting cannot deadlock.
 *
 * operationVersion is the shared generic ownership guard for rollback (with
 * only the current operationVersion contract). It guards
 * concurrent metadata replacement and is NOT a medication-level disable epoch.
 *
 * Recurrence authorization:
 *   PREFS_RECURRENCE_AUTH holds a monotonic generation per (medicationId, doseId).
 *   scheduleOccurrence carries the active generation in delivery extras only; new
 *   Shared schedule metadata contains no Auto recurrence-authorization state.
 *   invalidateRecurrenceAuthorization cancels all future scheduled occurrences
 *   first under SCHEDULE_LOCK, then bumps the generation only after cancellation
 *   is durable. A cancellation failure therefore leaves both the prior generation
 *   and prior native schedules intact for safe retry; a generation-write failure
 *   after cancellation leaves schedules absent and is surfaced to the caller.
 *   Post-fire scheduleNextOccurrenceIfAbsent cannot create D+1 after a successful
 *   invalidation, and restore cannot resurrect a pre-disable successor.
 *
 * Does not use polling, WorkManager periodic, or foreground services.
 */
public final class AutoDeductionScheduler {
    private static final String TAG = "AutoDeductionScheduler";
    /** JSON/Intent field: medication+dose recurrence authorization generation. */
    public static final String FIELD_RECURRENCE_GENERATION = "recurrenceGeneration";
    /** Auto-owned process-wide serialization boundary. */
    private static final class ScheduleOperationLock {
        private ScheduleOperationLock() {}
    }
    private final Context appContext;
    /** Single Auto-specific scheduling boundary over the shared exact-alarm runtime. */
    private final AutoDeductionSchedulingAdapter schedulingAdapter;
    private final AutoDeductionRecurrence recurrenceService;
    private final AutoDeductionCancellation cancellationService;
    private final AutoDeductionFireService fireService;
    private final AutoDeductionRetry retryService;
    private final AutoDeductionRecovery recoveryService;
    private final AutoSuccessorObligationStore successorObligationStore;
    private final AutoDeductionOccurrenceState occurrenceState;
    private final AutoDeductionRetryEvidenceStore retryEvidenceStore;
    private final AutoDeductionFailurePolicy failurePolicy;

    private long recoveryNowMs() {
        Long override = failurePolicy.recoveryNowOverrideMs();
        return override != null ? override.longValue() : System.currentTimeMillis();
    }
    boolean persistSuccessorObligation(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            String treatmentEndDate,
            String operationVersion,
            long recurrenceGeneration) {
        return recurrenceService.persistSuccessorObligation(
                medicationId,
                doseId,
                calendarDate,
                timeHhmm,
                amount,
                treatmentEndDate,
                operationVersion,
                recurrenceGeneration);
    }

    Context appContext() { return appContext; }
    AutoDeductionSchedulingAdapter schedulingAdapter() { return schedulingAdapter; }
    AutoSuccessorObligationStore successorObligationStore() { return successorObligationStore; }
    AutoDeductionRetryEvidenceStore retryEvidenceStore() { return retryEvidenceStore; }
    AutoDeductionFailurePolicy failurePolicy() { return failurePolicy; }
    AutoDeductionEventStore eventStore() {
        return new AutoDeductionEventStore(appContext, failurePolicy);
    }
    boolean clearSuccessorObligation(String medicationId, String doseId, String calendarDate) {
        return successorObligationStore.clear(medicationId, doseId, calendarDate);
    }
    boolean markSuccessorObligationStockApplied(
            String medicationId, String doseId, String calendarDate) {
        return successorObligationStore.markStockApplied(
                medicationId, doseId, calendarDate);
    }
    long recoveryNowForService() { return recoveryNowMs(); }

    public AutoDeductionScheduler(Context context) {
        this(context, AutoDeductionFailurePolicy.ALLOW_ALL);
    }

    AutoDeductionScheduler(Context context, AutoDeductionFailurePolicy failurePolicy) {
        this.appContext = context.getApplicationContext();
        this.failurePolicy = failurePolicy == null
                ? AutoDeductionFailurePolicy.ALLOW_ALL
                : failurePolicy;
        this.schedulingAdapter = new AutoDeductionSchedulingAdapter(
                appContext, this.failurePolicy);
        this.recurrenceService = new AutoDeductionRecurrence(recurrenceHost());
        this.cancellationService = new AutoDeductionCancellation(cancellationHost());
        this.fireService = new AutoDeductionFireService(fireHost());
        this.retryService = new AutoDeductionRetry(retryHost());
        this.recoveryService = new AutoDeductionRecovery(recoveryHost());
        this.occurrenceState = new AutoDeductionOccurrenceState(occurrenceStateHost());
        this.successorObligationStore = new AutoSuccessorObligationStore(appContext);
        this.retryEvidenceStore = new AutoDeductionRetryEvidenceStore(appContext);
    }
    private AutoDeductionRecurrence.Host recurrenceHost() {
        return new AutoDeductionRecurrence.Host() {
            @Override public Context appContext() { return AutoDeductionScheduler.this.appContext; }
            @Override public AutoSuccessorObligationStore successorObligationStore() {
                return AutoDeductionScheduler.this.successorObligationStore;
            }
            @Override public CancelResult cancelAllSchedulesForDoseLocked(String medicationId, String doseId) {
                return AutoDeductionScheduler.this.cancelAllSchedulesForDoseLocked(medicationId, doseId);
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return AutoDeductionScheduler.this.failurePolicy;
            }
            @Override public boolean removeScheduleMetadataIfVersionLocked(String prefKey, String expectedVersion) {
                return AutoDeductionScheduler.this.removeScheduleMetadataIfVersionLocked(prefKey, expectedVersion);
            }
            @Override public boolean removeScheduleMetadataIfVersion(
                    String prefKey, String expectedVersion) {
                return AutoDeductionScheduler.this.removeScheduleMetadataIfVersion(
                        prefKey, expectedVersion);
            }
            @Override public Map<String, String> getAllScheduleMetadata() {
                return AutoDeductionScheduler.this.getAllScheduleMetadata();
            }
            @Override public boolean hasCancellationTombstone(String occurrenceKey) {
                return AutoDeductionScheduler.this.hasCancellationTombstone(occurrenceKey);
            }
            @Override public boolean clearCancellationTombstoneLocked(String occurrenceKey) {
                return AutoDeductionScheduler.this.clearCancellationTombstoneLocked(occurrenceKey);
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return AutoDeductionScheduler.this.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return AutoDeductionScheduler.this.schedulingAdapter;
            }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return AutoDeductionScheduler.this.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionEventStore eventStore() {
                return AutoDeductionScheduler.this.eventStore();
            }
            @Override public long recoveryNowForService() {
                return AutoDeductionScheduler.this.recoveryNowForService();
            }
            @Override public FireResult recoverMissedOccurrence(
                    String medicationId, String doseId, String calendarDate,
                    long scheduledAt, double amount, long generation,
                    String treatmentEndDate, String fallbackTimeHhmm) {
                return AutoDeductionScheduler.this.recoverMissedOccurrence(
                        medicationId, doseId, calendarDate, scheduledAt, amount, generation,
                        treatmentEndDate, fallbackTimeHhmm);
            }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return AutoDeductionScheduler.this.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
        };
    }

    private AutoDeductionRecovery.Host recoveryHost() {
        return new AutoDeductionRecovery.Host() {
            @Override public boolean isRecurrenceGenerationAuthorizedLocked(
                    String medicationId, String doseId, long expected) {
                return AutoDeductionScheduler.this.isRecurrenceGenerationAuthorizedLocked(
                        medicationId, doseId, expected);
            }
            @Override public boolean removeScheduleMetadataIfVersionLocked(
                    String prefKey, String expectedVersion) {
                return AutoDeductionScheduler.this.removeScheduleMetadataIfVersionLocked(
                        prefKey, expectedVersion);
            }
            @Override public long recoveryNowForService() {
                return AutoDeductionScheduler.this.recoveryNowForService();
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return AutoDeductionScheduler.this.schedulingAdapter;
            }
            @Override public ScheduleResult installFutureSuccessorIfGenerationHolds(
                    String medicationId, String doseId, String futureDate, String timeHhmm,
                    double amount, long triggerAt, long expectedGen,
                    String pastPrefKey, String observedVersion, String treatmentEndDateOverride) {
                return AutoDeductionScheduler.this.installFutureSuccessorIfGenerationHolds(
                        medicationId, doseId, futureDate, timeHhmm, amount, triggerAt,
                        expectedGen, pastPrefKey, observedVersion, treatmentEndDateOverride);
            }
            @Override public FireResult recoverMissedOccurrence(
                    String medicationId, String doseId, String calendarDate,
                    long scheduledAt, double amount, long generation,
                    String treatmentEndDate, String fallbackTimeHhmm) {
                return AutoDeductionScheduler.this.recoverMissedOccurrence(
                        medicationId, doseId, calendarDate, scheduledAt, amount, generation,
                        treatmentEndDate, fallbackTimeHhmm);
            }
            @Override public boolean removeScheduleMetadataIfVersion(
                    String prefKey, String expectedVersion) {
                return AutoDeductionScheduler.this.removeScheduleMetadataIfVersion(
                        prefKey, expectedVersion);
            }
            @Override public ScheduleResult scheduleNextOccurrenceIfSnapshotOwnsPast(
                    String medicationId, String doseId, String fromDate, String timeHhmm,
                    double amount, String pastPrefKey, String observedVersion) {
                return AutoDeductionScheduler.this.scheduleNextOccurrenceIfSnapshotOwnsPast(
                        medicationId, doseId, fromDate, timeHhmm, amount,
                        pastPrefKey, observedVersion);
            }
            @Override public Context appContext() { return AutoDeductionScheduler.this.appContext; }
            @Override public AutoDeductionEventStore eventStore() {
                return AutoDeductionScheduler.this.eventStore();
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return AutoDeductionScheduler.this.getRecurrenceGenerationLocked(medicationId, doseId);
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return AutoDeductionScheduler.this.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public AutoSuccessorObligationStore successorObligationStore() {
                return AutoDeductionScheduler.this.successorObligationStore;
            }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return AutoDeductionScheduler.this.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
            @Override public AutoDeductionRetryEvidenceStore retryEvidenceStore() {
                return AutoDeductionScheduler.this.retryEvidenceStore;
            }
            @Override public FireResult recoverFireFromIndependentEvidence(
                    String medicationId, String doseId, String calendarDate) {
                return AutoDeductionScheduler.this.recoverFireFromIndependentEvidence(
                        medicationId, doseId, calendarDate);
            }
            @Override public boolean scheduleFireRetry(
                    String medicationId, String doseId, String calendarDate, long scheduledAt,
                    double amount, String timeHhmm, long generation, String operationVersion,
                    int nextRetryCount) {
                return AutoDeductionScheduler.this.scheduleFireRetry(
                        medicationId, doseId, calendarDate, scheduledAt, amount, timeHhmm,
                        generation, operationVersion, nextRetryCount);
            }
            @Override public boolean recoverSuccessorObligations() {
                return AutoDeductionScheduler.this.recoverSuccessorObligations();
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return AutoDeductionScheduler.this.failurePolicy;
            }
            @Override public Map<String, String> getAllScheduleMetadata() {
                return AutoDeductionScheduler.this.getAllScheduleMetadata();
            }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return AutoDeductionScheduler.this.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public boolean hasCancellationTombstone(String occurrenceKey) {
                return AutoDeductionScheduler.this.hasCancellationTombstone(occurrenceKey);
            }
            @Override public boolean clearCancellationTombstoneLocked(String occurrenceKey) {
                return AutoDeductionScheduler.this.clearCancellationTombstoneLocked(occurrenceKey);
            }
            @Override public ScheduleResult scheduleOccurrenceLocked(
                    String prefKey, AutoDeductionPersistenceModels.ScheduleRecord record,
                    String requiredVersion) {
                return AutoDeductionScheduler.this.scheduleOccurrenceLocked(
                        prefKey, record, requiredVersion);
            }
            @Override public boolean compactTerminalState() {
                return AutoDeductionScheduler.this.compactTerminalState();
            }
        };
    }

    private AutoDeductionFireService.Host fireHost() {
        return new AutoDeductionFireService.Host() {
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return AutoDeductionScheduler.this.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return AutoDeductionScheduler.this.schedulingAdapter;
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return AutoDeductionScheduler.this.getRecurrenceGenerationLocked(medicationId, doseId);
            }
            @Override public AutoDeductionEventStore eventStore() {
                return AutoDeductionScheduler.this.eventStore();
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return AutoDeductionScheduler.this.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public boolean recordIndependentFireRetryEvidenceLocked(
                    String medicationId, String doseId, String calendarDate, long scheduledAt,
                    double amount, String timeHhmm, String treatmentEndDate, long generation,
                    String operationVersion, int nextRetryCount) {
                return AutoDeductionScheduler.this.recordIndependentFireRetryEvidenceLocked(
                        medicationId, doseId, calendarDate, scheduledAt, amount, timeHhmm,
                        treatmentEndDate, generation, operationVersion, nextRetryCount);
            }
            @Override public Context appContext() { return AutoDeductionScheduler.this.appContext; }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return AutoDeductionScheduler.this.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
            @Override public boolean clearIndependentFireRetryEvidenceLocked(String occurrenceKey) {
                return AutoDeductionScheduler.this.clearIndependentFireRetryEvidenceLocked(occurrenceKey);
            }
            @Override public boolean isRecurrenceGenerationAuthorizedLocked(
                    String medicationId, String doseId, long expectedGeneration) {
                return AutoDeductionScheduler.this.isRecurrenceGenerationAuthorizedLocked(
                        medicationId, doseId, expectedGeneration);
            }
        };
    }

    private AutoDeductionCancellation.Host cancellationHost() {
        return new AutoDeductionCancellation.Host() {
            @Override public Map<String, String> getAllScheduleMetadata() {
                return AutoDeductionScheduler.this.getAllScheduleMetadata();
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return AutoDeductionScheduler.this.schedulingAdapter;
            }
            @Override public boolean quarantineMalformedScheduleMetadata(
                    String prefKey, String expectedRaw, String reason) {
                return AutoDeductionScheduler.this.quarantineMalformedScheduleMetadata(
                        prefKey, expectedRaw, reason);
            }
            @Override public boolean hasCancellationTombstoneStored(String occurrenceKey) {
                return AutoDeductionScheduler.this.hasCancellationTombstoneStored(occurrenceKey);
            }
            @Override public boolean isEffectivelyCancelledStored(String occurrenceKey) {
                return AutoDeductionScheduler.this.isEffectivelyCancelledStored(occurrenceKey);
            }
            @Override public boolean clearCancellationTombstoneStored(String occurrenceKey) {
                return AutoDeductionScheduler.this.clearCancellationTombstoneStored(occurrenceKey);
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return AutoDeductionScheduler.this.getRecurrenceGenerationLocked(medicationId, doseId);
            }
        };
    }

    private AutoDeductionOccurrenceState.Host occurrenceStateHost() {
        return new AutoDeductionOccurrenceState.Host() {
            @Override public Context appContext() { return AutoDeductionScheduler.this.appContext; }
            @Override public Map<String, String> getAllScheduleMetadata() {
                return AutoDeductionScheduler.this.getAllScheduleMetadata();
            }
            @Override public AutoDeductionEventStore eventStore() {
                return AutoDeductionScheduler.this.eventStore();
            }
            @Override public AutoDeductionRetryEvidenceStore retryEvidenceStore() {
                return AutoDeductionScheduler.this.retryEvidenceStore;
            }
            @Override public AutoSuccessorObligationStore successorObligationStore() {
                return AutoDeductionScheduler.this.successorObligationStore;
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return AutoDeductionScheduler.this.failurePolicy;
            }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return AutoDeductionScheduler.this.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return AutoDeductionScheduler.this.schedulingAdapter;
            }
        };
    }

    private AutoDeductionRetry.Host retryHost() {
        return new AutoDeductionRetry.Host() {
            @Override public Context appContext() { return AutoDeductionScheduler.this.appContext; }
            @Override public boolean isOccurrenceCancelledKey(String occurrenceKey) {
                return AutoDeductionScheduler.this.isOccurrenceCancelledKey(occurrenceKey);
            }
            @Override public AutoDeductionSchedulingAdapter schedulingAdapter() {
                return AutoDeductionScheduler.this.schedulingAdapter;
            }
            @Override public long getRecurrenceGenerationLocked(String medicationId, String doseId) {
                return AutoDeductionScheduler.this.getRecurrenceGenerationLocked(medicationId, doseId);
            }
            @Override public AutoDeductionFailurePolicy failurePolicy() {
                return AutoDeductionScheduler.this.failurePolicy;
            }
            @Override public AutoDeductionEventStore eventStore() {
                return AutoDeductionScheduler.this.eventStore();
            }
            @Override public boolean persistSuccessorObligation(
                    String medicationId, String doseId, String calendarDate, String timeHhmm,
                    double amount, String treatmentEndDate, String operationVersion,
                    long recurrenceGeneration) {
                return AutoDeductionScheduler.this.persistSuccessorObligation(
                        medicationId, doseId, calendarDate, timeHhmm, amount,
                        treatmentEndDate, operationVersion, recurrenceGeneration);
            }
            @Override public boolean markSuccessorObligationStockApplied(
                    String medicationId, String doseId, String calendarDate) {
                return AutoDeductionScheduler.this.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate);
            }
            @Override public ScheduleResult scheduleNextOccurrenceFromIndependentEvidenceLocked(
                    String medicationId, String doseId, String calendarDate,
                    AutoDeductionPersistenceModels.RetryEvidenceRecord evidence) {
                return AutoDeductionScheduler.this.scheduleNextOccurrenceFromIndependentEvidenceLocked(
                        medicationId, doseId, calendarDate, evidence);
            }
            @Override public boolean clearSuccessorObligation(
                    String medicationId, String doseId, String calendarDate) {
                return AutoDeductionScheduler.this.clearSuccessorObligation(
                        medicationId, doseId, calendarDate);
            }
        };
    }

    // Collaborator implementations own recurrence, fire, recovery, retry, cancellation,
    // occurrence state, and the feature-to-shared exact-alarm scheduling boundary.

    /** Result of multi-day catch-up. FIRED count ≠ future alarms installed. */
    static final class CatchUpResult {
        final int firedCreated;
        /** True only when a new future AlarmManager schedule was installed. */
        final boolean futureInstalled;
        /**
         * True when recovery could not finish (FIRED persistence failure, epoch
         * compute failure, or future install failure that preserves the snapshot).
         * Callers must treat incomplete=true as restore boundary failure.
         */
        final boolean incomplete;
        CatchUpResult(int firedCreated, boolean futureInstalled) {
            this(firedCreated, futureInstalled, false);
        }
        CatchUpResult(int firedCreated, boolean futureInstalled, boolean incomplete) {
            this.firedCreated = firedCreated;
            this.futureInstalled = futureInstalled;
            this.incomplete = incomplete;
        }
    }
    public static final class ScheduleResult {
        public final boolean ok;
        public final String error;
        public final String occurrenceKey;
        public ScheduleResult(boolean ok, String error, String occurrenceKey) {
            this.ok = ok;
            this.error = error;
            this.occurrenceKey = occurrenceKey;
        }
        public static ScheduleResult success(String key) {
            return new ScheduleResult(true, null, key);
        }
        public static ScheduleResult fail(String error) {
            return new ScheduleResult(false, error, null);
        }
    }
    /**
     * Result of {@link #invalidateRecurrenceAuthorization}.
     * Fail-closed: {@code ok=true} only when the durable generation bump committed.
     */
    public static final class InvalidateResult {
        public final boolean ok;
        public final String error;
        /** Active generation after a successful bump, or the prior generation on a post-cancel commit failure. */
        public final long generation;
        /** True when the cancellation phase completed before a later generation commit failed. */
        public final boolean schedulesCancelled;
        public InvalidateResult(
                boolean ok,
                String error,
                long generation,
                boolean schedulesCancelled) {
            this.ok = ok;
            this.error = error;
            this.generation = generation;
            this.schedulesCancelled = schedulesCancelled;
        }
        public static InvalidateResult success(long generation) {
            return new InvalidateResult(true, null, generation, true);
        }
        public static InvalidateResult fail(String error) {
            return new InvalidateResult(false, error, 0L, false);
        }
        public static InvalidateResult failAfterCancellation(
                String error,
                long previousGeneration) {
            return new InvalidateResult(
                    false,
                    error,
                    previousGeneration,
                    true);
        }
    }
    /**
     * Result of a cancelOccurrence attempt.
     * <ul>
     *   <li>{@link Status#SUCCESS} — alarm canceled (or was absent) and metadata removed
     *       (or was already absent); intended terminal state achieved</li>
     *   <li>{@link Status#ALREADY_ABSENT} — no alarm metadata and cancel path completed
     *       (subset of SUCCESS for callers that care)</li>
     *   <li>{@link Status#FAILED} — AlarmManager unavailable, or metadata remove commit failed;
     *       intended cancellation state not fully confirmed</li>
     * </ul>
     */
    public static final class CancelResult {
        public enum Status {
            SUCCESS,
            ALREADY_ABSENT,
            FAILED
        }
        public final Status status;
        public final String error;
        /** True when this result follows one or more successful cancellations in a batch. */
        public final boolean schedulesCancelled;
        public CancelResult(Status status, String error) {
            this(status, error, false);
        }
        private CancelResult(
                Status status,
                String error,
                boolean schedulesCancelled) {
            this.status = status;
            this.error = error;
            this.schedulesCancelled = schedulesCancelled;
        }
        public boolean isOk() {
            return status == Status.SUCCESS || status == Status.ALREADY_ABSENT;
        }
        public static CancelResult success() {
            return new CancelResult(Status.SUCCESS, null);
        }
        public static CancelResult alreadyAbsent() {
            return new CancelResult(Status.ALREADY_ABSENT, null);
        }
        public static CancelResult fail(String error) {
            return new CancelResult(Status.FAILED, error, false);
        }
        public static CancelResult failAfterPartialCancellation(String error) {
            return new CancelResult(Status.FAILED, error, true);
        }
    }
    /**
     * Result of a serialized fire transition ({@link #fireOccurrenceIfNotCancelled}).
     * <ul>
     *   <li>{@link Status#CANCELLED} — cancellation linearized first; no FIRED/pending</li>
     *   <li>{@link Status#CREATED} — fire linearized; FIRED event newly committed</li>
     *   <li>{@link Status#ALREADY_EXISTS} — fire linearized; event already present</li>
     *   <li>{@link Status#FAILED} — fire linearized (not cancelled) but durable write
     *       could not be confirmed; {@link #pendingRecorded} may still be true</li>
     * </ul>
     */
    public static final class FireResult {
        public enum Status {
            CANCELLED,
            CREATED,
            ALREADY_EXISTS,
            FAILED
        }
        public final Status status;
        /** True if a pending-fire record was durably written after primary failure. */
        public final boolean pendingRecorded;
        public FireResult(Status status, boolean pendingRecorded) {
            this.status = status;
            this.pendingRecorded = pendingRecorded;
        }
        public static FireResult cancelled() {
            return new FireResult(Status.CANCELLED, false);
        }
        public static FireResult fromInsert(AutoDeductionEventStore.InsertFiredResult ir) {
            if (ir == null) {
                return new FireResult(Status.FAILED, false);
            }
            switch (ir.status) {
                case CREATED:
                    return new FireResult(Status.CREATED, ir.pendingRecorded);
                case ALREADY_EXISTS:
                    return new FireResult(Status.ALREADY_EXISTS, ir.pendingRecorded);
                case FAILED:
                default:
                    return new FireResult(Status.FAILED, ir.pendingRecorded);
            }
        }
        public boolean isCancelled() {
            return status == Status.CANCELLED;
        }
        /**
         * True when recurrence scheduling is safe because a durable fire outcome
         * exists: primary FIRED (created or already present) or pending-fire record.
         * CANCELLED and FAILED-without-pending must not advance recurrence.
         */
        public boolean allowsRecurrence() {
            return status == Status.CREATED
                    || status == Status.ALREADY_EXISTS
                    || (status == Status.FAILED && pendingRecorded);
        }
    }
    static boolean shouldRemovePastScheduleMetadata(
            AutoDeductionEventStore.InsertFiredResult ir) {
        if (ir == null) return false;
        return ir.isCreated() || ir.isAlreadyExists() || ir.pendingRecorded;
    }
    /**
     * Same recovery matrix as {@link #shouldRemovePastScheduleMetadata(AutoDeductionEventStore.InsertFiredResult)}
     * plus CANCELLED (drop stale schedule metadata; fire must not be synthesized).
     */
    static boolean shouldRemovePastScheduleMetadata(FireResult fr) {
        if (fr == null) return false;
        if (fr.isCancelled()) return true;
        // Durable fire (primary or pending) — metadata may be resolved after
        // successor scheduling succeeds; see continueRecurrenceAfterPastRecovery.
        return fr.allowsRecurrence();
    }
    /**
     * Bounded one-shot retry for a fire delivery whose durable FIRED/pending
     * persistence failed without pending evidence. The one-shot alarm is
     * consumed by the failed delivery, so without a retry the occurrence would
     * only recover via boot/TZ/JS restore paths.
     *
     * <p>The retry re-delivers the SAME occurrence identity with the same
     * generic operationVersion ownership token and Auto-owned recurrenceGeneration,
     * so {@link #fireOccurrenceIfNotCancelled} remains the single linearized
     * fire path: a retry that races a cancel is rejected as CANCELLED, and
     * insert-if-absent idempotency prevents a duplicate FIRED row or a second
     * JS wake-up. Independent fire-retry evidence in {@link AutoDeductionContract#PREFS_FIRE_RETRY}
     * is the durable authority for failed-fire recovery; the shared schedule row
     * does not carry the retry counter.
     *
     * @param nextRetryCount 1-based retry index carried in
     *        {@link AutoDeductionContract#EXTRA_FIRE_RETRY_COUNT}
     * @return true only when Auto retry evidence was durably recorded and AlarmManager
     *         accepted the retry alarm. Evidence-write failure returns false without scheduling.
     */

    /**
     * Persist independent fire-failure evidence for an occurrence.
     * Caller MUST hold SCHEDULE_LOCK. Idempotent: same occurrence increments
     * retryCount to max(existing, nextRetryCount) without duplicating rows.
     */

    /** Clear independent fire-retry evidence. Caller MUST hold SCHEDULE_LOCK. */

    /**
     * Clear independent fire-retry evidence only after the corresponding Native
     * stock mutation has been confirmed. This is deliberately separate from FIRED
     * persistence because FIRED and stock execution are two durable steps.
     */

    /**
     * Recover a previously authorized fire from independent failure evidence.
     * Does NOT require shared schedule metadata and does NOT schedule recurrence successors.
     * Lock order: SCHEDULE_LOCK → EventStore.LOCK (via insertFiredIfAbsent).
     */

    /**
     * Continue recurrence after a successful independent-fire recovery only when
     * the still-present D schedule metadata proves that the retry evidence owns it.
     *
     * <p>This closes the retry gap where Native stock recovery succeeds after the
     * one-shot D alarm was consumed: D+1 must be re-established before the native
     * process goes idle. The evidence's operationVersion, recurrence generation,
     * amount, and time must still match the live D metadata. Missing/replaced
     * metadata is treated as stale evidence and is never allowed to resurrect a
     * successor from obsolete configuration.</p>
     *
     * Caller MUST hold SCHEDULE_LOCK.
     */

    /**
     * Restore-boundary pass: ensure every durable FIRED occurrence has also reached
     * the Auto Native stock authority. This is deliberately independent of JavaScript
     * so a FIRED row left behind after a transient stock failure is recoverable on
     * boot/timezone/exact-permission lifecycle events even while the WebView is dead.
     *
     * <p>This pass never acknowledges the FIRED row. JS still owns marker/log
     * reconciliation and the final RECONCILED acknowledgement.</p>
     */

    /**
     * Restore-boundary pass: attempt recovery for every independent fire-retry
     * evidence row, even when shared schedule metadata is missing.
     */

    /**
     * Read independent fire-retry evidence for an occurrence, or null.
     * Safe without SCHEDULE_LOCK for diagnostics; mutations must use lock.
     */

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs) {
        return recurrenceService.scheduleOccurrence(
                medicationId, doseId, calendarDate, timeHhmm, amount, scheduledAtEpochMs);
    }

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs,
            String treatmentEndDate) {
        return recurrenceService.scheduleOccurrence(
                medicationId,
                doseId,
                calendarDate,
                timeHhmm,
                amount,
                scheduledAtEpochMs,
                treatmentEndDate);
    }

    boolean hasSchedule(String storageKey) {
        return storageKey != null
                && !storageKey.isEmpty()
                && schedulingAdapter.hasSchedule(storageKey);
    }
    Map<String, String> getAllScheduleMetadata() {
        return schedulingAdapter.listScheduleMetadata();
    }
    private boolean removeScheduleIfOwned(
            String storageKey,
            String expectedOperationVersion) {
        return storageKey != null
                && !storageKey.isEmpty()
                && schedulingAdapter.removeScheduleIfOwned(
                        storageKey,
                        expectedOperationVersion);
    }
    boolean removeSchedule(String storageKey) {
        return storageKey != null
                && !storageKey.isEmpty()
                && schedulingAdapter.removeSchedule(storageKey);
    }
    boolean hasCancellationTombstoneStored(String occurrenceKey) {
        return occurrenceKey != null
                && !occurrenceKey.isEmpty()
                && schedulingAdapter.hasCancellationTombstone(occurrenceKey);
    }
    boolean isEffectivelyCancelledStored(String occurrenceKey) {
        return occurrenceKey != null
                && !occurrenceKey.isEmpty()
                && schedulingAdapter.isEffectivelyCancelled(occurrenceKey);
    }
    boolean clearCancellationTombstoneStored(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        return schedulingAdapter.clearCancellationTombstone(occurrenceKey);
    }
    /**
     * Conditional rollback — caller MUST already hold {@link #SCHEDULE_LOCK}.
     */
    boolean removeScheduleMetadataIfVersionLocked(
            String storageKey, String expectedVersion) {
        return removeScheduleIfOwned(storageKey, expectedVersion);
    }
    /**
     * Conditional rollback with lock (for external/test use).
     * Reentrant-safe if already holding SCHEDULE_LOCK.
     */
    boolean removeScheduleMetadataIfVersion(String prefKey, String expectedVersion) {
        synchronized (AutoDeductionScheduler.ScheduleOperationLock.class) {
            return removeScheduleMetadataIfVersionLocked(prefKey, expectedVersion);
        }
    }
    /**
     * Unconditional remove — intentional cancel / malformed restore cleanup.
     * Caller must hold SCHEDULE_LOCK, or use the public cancel path.
     */
    void removeScheduleMetadataLocked(String storageKey) {
        removeSchedule(storageKey);
    }
    void removeScheduleMetadata(String prefKey) {
        synchronized (AutoDeductionScheduler.ScheduleOperationLock.class) {
            removeScheduleMetadataLocked(prefKey);
        }
    }
    /**
     * Cancel using the same Intent identity as schedule (action + data URI).
     * Under SCHEDULE_LOCK:
     *   1. Durable cancellation tombstone (survives process death)
     *   2. AlarmManager.cancel
     *   3. Remove active schedule metadata
     * Tombstone first so a crash after alarm cancel but before metadata remove
     * cannot later promote the stale schedule to FIRED on restore.
     *
     * Returns an explicit CancelResult:
     * SUCCESS / ALREADY_ABSENT only when the intended native state is achieved
     * (no live alarm for this occurrence + no schedule metadata, or metadata
     * removal confirmed). FAILED when AlarmManager is unavailable, tombstone
     * write fails, or metadata remove commit fails (stale metadata must not
     * be reported as success when cancellation intent is not durable).
     */

    /** True if a durable cancellation tombstone entry exists (raw presence). */





    /**
     * Schedule the next calendar-date occurrence only if it is absent and not
     * effectively cancelled.
     *
     * <p>Under one continuous {@link #SCHEDULE_LOCK} critical section:
     * <ul>
     *   <li>If D+1 durable schedule metadata already exists — return success
     *       without rewriting amount/time/alarm (duplicate/stale D payload must
     *       not overwrite a newer authoritative successor).</li>
     *   <li>If D+1 metadata is absent but the occurrence is effectively cancelled
     *       ({@link #isOccurrenceCancelledKey}) — return success without calling
     *       {@link #scheduleOccurrenceLocked}. Creating would clear the
     *       cancellation tombstone and resurrect a previously cancelled D+1.</li>
     *   <li>If D+1 is absent and not cancelled — install via
     *       {@link #scheduleOccurrenceLocked}.</li>
     * </ul>
     *
     * <p>Used by live fire recurrence ({@code AutoDeductionReceiver}) so
     * {@code ALREADY_EXISTS} / pending recovery cannot corrupt an existing D+1
     * or resurrect a cancelled successor.
     */
    /**
     * @param expectedRecurrenceGeneration generation stamped on the firing occurrence's
     *        Intent. Must be {@code > 0} and match the durable active generation;
     *        otherwise successor creation is refused.
     */

    /**
     * After a past occurrence is recovered as a durable fire, continue the
     * recurrence chain and only then resolve snapshot-owned schedule metadata.
     *
     * <p>State table:
     * <ul>
     *   <li>CANCELLED — no successor; ownership-safe remove of stale V1</li>
     *   <li>CREATED / ALREADY_EXISTS / FAILED+pending — schedule D+1 only while
     *       the snapshot still owns D; remove V1 only if successor is established</li>
     *   <li>FAILED without pending — no successor; keep metadata as recovery source</li>
     * </ul>
     *
     * <p>Stale-snapshot protection: under {@link #SCHEDULE_LOCK}, the snapshot's
     * {@code observedVersion} must still own the past schedule metadata before
     * any successor is installed from snapshot {@code timeHhmm}/{@code amount}.
     * If D was replaced (newer version) or removed, the snapshot is stale — do
     * not schedule/overwrite D+1 with obsolete parameters. If D+1 already exists,
     * leave it untouched (do not replace with snapshot params).
     */

    /**
     * Schedule D+1 from a past-recovery snapshot only while that snapshot still
     * owns the past schedule row. Caller may not hold {@link #SCHEDULE_LOCK}.
     *
     * <p>Under one continuous critical section:
     * <ol>
     *   <li>Confirm {@code pastPrefKey} metadata is still owned by {@code observedVersion}</li>
     *   <li>If not → {@code snapshot_stale} (no D+1 write)</li>
     *   <li>If D+1 metadata already exists → success without overwrite</li>
     *   <li>Otherwise install D+1 via {@link #scheduleOccurrenceLocked}</li>
     * </ol>
     */

    /**
     * Restore future alarms from persisted schedule payloads (reboot).
     *
     * Snapshot under lock (prefKey + raw JSON + observed operationVersion).
     * For each future entry, ownership validation + AlarmManager install +
     * metadata rewrite run under one continuous SCHEDULE_LOCK critical section
     * so cancel cannot interleave and resurrect a canceled schedule.
     *
     * Past schedule entries: promote via fireOccurrenceIfNotCancelled, schedule
     * the next occurrence when the fire is durable (CREATED / ALREADY_EXISTS /
     * pending), then ownership-safe metadata removal. Metadata is removed only
     * when the current operationVersion still matches the snapshot observedVersion
     * and successor scheduling succeeded (or the occurrence was CANCELLED), so a
     * newer legitimate reschedule is never deleted and recurrence is not lost.
     */
    /**
     * Explicit result of native future-schedule restoration.
     * {@code ok=false} means the recovery boundary is incomplete — JS must not
     * run destructive desired-state cleanup based on a partial snapshot.
     */
    public static final class RestoreResult {
        public final boolean ok;
        public final int restored;
        public final int failed;
        public final String error;
        public RestoreResult(boolean ok, int restored, int failed, String error) {
            this.ok = ok;
            this.restored = restored;
            this.failed = failed;
            this.error = error;
        }
        public static RestoreResult success(int restored, int failed) {
            return new RestoreResult(true, restored, failed, null);
        }
        public static RestoreResult failure(int restored, int failed, String error) {
            return new RestoreResult(false, restored, failed, error);
        }
    }

    /** Parsed medicationId + doseId + calendarDate from an Auto occurrence storage key. */
    /**
     * Quarantine malformed schedule metadata without trusting its payload identity.
     *
     * <p>The storage key is the only identity source we use for cancellation. When
     * that key is canonical, cancel the matching PendingIntent first and then remove
     * the malformed durable row. If the key is not canonical, no alarm identity can
     * be reconstructed safely, so the row is left untouched and the caller must fail
     * closed rather than pretending the native listing is authoritative.
     *
     * <p>If {@code expectedRaw} no longer matches the current row, the snapshot became
     * stale; leave the newer row untouched and report success/no-op.
     */

    /**
     * List durable schedule metadata entries (not AlarmManager state).
     * Used by JS to reconcile desired set against native after process restart
     * so stale schedules can be canceled even when trackedRef is empty.
     *
     * <p>Malformed rows are not silently skipped. Rows whose storage key still
     * identifies a real occurrence are quarantined (alarm canceled + metadata
     * removed). When the key itself is unsafe, this method throws so the JS bridge
     * reports a listing failure instead of treating the malformed row as absence.
     */

    boolean compactTerminalState() {
        return occurrenceState.compactTerminalState();
    }

    public static Long computeEpochMs(String calendarDate, String timeHhmm) {
        return AutoDeductionDateTime.computeEpochMs(calendarDate, timeHhmm);
    }

    public static String nextCalendarDate(String calendarDate) {
        return AutoDeductionDateTime.nextCalendarDate(calendarDate);
    }
    /**
     * Atomic occurrence state snapshot under {@link #SCHEDULE_LOCK} for Manual Take
     * amount authority. Linearizes with fireOccurrenceIfNotCancelled and
     * cancelOccurrence on the same lock.
     *
     * <ol>
     *   <li>Promote pending-fire records</li>
     *   <li>Unreconciled FIRED → FIRED + native event amount. Malformed FIRED
     *       payloads (invalid identity/calendar/amount) are terminalized by
     *       the EventStore as REJECTED and never surface as FIRED here.</li>
     *   <li>Effective cancellation via ordering tokens ({@link #isOccurrenceCancelledKey})
     *       → CANCELLED. Beats stale schedule metadata when a tombstone exists and
     *       metadata removal failed, unless a strictly newer schedule ordering token
     *       supersedes the cancellation.</li>
     *   <li>Durable schedule metadata → SCHEDULED + schedule amount</li>
     *   <li>Otherwise → ABSENT</li>
     * </ol>
     * Order: FIRED → effective CANCELLED → SCHEDULED → ABSENT.
     * Does not read JS doseSchedule.
     */
    public static final class OccurrenceSnapshot {
        public enum Status { FIRED, SCHEDULED, CANCELLED, ABSENT }
        public final boolean ok;
        public final Status status;
        /** Present for FIRED and SCHEDULED when amount is valid; null otherwise. */
        public final Double amount;
        /** Non-null only when the native lookup failed before a safe snapshot was established. */
        public final String error;
        public OccurrenceSnapshot(Status status, Double amount) {
            this(true, status, amount, null);
        }
        private OccurrenceSnapshot(boolean ok, Status status, Double amount, String error) {
            this.ok = ok;
            this.status = status;
            this.amount = amount;
            this.error = error;
        }
        public static OccurrenceSnapshot failure(String error) {
            return new OccurrenceSnapshot(
                    false,
                    Status.ABSENT,
                    null,
                    error != null && !error.isEmpty() ? error : "snapshot_failed");
        }
    }
    public OccurrenceSnapshot getOccurrenceSnapshot(
            String medicationId,
            String doseId,
            String calendarDate) {
        return occurrenceState.getOccurrenceSnapshot(
                medicationId, doseId, calendarDate);
    }
    CancelResult cancelAllSchedulesForDoseLocked(String medicationId, String doseId) { return cancellationService.cancelAllSchedulesForDoseLocked(medicationId, doseId); }
    long getRecurrenceGenerationLocked(String medicationId, String doseId) { return recurrenceService.getRecurrenceGenerationLocked(medicationId, doseId); }
    boolean isRecurrenceGenerationAuthorizedLocked(String medicationId, String doseId, long expected) { return recurrenceService.isRecurrenceGenerationAuthorizedLocked(medicationId, doseId, expected); }
    long ensureRecurrenceGenerationLocked(String medicationId, String doseId) { return recurrenceService.ensureRecurrenceGenerationLocked(medicationId, doseId); }
    public InvalidateResult invalidateRecurrenceAuthorization(String medicationId, String doseId) { return recurrenceService.invalidateRecurrenceAuthorization(medicationId, doseId); }
    ScheduleResult installFutureSuccessorIfGenerationHolds(
            String medicationId,
            String doseId,
            String futureDate,
            String timeHhmm,
            double amount,
            long triggerAt,
            long expectedGen,
            String pastPrefKey,
            String observedVersion,
            String treatmentEndDateOverride) {
        return recurrenceService.installFutureSuccessorIfGenerationHolds(
                medicationId,
                doseId,
                futureDate,
                timeHhmm,
                amount,
                triggerAt,
                expectedGen,
                pastPrefKey,
                observedVersion,
                treatmentEndDateOverride);
    }
    public ScheduleResult scheduleNextOccurrenceIfAbsent(String medicationId,String doseId,String fromDate,String timeHhmm,double amount,long expectedGen) { return recurrenceService.scheduleNextOccurrenceIfAbsent(medicationId,doseId,fromDate,timeHhmm,amount,expectedGen); }
    boolean recoverSuccessorObligations() { return recurrenceService.recoverSuccessorObligations(); }
    ScheduleResult scheduleNextOccurrenceFromIndependentEvidenceLocked(
            String medicationId,
            String doseId,
            String calendarDate,
            AutoDeductionPersistenceModels.RetryEvidenceRecord evidence) {
        return recurrenceService.scheduleNextOccurrenceFromIndependentEvidenceLocked(
                medicationId, doseId, calendarDate, evidence);
    }
    ScheduleResult scheduleNextOccurrenceIfSnapshotOwnsPast(String medicationId,String doseId,String fromDate,String timeHhmm,double amount,String pastPrefKey,String observedVersion) { return recurrenceService.scheduleNextOccurrenceIfSnapshotOwnsPast(medicationId,doseId,fromDate,timeHhmm,amount,pastPrefKey,observedVersion); }
    public CancelResult cancelOccurrence(String medicationId,String doseId,String calendarDate) { return cancellationService.cancelOccurrence(medicationId,doseId,calendarDate); }
    boolean hasCancellationTombstone(String occurrenceKey) { return cancellationService.hasCancellationTombstone(occurrenceKey); }
    public boolean isOccurrenceCancelled(String medicationId,String doseId,String calendarDate) { return cancellationService.isOccurrenceCancelled(medicationId,doseId,calendarDate); }
    boolean isOccurrenceCancelledKey(String occurrenceKey) { return cancellationService.isOccurrenceCancelledKey(occurrenceKey); }
    boolean clearCancellationTombstoneLocked(String occurrenceKey) { return cancellationService.clearCancellationTombstoneLocked(occurrenceKey); }
    public FireResult fireOccurrenceIfNotCancelled(String medicationId,String doseId,String calendarDate,long scheduledAt,double amount,String operationVersion,long generation) { return fireService.fireOccurrenceIfNotCancelled(medicationId,doseId,calendarDate,scheduledAt,amount,operationVersion,generation); }
    public FireResult recoverMissedOccurrence(String medicationId,String doseId,String calendarDate,long scheduledAt,double amount,long generation) { return fireService.recoverMissedOccurrence(medicationId,doseId,calendarDate,scheduledAt,amount,generation); }
    public FireResult recoverMissedOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            long generation,
            String treatmentEndDate,
            String fallbackTimeHhmm) {
        return fireService.recoverMissedOccurrence(
                medicationId,
                doseId,
                calendarDate,
                scheduledAt,
                amount,
                generation,
                treatmentEndDate,
                fallbackTimeHhmm);
    }
    public FireResult recoverMissedOccurrenceForCompensation(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            long generation,
            String treatmentEndDate,
            String fallbackTimeHhmm) {
        return fireService.recoverMissedOccurrenceForCompensation(
                medicationId,
                doseId,
                calendarDate,
                scheduledAt,
                amount,
                generation,
                treatmentEndDate,
                fallbackTimeHhmm);
    }
    boolean scheduleFireRetry(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            String timeHhmm,
            long generation,
            String operationVersion,
            int nextRetryCount) {
        AutoDeductionPersistenceModels.ScheduleRecord current =
                schedulingAdapter.getScheduleRecord(
                        AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate));
        String treatmentEndDate = current == null ? "" : current.treatmentEndDate;
        return retryService.scheduleFireRetry(
                medicationId, doseId, calendarDate, scheduledAt, amount, timeHhmm,
                treatmentEndDate, generation, operationVersion, nextRetryCount);
    }
    ScheduleResult scheduleOccurrenceLocked(
            String occurrenceKey,
            AutoDeductionPersistenceModels.ScheduleRecord record,
            String expectedOperationVersion) {
        if (record == null || record.occurrence == null) {
            return ScheduleResult.fail("invalid_schedule_record");
        }
        long generation = getRecurrenceGenerationLocked(
                record.occurrence.medicationId,
                record.occurrence.doseId);
        AutoDeductionSchedulingAdapter.ScheduleResult result =
                schedulingAdapter.scheduleOccurrence(
                        occurrenceKey,
                        record.occurrence.medicationId,
                        record.occurrence.doseId,
                        record.occurrence.calendarDate,
                        record.timeHhmm,
                        record.amount,
                        record.scheduledAtEpochMs,
                        record.treatmentEndDate,
                        generation,
                        expectedOperationVersion);
        return result.ok
                ? ScheduleResult.success(result.occurrenceKey)
                : ScheduleResult.fail(result.error);
    }
    boolean recordIndependentFireRetryEvidenceLocked(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAt,
            double amount,
            String timeHhmm,
            String treatmentEndDate,
            long generation,
            String operationVersion,
            int nextRetryCount) {
        return retryService.recordIndependentFireRetryEvidenceLocked(
                medicationId,
                doseId,
                calendarDate,
                scheduledAt,
                amount,
                timeHhmm,
                treatmentEndDate,
                generation,
                operationVersion,
                nextRetryCount);
    }
    boolean clearIndependentFireRetryEvidenceLocked(String occurrenceKey) { return retryService.clearIndependentFireRetryEvidenceLocked(occurrenceKey); }
    void clearIndependentFireRetryEvidenceAfterStock(String medicationId,String doseId,String calendarDate) { retryService.clearIndependentFireRetryEvidenceAfterStock(medicationId,doseId,calendarDate); }
    public FireResult recoverFireFromIndependentEvidence(String medicationId,String doseId,String calendarDate) { return retryService.recoverFireFromIndependentEvidence(medicationId,doseId,calendarDate); }
    AutoDeductionPersistenceModels.RetryEvidenceRecord getIndependentFireRetryEvidence(
            String medicationId, String doseId, String calendarDate) {
        return retryService.getIndependentFireRetryEvidence(
                medicationId, doseId, calendarDate);
    }
    CatchUpResult catchUpMissedOccurrencesAndScheduleNext(String medicationId,String doseId,String fromDate,String timeHhmm,double amount,long generation,String pastPrefKey,String observedVersion) { return recoveryService.catchUpMissedOccurrencesAndScheduleNext(medicationId,doseId,fromDate,timeHhmm,amount,generation,pastPrefKey,observedVersion); }
    void continueRecurrenceAfterPastRecovery(String medicationId,String doseId,String calendarDate,String timeHhmm,double amount,FireResult fr,String prefKey,String observedVersion) { recoveryService.continueRecurrenceAfterPastRecovery(medicationId,doseId,calendarDate,timeHhmm,amount,fr,prefKey,observedVersion); }
    RestoreResult recoverFiredStockPass() { return recoveryService.recoverFiredStockPass(); }
    RestoreResult recoverIndependentFireRetryEvidencePass() { return recoveryService.recoverIndependentFireRetryEvidencePass(); }
    public RestoreResult restoreFutureSchedules() { return recoveryService.restoreFutureSchedules(); }
    boolean quarantineMalformedScheduleMetadata(String prefKey,String expectedRaw,String reason) { return recoveryService.quarantineMalformedScheduleMetadata(prefKey,expectedRaw,reason); }
    public java.util.List<AutoDeductionPersistenceModels.ScheduledOccurrenceRecord>
        listScheduledOccurrences() {
        return recoveryService.listScheduledOccurrences();
    }

}