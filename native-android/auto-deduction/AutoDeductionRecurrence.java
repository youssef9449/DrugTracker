package app.drugtracker.autodeduction;

import android.util.Log;
import app.drugtracker.autodeduction.AutoDeductionScheduler.ScheduleResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.FireResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.InvalidateResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.CancelResult;

/** Focused Auto-Deduction responsibility collaborator: AutoDeductionRecurrence. */
final class AutoDeductionRecurrence {
    /**
     * Host surface narrowed to the ports this service consumes (#466): the
     * recurrence service OWNS generation storage, so GenerationPort is not
     * part of its host; the remaining capabilities come from the named ports.
     */
    interface Host extends
            AutoDeductionPorts.AppContextPort,
            AutoDeductionPorts.ScheduleStoragePort,
            AutoDeductionPorts.RecoveryEvidencePort,
            AutoDeductionPorts.CancellationPort,
            AutoDeductionPorts.FailurePolicyPort,
            AutoDeductionPorts.SuccessorObligationPort {
        CancelResult cancelAllSchedulesForDoseLocked(String medicationId, String doseId);
        boolean removeScheduleMetadataIfVersionLocked(String prefKey, String expectedVersion);
        FireResult recoverMissedOccurrence(
                String medicationId, String doseId, String calendarDate,
                long scheduledAt, double amount, long generation,
                String treatmentEndDate, String fallbackTimeHhmm);
    }

    private final Host host;
    /** Recurrence authorization generation persistence (#489 extraction). */
    private final AutoDeductionRecurrenceGenerationStore generationStore;

    AutoDeductionRecurrence(Host host) {
        this.host = host;
        this.generationStore = new AutoDeductionRecurrenceGenerationStore(
                host.appContext());
    }

long getRecurrenceGenerationLocked(String medicationId, String doseId) {
        return generationStore.getLocked(medicationId, doseId);
    }

boolean isRecurrenceGenerationAuthorizedLocked(
            String medicationId,
            String doseId,
            long expectedGeneration
    ) {
        return generationStore.isAuthorizedLocked(medicationId, doseId, expectedGeneration);
    }

long ensureRecurrenceGenerationLocked(String medicationId, String doseId) {
        return generationStore.ensureLocked(medicationId, doseId);
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
        // Historical/overdue occurrences may have no live schedule row because
        // their one-shot alarm has already been consumed. In that case the durable
        // successor obligation is authorized by recurrenceGeneration; active/future
        // obligations retain operationVersion ownership for replacement safety.
        if (operationVersion == null) return false;
        try {
            return host.successorObligationStore().save(
                    new AutoDeductionPersistenceModels.SuccessorObligationRecord(
                            new AutoDeductionPersistenceModels.OccurrenceId(
                                    medicationId, doseId, calendarDate),
                            timeHhmm,
                            amount,
                            treatmentEndDate == null ? "" : treatmentEndDate,
                            operationVersion,
                            recurrenceGeneration,
                            false,
                            System.currentTimeMillis()));
        } catch (RuntimeException e) {
            return false;
        }
    }

public InvalidateResult invalidateRecurrenceAuthorization(
            String medicationId,
            String doseId
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()) {
            return InvalidateResult.fail("invalid_args");
        }
        synchronized (AutoDeductionScheduler.class) {
            long prev = generationStore.getLocked(medicationId, doseId);

            // Cancellation linearizes first. If any durable cancellation step fails,
            // the recurrence generation is intentionally left unchanged so the
            // previous JS state remains natively valid and can be retried safely.
            CancelResult cancel =
                    host.cancelAllSchedulesForDoseLocked(medicationId, doseId);
            if (!cancel.isOk()) {
                Log.e("AutoDeductionScheduler",
                        "invalidateRecurrenceAuthorization: cancellation failed for "
                                + medicationId + "/" + doseId
                                + " — generation unchanged=" + prev
                                + "; schedulesCancelled=" + cancel.schedulesCancelled
                                + "; error=" + cancel.error);
                return cancel.schedulesCancelled && prev > 0L
                        ? InvalidateResult.failAfterCancellation(cancel.error, prev)
                        : InvalidateResult.fail(cancel.error);
            }

            long next = prev <= 0L ? 1L : prev + 1L;
            boolean committed = host.failurePolicy().allowRecurrenceAuthCommit()
                    && generationStore.commitLocked(medicationId, doseId, next);
            if (!committed) {
                Log.e("AutoDeductionScheduler",
                        "invalidateRecurrenceAuthorization: generation commit failed after "
                                + "cancellation for " + medicationId + "/" + doseId
                                + " — schedules are already canceled; caller must retry "
                                + "desired-state scheduling");
                return InvalidateResult.failAfterCancellation(
                        "recurrence_generation_commit_failed",
                        prev);
            }
            Log.i("AutoDeductionScheduler",
                    "invalidateRecurrenceAuthorization: generation "
                            + prev + " -> " + next + " after cancellation for "
                            + medicationId + "/" + doseId);
            return InvalidateResult.success(next);
        }
    }

ScheduleResult installFutureSuccessorIfGenerationHolds(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long triggerAt,
            long expectedRecurrenceGeneration,
            String pastPrefKey,
            String observedVersion,
            String treatmentEndDateOverride
    ) {
        final String futureKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        final String futurePrefKey = futureKey;
        synchronized (AutoDeductionScheduler.class) {
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                host.removeScheduleMetadataIfVersionLocked(pastPrefKey, observedVersion);
                return ScheduleResult.fail("recurrence_generation_unauthorized");
            }
            // Past snapshot must still be the one we are recovering from (if present).
            if (pastPrefKey != null && observedVersion != null && !observedVersion.isEmpty()) {
                if (!host.schedulingAdapter()
                        .isScheduleOwnedByOperationVersion(pastPrefKey, observedVersion)
                        && host.schedulingAdapter().getScheduleRecord(pastPrefKey) != null) {
                    return ScheduleResult.fail("snapshot_stale");
                }
            }
            String treatmentEndDate = treatmentEndDateOverride == null
                    ? ""
                    : treatmentEndDateOverride;
            AutoDeductionPersistenceModels.ScheduleRecord currentPast =
                    host.schedulingAdapter().getScheduleRecord(pastPrefKey);
            if (currentPast != null) {
                treatmentEndDate = currentPast.treatmentEndDate;
            }
            // Consolidated treatment-end precondition (#514): the validity
            // rule exists ONCE and its result is reused by the successor
            // installation path below.
            if (!isValidTreatmentEndDate(treatmentEndDate)) {
                return ScheduleResult.fail("invalid_treatment_end_date");
            }
            if (!treatmentEndDate.isEmpty()) {
                if (calendarDate.compareTo(treatmentEndDate) > 0) {
                    if (!cleanupPastScheduleIfOwnedLocked(pastPrefKey, observedVersion)) {
                        return ScheduleResult.fail("source_schedule_cleanup_failed");
                    }
                    return new ScheduleResult(true, "treatment_ended", futureKey);
                }
            }
            // If future already exists under same identity, do not replace.
            // EXCEPTION — same-key recovery: when the first not-yet-due occurrence
            // IS the past snapshot's own date (fromCalendarDate == calendarDate,
            // i.e. a today-occurrence whose time is still ahead), the "existing"
            // metadata is the very snapshot being recovered, not a separate live
            // schedule. It must be re-armed under a fresh ordering token here;
            // otherwise the trailing snapshot removal in catchUp (version match)
            // deletes the only schedule row for the still-pending occurrence and
            // it silently disappears (no FIRED, no SCHEDULED, no alarm).
            boolean sameKeyRecovery =
                    pastPrefKey != null && pastPrefKey.equals(futurePrefKey);
            boolean futureAlreadyExists =
                    host.schedulingAdapter().getScheduleRecord(futurePrefKey) != null;
            if (futureAlreadyExists) {
                if (sameKeyRecovery) {
                    // The persisted source is itself the first future occurrence.
                    // It is already the authoritative live schedule; do not rewrite
                    // its operationVersion or remove it during catch-up cleanup.
                    return new ScheduleResult(true, "already_present", futureKey);
                }
                if (!cleanupPastScheduleIfOwnedLocked(pastPrefKey, observedVersion)) {
                    return ScheduleResult.fail("source_schedule_cleanup_failed");
                }
                return new ScheduleResult(true, "already_present", futureKey);
            }
            // Effective cancellation (tombstone) must not be cleared by recovery:
            // scheduleOccurrenceLocked would clearCancellationTombstoneLocked.
            if (host.isOccurrenceCancelledKey(futureKey)) {
                Log.i("AutoDeductionScheduler", "catchUp: future successor cancelled — leave tombstone, no reinstall "
                        + futureKey);
                return new ScheduleResult(true, "cancelled_skip", futureKey);
            }
            AutoDeductionPersistenceModels.ScheduleRecord record =
                    new AutoDeductionPersistenceModels.ScheduleRecord(
                            new AutoDeductionPersistenceModels.OccurrenceId(
                                    medicationId, doseId, calendarDate),
                            timeHhmm,
                            amount,
                            triggerAt,
                            treatmentEndDate,
                            "");
            // Pass expected generation so the shared runtime cannot stamp a newer gen.
            ScheduleResult scheduled = scheduleOccurrenceLocked(
                    futurePrefKey,
                    record,
                    null,
                    expectedRecurrenceGeneration);
            if (!scheduled.ok) {
                return scheduled;
            }
            if (!sameKeyRecovery
                    && !cleanupPastScheduleIfOwnedLocked(pastPrefKey, observedVersion)) {
                return ScheduleResult.fail("source_schedule_cleanup_failed");
            }
            return scheduled;
        }
    }

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs) {
        return scheduleOccurrence(
                medicationId,
                doseId,
                calendarDate,
                timeHhmm,
                amount,
                scheduledAtEpochMs,
                null);
    }

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs,
            String treatmentEndDate) {
        if (medicationId == null || medicationId.isEmpty()) {
            return ScheduleResult.fail("missing_medicationId");
        }
        if (doseId == null || doseId.isEmpty()) {
            return ScheduleResult.fail("missing_doseId");
        }
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return ScheduleResult.fail("invalid_calendarDate");
        }
        if (!AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            return ScheduleResult.fail("invalid_time");
        }
        if (!AutoDeductionContract.isValidAmount(amount)) {
            return ScheduleResult.fail("invalid_amount");
        }
        if (treatmentEndDate != null && !treatmentEndDate.isEmpty()) {
            if (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
                return ScheduleResult.fail("invalid_treatment_end_date");
            }
            if (calendarDate.compareTo(treatmentEndDate) > 0) {
                return ScheduleResult.fail("treatment_ended");
            }
        }
        long triggerAt = scheduledAtEpochMs;
        if (triggerAt <= 0L) {
            Long computed = AutoDeductionScheduler.computeEpochMs(calendarDate, timeHhmm);
            if (computed == null) return ScheduleResult.fail("invalid_datetime");
            triggerAt = computed;
        }
        if (triggerAt <= System.currentTimeMillis() - 2000L) {
            return ScheduleResult.fail("trigger_in_past");
        }
        if (!app.drugtracker.alarmruntime.ExactAlarmRuntime.canScheduleExactAlarms(host.appContext())) {
            return ScheduleResult.fail("exact_alarm_permission_denied");
        }
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        AutoDeductionPersistenceModels.ScheduleRecord record =
                new AutoDeductionPersistenceModels.ScheduleRecord(
                        new AutoDeductionPersistenceModels.OccurrenceId(
                                medicationId, doseId, calendarDate),
                        timeHhmm,
                        amount,
                        triggerAt,
                        treatmentEndDate == null ? "" : treatmentEndDate,
                        "");
        synchronized (AutoDeductionScheduler.class) {
            return scheduleOccurrenceLocked(key, record, null, null);
        }
    }

    ScheduleResult scheduleOccurrenceLocked(
            String prefKey,
            AutoDeductionPersistenceModels.ScheduleRecord record,
            String requiredVersion,
            Long requiredRecurrenceGeneration) {
        if (record == null
                || record.occurrence == null
                || !record.operationVersion.isEmpty()) {
            return ScheduleResult.fail("invalid_schedule_record");
        }
        final String medicationId = record.occurrence.medicationId;
        final String doseId = record.occurrence.doseId;
        final String calendarDate = record.occurrence.calendarDate;
        final String timeHhmm = record.timeHhmm;
        final double amount = record.amount;
        final String treatmentEndDate = record.treatmentEndDate;
        final long triggerAt = record.scheduledAtEpochMs;
        if (!treatmentEndDate.isEmpty()
                && (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)
                || calendarDate.compareTo(treatmentEndDate) > 0)) {
            return ScheduleResult.fail("treatment_ended");
        }

        final long recurrenceGeneration;
        if (requiredRecurrenceGeneration != null) {
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId,
                    doseId,
                    requiredRecurrenceGeneration)) {
                return ScheduleResult.fail("recurrence_generation_unauthorized");
            }
            recurrenceGeneration = requiredRecurrenceGeneration;
        } else if (requiredVersion != null && !requiredVersion.isEmpty()) {
            long existing = getRecurrenceGenerationLocked(medicationId, doseId);
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, existing)) {
                return ScheduleResult.fail("recurrence_generation_unauthorized");
            }
            recurrenceGeneration = existing;
        } else {
            long ensured = ensureRecurrenceGenerationLocked(medicationId, doseId);
            if (ensured <= 0L) {
                return ScheduleResult.fail("recurrence_generation_write_failed");
            }
            recurrenceGeneration = ensured;
        }

        AutoDeductionSchedulingAdapter.ScheduleResult result =
                host.schedulingAdapter().scheduleOccurrence(
                        record.occurrence.canonicalKey(),
                        medicationId,
                        doseId,
                        calendarDate,
                        timeHhmm,
                        amount,
                        triggerAt,
                        treatmentEndDate.isEmpty() ? null : treatmentEndDate,
                        recurrenceGeneration,
                        requiredVersion);
        if (!result.ok) {
            return ScheduleResult.fail(result.error);
        }
        return ScheduleResult.success(record.occurrence.canonicalKey());
    }

        /**
     * Named treatment-end validity precondition (#514): one definition of a
     * usable treatmentEndDate (empty = unbounded; otherwise a real calendar
     * date). Reused by the successor-installation flow.
     */
    private static boolean isValidTreatmentEndDate(String treatmentEndDate) {
        return treatmentEndDate == null
                || treatmentEndDate.isEmpty()
                || AutoDeductionContract.isValidCalendarDate(treatmentEndDate);
    }

    /**
     * Shared recurrence-walking decision (#509): the ONE canonical
     * treatment-end gate applied by every successor-walking path
     * (if-absent continuation, obligation continuation). Returns null when
     * the walk may continue past nextDate, or the terminal walk outcome.
     */
    private ScheduleResult treatmentEndWalkGate(
            String treatmentEndDate,
            String nextDate,
            String medicationId,
            String doseId) {
        if (!isValidTreatmentEndDate(treatmentEndDate)) {
            return ScheduleResult.fail("invalid_treatment_end_date");
        }
        if (!treatmentEndDate.isEmpty()
                && nextDate.compareTo(treatmentEndDate) > 0) {
            return new ScheduleResult(
                    true,
                    "treatment_ended",
                    AutoDeductionContract.occurrenceKey(
                            medicationId, doseId, nextDate));
        }
        return null;
    }

    private boolean cleanupPastScheduleIfOwnedLocked(
            String pastPrefKey,
            String observedVersion) {
        if (pastPrefKey == null || pastPrefKey.isEmpty()
                || observedVersion == null || observedVersion.isEmpty()) {
            return true;
        }
        AutoDeductionPersistenceModels.ScheduleRecord current =
                host.schedulingAdapter().getScheduleRecord(pastPrefKey);
        if (current == null || !observedVersion.equals(current.operationVersion)) {
            return true;
        }
        return host.schedulingAdapter().removeScheduleIfOwned(
                pastPrefKey,
                observedVersion);
    }

public ScheduleResult scheduleNextOccurrenceIfAbsent(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount,
            long expectedRecurrenceGeneration
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(fromCalendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)
                || expectedRecurrenceGeneration <= 0L) {
            return ScheduleResult.fail("invalid_args");
        }

        final String sourceKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, fromCalendarDate);
        String nextDate = AutoDeductionScheduler.nextCalendarDate(fromCalendarDate);
        if (nextDate == null) return ScheduleResult.fail("invalid_next_date");

        String operationVersion = "";
        String activeTime = timeHhmm;
        double activeAmount = amount;
        String treatmentEndDate = "";
        boolean liveSourceOwned = false;
        boolean originalSourceWasLive = false;
        String originalSourceOperationVersion = "";

        synchronized (AutoDeductionScheduler.class) {
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                return ScheduleResult.fail("recurrence_authorization_invalid");
            }

            String nextKey = AutoDeductionContract.occurrenceKey(
                    medicationId, doseId, nextDate);
            if (host.isOccurrenceCancelledKey(nextKey)) {
                return new ScheduleResult(true, "cancelled_skip", nextKey);
            }

            // A successor already installed is the terminal idempotent outcome for
            // duplicate/stale deliveries, even when the source occurrence has
            // already been consumed and its metadata retired.
            if (!sourceKey.equals(nextKey)
                    && host.schedulingAdapter().getScheduleRecord(nextKey) != null) {
                return new ScheduleResult(true, "already_present", nextKey);
            }

            AutoDeductionPersistenceModels.ScheduleRecord source =
                    host.schedulingAdapter().getScheduleRecord(sourceKey);
            if (source != null) {
                operationVersion = source.operationVersion;
                activeTime = source.timeHhmm;
                activeAmount = source.amount;
                treatmentEndDate = source.treatmentEndDate;
                liveSourceOwned = !operationVersion.isEmpty();
                originalSourceWasLive = liveSourceOwned;
                originalSourceOperationVersion = operationVersion;
                if (!liveSourceOwned
                        || !AutoDeductionContract.isValidTimeHhmm(activeTime)
                        || !AutoDeductionContract.isValidAmount(activeAmount)
                        || (!treatmentEndDate.isEmpty()
                            && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate))) {
                    return ScheduleResult.fail("snapshot_stale");
                }
            } else {
                // Historical recurrence may legitimately have no schedule row after
                // its one-shot alarm was consumed. Prefer the durable successor
                // obligation as the source snapshot; otherwise a FIRED event is enough
                // to prove the occurrence identity and requested amount for idempotent
                // continuation.
                AutoDeductionPersistenceModels.SuccessorObligationRecord obligation =
                        host.successorObligationStore().get(
                                medicationId, doseId, fromCalendarDate);
                if (obligation != null
                        && obligation.recurrenceGeneration == expectedRecurrenceGeneration
                        && obligation.timeHhmm.equals(timeHhmm)
                        && Double.compare(obligation.amount, amount) == 0) {
                    activeTime = obligation.timeHhmm;
                    activeAmount = obligation.amount;
                    treatmentEndDate = obligation.treatmentEndDate;
                    operationVersion = obligation.operationVersion;
                } else {
                    AutoDeductionEventStore.EventLookupResult fired =
                            host.eventStore().getFiredUnreconciledEvent(
                                    medicationId, doseId, fromCalendarDate);
                    if (!fired.ok || fired.record == null
                            || Double.compare(fired.record.amount, amount) != 0) {
                        return ScheduleResult.fail("snapshot_stale");
                    }
                    activeAmount = fired.record.amount;
                    operationVersion = "";
                    treatmentEndDate = "";
                }
            }
        }

        while (true) {
            // Shared recurrence-walking gate (#509) — validity was already
            // part of the source-snapshot acceptance above; the canonical
            // gate keeps both paths on the same decision.
            ScheduleResult gate = treatmentEndWalkGate(
                    treatmentEndDate,
                    nextDate,
                    medicationId,
                    doseId);
            if (gate != null) {
                return gate;
            }

            Long epoch = AutoDeductionScheduler.computeEpochMs(nextDate, activeTime);
            if (epoch == null) return ScheduleResult.fail("invalid_next_datetime");

            boolean sourcePayloadMatches =
                    timeHhmm.equals(activeTime)
                            && Double.compare(amount, activeAmount) == 0;

            if (epoch > host.recoveryNowForService()) {
                synchronized (AutoDeductionScheduler.class) {
                    if (!isRecurrenceGenerationAuthorizedLocked(
                            medicationId, doseId, expectedRecurrenceGeneration)) {
                        return ScheduleResult.fail("recurrence_authorization_invalid");
                    }

                    String futureKey = AutoDeductionContract.occurrenceKey(
                            medicationId, doseId, nextDate);
                    if (host.isOccurrenceCancelledKey(futureKey)) {
                        return new ScheduleResult(true, "cancelled_skip", futureKey);
                    }
                    if (host.schedulingAdapter().getScheduleRecord(futureKey) != null) {
                        return new ScheduleResult(true, "already_present", futureKey);
                    }
                    if (!sourcePayloadMatches) {
                        return ScheduleResult.fail("snapshot_stale");
                    }

                    ScheduleResult successor = installFutureSuccessorIfGenerationHolds(
                            medicationId,
                            doseId,
                            nextDate,
                            timeHhmm,
                            amount,
                            epoch,
                            expectedRecurrenceGeneration,
                            liveSourceOwned ? sourceKey : null,
                            liveSourceOwned ? operationVersion : "",
                            treatmentEndDate);
                    if (successor.ok) {
                        host.successorObligationStore().clear(
                                medicationId, doseId, fromCalendarDate);
                        if (originalSourceWasLive) {
                            host.schedulingAdapter().removeScheduleIfOwned(
                                    sourceKey,
                                    originalSourceOperationVersion);
                        }
                    }
                    return successor;
                }
            }

            if (!sourcePayloadMatches) {
                return ScheduleResult.fail("snapshot_stale");
            }

            if (!new AutoDeductionStockStore(host.appContext()).isInitialized()) {
                return ScheduleResult.fail("stock_not_initialized");
            }

            AutoDeductionScheduler.FireResult recovered =
                    host.recoverMissedOccurrence(
                            medicationId,
                            doseId,
                            nextDate,
                            epoch,
                            amount,
                            expectedRecurrenceGeneration,
                            treatmentEndDate,
                            activeTime);
            if (recovered.isCancelled()) {
                return new ScheduleResult(
                        true,
                        "cancelled_skip",
                        AutoDeductionContract.occurrenceKey(
                                medicationId, doseId, nextDate));
            }
            if (!recovered.allowsRecurrence()) {
                return ScheduleResult.fail("successor_catchup_failed");
            }

            host.successorObligationStore().clear(
                    medicationId, doseId, fromCalendarDate);
            // The recovered overdue occurrence is now the source for the next
            // iteration. Its consumed schedule no longer exists, so continue from
            // the durable FIRED/obligation evidence rather than requiring a live row.
            fromCalendarDate = nextDate;
            operationVersion = "";
            liveSourceOwned = false;
            nextDate = AutoDeductionScheduler.nextCalendarDate(nextDate);
            if (nextDate == null) {
                return ScheduleResult.fail("invalid_next_date");
            }
        }
    }

    /** Resolve durable successor obligations left by a process death. */
    boolean recoverSuccessorObligations() {
        AutoSuccessorObligationStore.ListResult listed =
                host.successorObligationStore().listAll();
        if (!listed.ok) {
            Log.e("AutoDeductionScheduler",
                    "successor obligation listing failed: " + listed.error);
            return false;
        }

        boolean allResolved = true;
        for (AutoDeductionPersistenceModels.SuccessorObligationRecord obligation
                : listed.obligations) {
            final String medicationId = obligation.sourceOccurrence.medicationId;
            final String doseId = obligation.sourceOccurrence.doseId;
            final String calendarDate = obligation.sourceOccurrence.calendarDate;
            final String sourceKey =
                    AutoDeductionContract.occurrenceKey(
                            medicationId, doseId, calendarDate);

            synchronized (AutoDeductionScheduler.class) {
                if (!isRecurrenceGenerationAuthorizedLocked(
                        medicationId, doseId, obligation.recurrenceGeneration)) {
                    host.successorObligationStore().clear(
                            medicationId, doseId, calendarDate);
                    continue;
                }
                if (host.isOccurrenceCancelledKey(sourceKey)) {
                    host.successorObligationStore().clear(
                            medicationId, doseId, calendarDate);
                    continue;
                }

                AutoDeductionPersistenceModels.ScheduleRecord source =
                        host.schedulingAdapter().getScheduleRecord(sourceKey);
                if (source != null) {
                    if (!obligation.operationVersion.equals(source.operationVersion)
                            || !obligation.timeHhmm.equals(source.timeHhmm)
                            || Double.compare(obligation.amount, source.amount) != 0
                            || !source.treatmentEndDate.equals(obligation.treatmentEndDate)) {
                        host.successorObligationStore().clear(
                                medicationId, doseId, calendarDate);
                        continue;
                    }
                } else if (!obligation.operationVersion.isEmpty()) {
                    // A non-empty operationVersion must still be proven against the
                    // source schedule. Empty means the source was an overdue
                    // catch-up occurrence whose one-shot schedule has been consumed.
                    host.successorObligationStore().clear(
                            medicationId, doseId, calendarDate);
                    continue;
                }
            }

            if (!obligation.stockApplied) {
                AutoDeductionStockStore.AutoApplyResult stockResult =
                        new AutoDeductionStockStore(host.appContext()).applyAutoDeductionForRecovery(
                                medicationId,
                                doseId,
                                calendarDate,
                                obligation.amount);
                if (!stockResult.ok) {
                    allResolved = false;
                    continue;
                }
                if (!host.markSuccessorObligationStockApplied(
                        medicationId, doseId, calendarDate)) {
                    allResolved = false;
                    continue;
                }
            }

            ScheduleResult result = scheduleNextOccurrenceFromObligation(obligation);
            if (result.ok) {
                host.successorObligationStore().clear(
                        medicationId, doseId, calendarDate);
                continue;
            }

            if ("recurrence_authorization_invalid".equals(result.error)
                    || "snapshot_stale".equals(result.error)
                    || "treatment_ended".equals(result.error)
                    || "cancelled_skip".equals(result.error)) {
                host.successorObligationStore().clear(
                        medicationId, doseId, calendarDate);
            } else {
                allResolved = false;
            }
        }
        return allResolved;
    }

    /**
     * Continue a durable successor obligation even when its source schedule row
     * has already been consumed by overdue catch-up.
     *
     * <p>The obligation is handed forward only after the next overdue occurrence
     * has durably established its own obligation. A crash at any point therefore
     * leaves the latest recovery source needed to continue the chain.</p>
     */
    private ScheduleResult scheduleNextOccurrenceFromObligation(
            AutoDeductionPersistenceModels.SuccessorObligationRecord obligation) {
        if (obligation == null
                || obligation.sourceOccurrence == null
                || !AutoDeductionContract.isValidCalendarDate(
                        obligation.sourceOccurrence.calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(obligation.timeHhmm)
                || !AutoDeductionContract.isValidAmount(obligation.amount)
                || obligation.recurrenceGeneration <= 0L) {
            return ScheduleResult.fail("snapshot_stale");
        }

        final String medicationId = obligation.sourceOccurrence.medicationId;
        final String doseId = obligation.sourceOccurrence.doseId;
        String currentObligationDate = obligation.sourceOccurrence.calendarDate;
        String nextDate = AutoDeductionScheduler.nextCalendarDate(currentObligationDate);

        while (nextDate != null) {
            // Shared recurrence-walking gate (#509) — same decision as the
            // if-absent path so edge-case fixes cannot drift.
            ScheduleResult gate = treatmentEndWalkGate(
                    obligation.treatmentEndDate,
                    nextDate,
                    medicationId,
                    doseId);
            if (gate != null) {
                return gate;
            }

            Long epoch = AutoDeductionScheduler.computeEpochMs(
                    nextDate,
                    obligation.timeHhmm);
            if (epoch == null) {
                return ScheduleResult.fail("invalid_next_datetime");
            }

            if (epoch.longValue() > host.recoveryNowForService()) {
                synchronized (AutoDeductionScheduler.class) {
                    if (!isRecurrenceGenerationAuthorizedLocked(
                            medicationId,
                            doseId,
                            obligation.recurrenceGeneration)) {
                        return ScheduleResult.fail("recurrence_authorization_invalid");
                    }
                    String key = AutoDeductionContract.occurrenceKey(
                            medicationId, doseId, nextDate);
                    AutoDeductionPersistenceModels.ScheduleRecord existing =
                            host.schedulingAdapter().getScheduleRecord(key);
                    if (existing != null) {
                        // The successor is already authoritative. Retire the consumed
                        // source row only when the obligation still proves ownership.
                        if (!currentObligationDate.equals(nextDate)
                                && !obligation.operationVersion.isEmpty()) {
                            host.schedulingAdapter().removeScheduleIfOwned(
                                    AutoDeductionContract.occurrenceKey(
                                            medicationId,
                                            doseId,
                                            currentObligationDate),
                                    obligation.operationVersion);
                        }
                        host.successorObligationStore().clear(
                                medicationId, doseId, currentObligationDate);
                        return new ScheduleResult(true, "already_present", key);
                    }
                    if (host.isOccurrenceCancelledKey(key)) {
                        host.successorObligationStore().clear(
                                medicationId, doseId, currentObligationDate);
                        return new ScheduleResult(true, "cancelled_skip", key);
                    }
                    ScheduleResult successor = installFutureSuccessorIfGenerationHolds(
                            medicationId,
                            doseId,
                            nextDate,
                            obligation.timeHhmm,
                            obligation.amount,
                            epoch.longValue(),
                            obligation.recurrenceGeneration,
                            null,
                            "",
                            obligation.treatmentEndDate);
                    if (successor.ok) {
                        host.successorObligationStore().clear(
                                medicationId, doseId, currentObligationDate);
                    }
                    return successor;
                }
            }

            if (!new AutoDeductionStockStore(
                    host.appContext()).isInitialized()) {
                return ScheduleResult.fail("stock_not_initialized");
            }

            AutoDeductionScheduler.FireResult recovered = host.recoverMissedOccurrence(
                    medicationId,
                    doseId,
                    nextDate,
                    epoch.longValue(),
                    obligation.amount,
                    obligation.recurrenceGeneration,
                    obligation.treatmentEndDate,
                    obligation.timeHhmm);
            if (recovered.isCancelled()) {
                return new ScheduleResult(
                        true,
                        "cancelled_skip",
                        AutoDeductionContract.occurrenceKey(
                                medicationId, doseId, nextDate));
            }
            if (!recovered.allowsRecurrence()) {
                return ScheduleResult.fail("successor_catchup_failed");
            }

            host.successorObligationStore().clear(
                    medicationId,
                    doseId,
                    currentObligationDate);
            currentObligationDate = nextDate;
            nextDate = AutoDeductionScheduler.nextCalendarDate(nextDate);
        }

        return ScheduleResult.fail("invalid_next_date");
    }


ScheduleResult scheduleNextOccurrenceFromIndependentEvidenceLocked(
            String medicationId,
            String doseId,
            String calendarDate,
            AutoDeductionPersistenceModels.RetryEvidenceRecord evidence
    ) {
        if (evidence == null
                || medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return ScheduleResult.fail("snapshot_stale");
        }
        String prefKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        AutoDeductionPersistenceModels.ScheduleRecord current =
                host.schedulingAdapter().getScheduleRecord(prefKey);
        if (current == null) {
            return ScheduleResult.fail("snapshot_stale");
        }
        long activeGeneration = getRecurrenceGenerationLocked(medicationId, doseId);
        if (!evidence.operationVersion.equals(current.operationVersion)
                || evidence.recurrenceGeneration != activeGeneration
                || !evidence.timeHhmm.equals(current.timeHhmm)
                || Double.compare(evidence.amount, current.amount) != 0) {
            return ScheduleResult.fail("snapshot_stale");
        }
        return scheduleNextOccurrenceIfAbsent(
                medicationId,
                doseId,
                calendarDate,
                evidence.timeHhmm,
                evidence.amount,
                evidence.recurrenceGeneration);
    }

ScheduleResult scheduleNextOccurrenceIfSnapshotOwnsPast(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount,
            String pastPrefKey,
            String observedVersion
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(fromCalendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)) {
            return ScheduleResult.fail("invalid_args");
        }
        if (pastPrefKey == null || pastPrefKey.isEmpty()
                || observedVersion == null || observedVersion.isEmpty()) {
            return ScheduleResult.fail("snapshot_stale");
        }
        final long generation;
        synchronized (AutoDeductionScheduler.class) {
            if (!host.schedulingAdapter()
                    .isScheduleOwnedByOperationVersion(pastPrefKey, observedVersion)) {
                return ScheduleResult.fail("snapshot_stale");
            }
            generation = getRecurrenceGenerationLocked(medicationId, doseId);
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, generation)) {
                return ScheduleResult.fail("recurrence_authorization_invalid");
            }
        }
        // Reuse the same successor walker as live recurrence. It recovers every
        // already-due successor in order and installs only the first future one.
        return scheduleNextOccurrenceIfAbsent(
                medicationId,
                doseId,
                fromCalendarDate,
                timeHhmm,
                amount,
                generation);
    }
}
