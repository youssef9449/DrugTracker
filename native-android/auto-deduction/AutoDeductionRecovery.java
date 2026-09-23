package app.drugtracker.autodeduction;

import android.content.Context;
import android.util.Log;
import org.json.JSONException;
import java.util.Map;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import app.drugtracker.autodeduction.AutoDeductionScheduler.CatchUpResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.RestoreResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.FireResult;
import app.drugtracker.autodeduction.AutoDeductionScheduler.ScheduleResult;

/** Focused Auto-Deduction responsibility collaborator: AutoDeductionRecovery. */
final class AutoDeductionRecovery {
    private static final class ScheduleStorageIdentity {
        final String medicationId;
        final String doseId;
        final String calendarDate;

        ScheduleStorageIdentity(
                String medicationId,
                String doseId,
                String calendarDate) {
            this.medicationId = medicationId;
            this.doseId = doseId;
            this.calendarDate = calendarDate;
        }
    }

    private static ScheduleStorageIdentity parseScheduleStorageKey(
            String prefKey) {
        if (prefKey == null || prefKey.isEmpty()) return null;
        String encoded = prefKey.startsWith("sch:")
                ? prefKey.substring(4)
                : prefKey;
        final char separator = '';
        int first = encoded.indexOf(separator);
        int second = first < 0
                ? -1
                : encoded.indexOf(separator, first + 1);
        if (first <= 0 || second <= first + 1
                || second >= encoded.length() - 1
                || encoded.indexOf(separator, second + 1) >= 0) {
            return null;
        }
        String medicationId = encoded.substring(0, first);
        String doseId = encoded.substring(first + 1, second);
        String date = encoded.substring(second + 1);
        if (!AutoDeductionContract.isValidCalendarDate(date)) return null;
        return new ScheduleStorageIdentity(medicationId, doseId, date);
    }

    private static final class ScheduleSnapshot {
        final String prefKey;
        final String raw;
        final AutoDeductionPersistenceModels.ScheduleRecord record;
        final String observedVersion;

        ScheduleSnapshot(
                String prefKey,
                String raw,
                AutoDeductionPersistenceModels.ScheduleRecord record,
                String observedVersion) {
            this.prefKey = prefKey;
            this.raw = raw;
            this.record = record;
            this.observedVersion = observedVersion;
        }
    }

    private final AutoDeductionScheduler scheduler;

    AutoDeductionRecovery(AutoDeductionScheduler scheduler) {
        this.scheduler = scheduler;
    }

CatchUpResult catchUpMissedOccurrencesAndScheduleNext(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount,
            long expectedRecurrenceGeneration,
            String pastPrefKey,
            String observedVersion
    ) {
        if (medicationId == null || doseId == null || fromCalendarDate == null
                || timeHhmm == null) {
            return new CatchUpResult(0, false);
        }
        synchronized (scheduler.scheduleLock()) {
            if (!scheduler.isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                Log.i("AutoDeductionScheduler", "catchUp: generation unauthorized — dropping snapshot "
                        + pastPrefKey);
                scheduler.removeScheduleMetadataIfVersionLocked(pastPrefKey, observedVersion);
                return new CatchUpResult(0, false);
            }
        }
        final long nowMs = scheduler.recoveryNowForService();
        String treatmentEndDate = "";
        synchronized (scheduler.scheduleLock()) {
            AutoDeductionPersistenceModels.ScheduleRecord current =
                    scheduler.schedulingAdapter().getScheduleRecord(pastPrefKey);
            String raw = scheduler.schedulingAdapter().getScheduleRaw(pastPrefKey);
            if (raw != null && !raw.isEmpty()) {
                if (current == null) {
                    return new CatchUpResult(0, false, true);
                }
                treatmentEndDate = current.treatmentEndDate;
            }
        }
        if (!treatmentEndDate.isEmpty()
                && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
            return new CatchUpResult(0, false, true);
        }
        String walkDate = fromCalendarDate;
        int created = 0;
        boolean futureInstalled = false;
        boolean preserveSnapshotForRetry = false;
        while (walkDate != null) {
            if (!treatmentEndDate.isEmpty()
                    && walkDate.compareTo(treatmentEndDate) > 0) {
                break;
            }
            Long epoch = AutoDeductionScheduler.computeEpochMs(walkDate, timeHhmm);
            if (epoch == null) {
                preserveSnapshotForRetry = true;
                break;
            }
            if (epoch > nowMs) {
                // First future occurrence — gen check + install under one scheduler.scheduleLock().
                ScheduleResult sr = scheduler.installFutureSuccessorIfGenerationHolds(
                        medicationId, doseId, walkDate, timeHhmm, amount,
                        epoch, expectedRecurrenceGeneration,
                        pastPrefKey, observedVersion, treatmentEndDate);
                if (!sr.ok) {
                    if ("recurrence_generation_unauthorized".equals(sr.error)
                            || "snapshot_stale".equals(sr.error)) {
                        Log.i("AutoDeductionScheduler", "catchUp: future install rejected (" + sr.error + ")");
                    } else {
                        Log.w("AutoDeductionScheduler", "catchUp: future schedule failed (" + sr.error
                                + ") for " + medicationId + "/" + doseId + "/" + walkDate);
                        preserveSnapshotForRetry = true;
                    }
                } else if (sr.error == null) {
                    // Newly installed AlarmManager schedule for the first future date.
                    futureInstalled = true;
                    Log.i("AutoDeductionScheduler", "catchUp: scheduled next future "
                            + medicationId + "/" + doseId + "/" + walkDate);
                } else {
                    Log.i("AutoDeductionScheduler", "catchUp: future successor skipped (" + sr.error + ") for "
                            + medicationId + "/" + doseId + "/" + walkDate);
                }
                break;
            }
            FireResult fr = scheduler.recoverMissedOccurrence(
                    medicationId, doseId, walkDate, epoch, amount,
                    expectedRecurrenceGeneration,
                    treatmentEndDate,
                    timeHhmm);
            if (fr.isCancelled()) {
                synchronized (scheduler.scheduleLock()) {
                    if (!scheduler.isRecurrenceGenerationAuthorizedLocked(
                            medicationId, doseId, expectedRecurrenceGeneration)) {
                        Log.i("AutoDeductionScheduler", "catchUp: generation invalidated mid-walk — stop");
                        scheduler.removeScheduleMetadataIfVersionLocked(pastPrefKey, observedVersion);
                        return new CatchUpResult(created, false);
                    }
                }
                walkDate = AutoDeductionScheduler.nextCalendarDate(walkDate);
                continue;
            }
            if (fr.status == FireResult.Status.CREATED) {
                created++;
            }
            if (!fr.allowsRecurrence()) {
                Log.e("AutoDeductionScheduler", "catchUp: FIRED persistence failed for "
                        + medicationId + "/" + doseId + "/" + walkDate
                        + " — preserving snapshot for retry");
                preserveSnapshotForRetry = true;
                break;
            }
            walkDate = AutoDeductionScheduler.nextCalendarDate(walkDate);
        }
        if (!preserveSnapshotForRetry) {
            if (!scheduler.removeScheduleMetadataIfVersion(pastPrefKey, observedVersion)) {
                Log.i("AutoDeductionScheduler", "catchUp: past metadata already gone/replaced: " + pastPrefKey);
            }
        }
        return new CatchUpResult(created, futureInstalled, preserveSnapshotForRetry);
    }

void continueRecurrenceAfterPastRecovery(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            FireResult fr,
            String prefKey,
            String observedVersion
    ) {
        if (fr == null) {
            return;
        }
        if (fr.isCancelled()) {
            if (!scheduler.removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                Log.i("AutoDeductionScheduler", "restore past cancel cleanup skipped (ownership lost): " + prefKey);
            }
            return;
        }
        if (!fr.allowsRecurrence()) {
            // FAILED with no durable fire/pending — keep schedule metadata.
            Log.e("AutoDeductionScheduler", "restore past: FIRED and pending both failed for "
                    + medicationId + "/" + doseId + "/" + calendarDate
                    + " — preserving schedule metadata as recovery source");
            return;
        }
        // Durable fire accepted → establish successor only if snapshot still owns D.
        ScheduleResult next = scheduler.scheduleNextOccurrenceIfSnapshotOwnsPast(
                medicationId, doseId, calendarDate, timeHhmm, amount, prefKey, observedVersion);
        if (!next.ok) {
            if ("snapshot_stale".equals(next.error)) {
                Log.i("AutoDeductionScheduler", "restore past: snapshot stale — not scheduling successor from "
                        + "obsolete params: " + medicationId + "/" + doseId + "/" + calendarDate);
                // Do not remove newer D metadata; do not overwrite D+1.
                return;
            }
            Log.w("AutoDeductionScheduler", "restore past: successor not scheduled (" + next.error
                    + ") — keeping past metadata for retry: "
                    + medicationId + "/" + doseId + "/" + calendarDate);
            return;
        }
        Log.i("AutoDeductionScheduler", "restore past: recurrence continued to next occurrence for "
                + medicationId + "/" + doseId + "/" + calendarDate
                + " (fire=" + fr.status + ", pendingRecorded=" + fr.pendingRecorded + ")");
        if (!scheduler.removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
            Log.i("AutoDeductionScheduler", "restore past metadata keep (ownership lost / already gone): " + prefKey);
        }
    }

RestoreResult recoverFiredStockPass() {
        AutoDeductionStockStore stock = new AutoDeductionStockStore(scheduler.appContext());
        // Native stock has no safe baseline until the current JS state has
        // seeded the Native authority. Defer recovery until that initialization
        // boundary is complete.
        if (!stock.isInitialized()) {
            Log.i("AutoDeductionScheduler", "recoverFiredStockPass: Native stock not initialized — defer to JS hydration");
            return RestoreResult.success(0, 0);
        }
        AutoDeductionEventStore store = scheduler.eventStore();
        AutoDeductionEventStore.FiredEventsResult listed = store.listFiredEventsResult();
        if (!listed.ok) {
            return RestoreResult.failure(
                    0, 1,
                    listed.error != null ? listed.error : "fired_stock_list_failed");
        }
        int recovered = 0;
        int failed = 0;
        for (AutoDeductionPersistenceModels.EventRecord event : listed.records) {
            String medicationId = event.occurrence.medicationId;
            String doseId = event.occurrence.doseId;
            String calendarDate = event.occurrence.calendarDate;
            double amount = event.amount;
            if (medicationId.isEmpty()
                    || doseId.isEmpty()
                    || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                    || !AutoDeductionContract.isValidAmount(amount)) {
                failed++;
                continue;
            }
            // A durable FIRED row is itself the last-resort recovery journal if
            // process death happened before the dedicated successor obligation was
            // persisted. Reconstruct that obligation only from the CURRENT schedule
            // definition and generation; never reuse stale receiver payload.
            AutoDeductionPersistenceModels.ScheduleRecord current =
                    scheduler.schedulingAdapter().getScheduleRecord(
                            AutoDeductionContract.occurrenceKey(
                                    medicationId, doseId, calendarDate));
            if (current != null
                    && Double.compare(current.amount, amount) == 0) {
                long generation = scheduler.getRecurrenceGenerationLocked(
                        medicationId, doseId);
                if (scheduler.isRecurrenceGenerationAuthorizedLocked(
                        medicationId, doseId, generation)) {
                    boolean journalReady = scheduler.persistSuccessorObligation(
                            medicationId,
                            doseId,
                            calendarDate,
                            current.timeHhmm,
                            amount,
                            current.treatmentEndDate,
                            current.operationVersion,
                            generation);
                    if (!journalReady) {
                        failed++;
                        Log.e("AutoDeductionScheduler",
                                "recoverFiredStockPass: successor journal persistence failed for "
                                        + medicationId + "/" + doseId + "/" + calendarDate);
                    }
                }
            }

            AutoDeductionStockStore.AutoApplyResult stockResult =
                    stock.applyAutoDeductionForRecovery(
                            medicationId, doseId, calendarDate, amount);
            if (stockResult.ok) {
                recovered++;
                AutoDeductionPersistenceModels.SuccessorObligationRecord obligation =
                        scheduler.successorObligationStore().get(
                                medicationId, doseId, calendarDate);
                if (obligation != null
                        && !obligation.stockApplied
                        && !scheduler.markSuccessorObligationStockApplied(
                                medicationId, doseId, calendarDate)) {
                    failed++;
                    Log.e("AutoDeductionScheduler",
                            "recoverFiredStockPass: successor journal update failed for "
                                    + medicationId + "/" + doseId + "/" + calendarDate);
                }
            } else {
                failed++;
                Log.e("AutoDeductionScheduler", "recoverFiredStockPass: native stock apply failed for "
                        + medicationId + "/" + doseId + "/" + calendarDate
                        + " — " + stockResult.error);
            }
        }
        if (failed > 0) {
            return RestoreResult.failure(recovered, failed, "fired_stock_pass_failed");
        }
        return RestoreResult.success(recovered, 0);
    }

RestoreResult recoverIndependentFireRetryEvidencePass() {
        if (!new AutoDeductionStockStore(scheduler.appContext()).isInitialized()) {
            Log.i("AutoDeductionScheduler",
                    "independent evidence pass: Native stock not initialized — defer to JS hydration");
            return RestoreResult.success(0, 0);
        }

        AutoDeductionRetryEvidenceStore.ListResult listed =
                scheduler.retryEvidenceStore().listAll();
        if (!listed.ok) {
            return RestoreResult.failure(0, 1, listed.error);
        }

        int recovered = 0;
        int failed = 0;
        for (AutoDeductionPersistenceModels.RetryEvidenceRecord evidence : listed.records) {
            String medId = evidence.occurrence.medicationId;
            String doseId = evidence.occurrence.doseId;
            String date = evidence.occurrence.calendarDate;

            FireResult fr = scheduler.recoverFireFromIndependentEvidence(
                    medId, doseId, date);
            if (fr.allowsRecurrence()) {
                recovered++;
                continue;
            }
            if (fr.status == FireResult.Status.CANCELLED) {
                continue;
            }

            if (evidence.retryCount >= AutoDeductionContract.MAX_FIRE_RETRIES) {
                failed++;
                Log.e("AutoDeductionScheduler",
                        "independent evidence unresolved after MAX_FIRE_RETRIES for "
                                + medId + "/" + doseId + "/" + date);
                continue;
            }

            boolean retryOk = scheduler.scheduleFireRetry(
                    medId,
                    doseId,
                    date,
                    evidence.scheduledAtEpochMs,
                    evidence.amount,
                    evidence.timeHhmm,
                    evidence.recurrenceGeneration,
                    evidence.operationVersion,
                    Math.min(
                            evidence.retryCount + 1,
                            AutoDeductionContract.MAX_FIRE_RETRIES));
            if (!retryOk) {
                failed++;
                Log.e("AutoDeductionScheduler",
                        "independent evidence retry schedule failed for "
                                + medId + "/" + doseId + "/" + date);
            }
        }

        return failed > 0
                ? RestoreResult.failure(
                        recovered, failed, "independent_evidence_pass_failed")
                : RestoreResult.success(recovered, 0);
    }

public RestoreResult restoreFutureSchedules() {
        if (!scheduler.canScheduleExactAlarms()) {
            Log.w("AutoDeductionScheduler", "restoreFutureSchedules: exact alarm permission denied");
            // Still attempt past-schedule promotion to FIRED.
        }
        int restored = 0;
        int failed = 0;
        boolean boundaryOk = true;
        boolean successorObligationsOk = scheduler.recoverSuccessorObligations();
        if (!successorObligationsOk) {
            failed++;
            boundaryOk = false;
        }
        if (!scheduler.failurePolicy().allowRestoreFutureSchedules()) {
            return RestoreResult.failure(0, 0, "forced_restore_failure");
        }
        List<ScheduleSnapshot> snapshot = new ArrayList<>();
        synchronized (scheduler.scheduleLock()) {
            Map<String, String> all = scheduler.getAllScheduleMetadata();
            for (Map.Entry<String, String> e : all.entrySet()) {
                AutoDeductionPersistenceModels.ScheduleRecord record = null;
                String observedVersion = "";
                try {
                    record = AutoDeductionPersistenceCodec.decodeSchedule(e.getValue());
                    observedVersion = record.operationVersion;
                } catch (JSONException ignored) {
                    // Keep raw row so the recovery pass can quarantine it fail-closed.
                }
                snapshot.add(new ScheduleSnapshot(
                        e.getKey(), e.getValue(), record, observedVersion));
            }
        }
        for (ScheduleSnapshot entry : snapshot) {
            String prefKey = entry.prefKey;
            String raw = entry.raw;
            String observedVersion = entry.observedVersion;
            AutoDeductionPersistenceModels.ScheduleRecord record = entry.record;
            if (record == null) {
                String reason = "malformed_fields";
                if (!quarantineMalformedScheduleMetadata(
                        prefKey, raw, reason)) {
                    Log.e("AutoDeductionScheduler",
                            "restore: malformed schedule quarantine failed for " + prefKey);
                    failed++;
                    boundaryOk = false;
                }
                continue;
            }

            String medId = record.occurrence.medicationId;
            String doseId = record.occurrence.doseId;
            String date = record.occurrence.calendarDate;
            String time = record.timeHhmm;
            double amount = record.amount;
            long epoch = record.scheduledAtEpochMs;
            String treatmentEndDate = record.treatmentEndDate;
            if (!AutoDeductionContract.isValidCalendarDate(date)
                    || !AutoDeductionContract.isValidTimeHhmm(time)
                    || !AutoDeductionContract.isValidAmount(amount)
                    || !AutoDeductionContract.isValidCalendarDate(date)
                    || record.operationVersion.isEmpty()) {
                if (!quarantineMalformedScheduleMetadata(
                        prefKey, raw, "malformed_fields")) {
                    failed++;
                    boundaryOk = false;
                }
                continue;
            }
            ScheduleStorageIdentity keyIdentity = parseScheduleStorageKey(prefKey);
            boolean keyMatchesPayload =
                    keyIdentity != null
                    && keyIdentity.medicationId.equals(medId)
                    && keyIdentity.doseId.equals(doseId)
                    && keyIdentity.calendarDate.equals(date);
            if (!keyMatchesPayload) {
                if (!quarantineMalformedScheduleMetadata(
                        prefKey, raw, "identity_mismatch")) {
                    Log.e("AutoDeductionScheduler",
                            "restore: malformed schedule quarantine failed for " + prefKey);
                    failed++;
                    boundaryOk = false;
                }
                continue;
            }
            String occurrenceKey = AutoDeductionContract.occurrenceKey(medId, doseId, date);
                if (!treatmentEndDate.isEmpty()
                        && date.compareTo(treatmentEndDate) > 0) {
                    synchronized (scheduler.scheduleLock()) {
                        if (!scheduler.schedulingAdapter()
                                .isScheduleOwnedByOperationVersion(prefKey, observedVersion)) {
                            continue;
                        }
                        AutoDeductionSchedulingAdapter.CancelResult cancel =
                                scheduler.schedulingAdapter().cancelOccurrence(medId, doseId, date);
                        if (!cancel.isOk()) {
                            failed++;
                            boundaryOk = false;
                        }
                    }
                    continue;
                }
                if (epoch <= 0) {
                    Long computed = AutoDeductionScheduler.computeEpochMs(date, time);
                    if (computed == null) {
                        // Unrecoverable epoch — cleanup; ownership_lost is not failure.
                        if (!scheduler.removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                            Log.i("AutoDeductionScheduler", "restore: epoch-null cleanup ownership_lost/gone: " + prefKey);
                        }
                        // Cannot prove recovery of a valid schedule — leave as resolved via drop.
                        continue;
                    }
                    epoch = computed;
                }
                // multi-day catch-up — every due occurrence from this
                // snapshot date forward is recovered as FIRED (no horizon); the first
                // not-yet-due date becomes the live AlarmManager schedule.
                if (epoch <= scheduler.recoveryNowForService()) {
                    if (!new AutoDeductionStockStore(scheduler.appContext()).isInitialized()) {
                        Log.i("AutoDeductionScheduler", "restore: past occurrence deferred until Native stock is initialized: "
                                + prefKey);
                        continue;
                    }
                    long snapGen;
                    synchronized (scheduler.scheduleLock()) {
                        snapGen = scheduler.getRecurrenceGenerationLocked(medId, doseId);
                    }
                    CatchUpResult catchUp = catchUpMissedOccurrencesAndScheduleNext(
                            medId, doseId, date, time, amount, snapGen,
                            prefKey, observedVersion);
                    // restored counts future AlarmManager installs only (not FIRED rows).
                    if (catchUp.futureInstalled) {
                        restored++;
                    }
                    if (catchUp.incomplete) {
                        Log.e("AutoDeductionScheduler", "restore: catch-up incomplete for " + prefKey);
                        failed++;
                        boundaryOk = false;
                    }
                    continue;
                }
                // Future: effectively cancelled → never reinstall; drop stale metadata.
                // A newer schedule metadata supersedes a leftover tombstone so legitimate
                // reschedule is not suppressed.
                if (scheduler.isOccurrenceCancelledKey(occurrenceKey)) {
                    Log.i("AutoDeductionScheduler", "restore skip (cancelled): " + medId + "/" + doseId + "/" + date);
                    // Prior cancellation is expected; ownership_lost on cleanup is not failure.
                    if (!scheduler.removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                        Log.i("AutoDeductionScheduler", "restore future cancel cleanup skipped (ownership lost): "
                                + prefKey);
                    }
                    continue;
                }
                // Leftover tombstone under a superseding schedule: best-effort cleanup.
                if (scheduler.hasCancellationTombstone(occurrenceKey)) {
                    synchronized (scheduler.scheduleLock()) {
                        scheduler.clearCancellationTombstoneLocked(occurrenceKey);
                    }
                }
                if (!scheduler.canScheduleExactAlarms()) {
                    // Future schedule requires AlarmManager — cannot complete recovery.
                    Log.w("AutoDeductionScheduler", "restore: exact alarm permission denied for future " + prefKey);
                    failed++;
                    boundaryOk = false;
                    continue;
                }
                // Rebuild epoch from calendarDate + timeHhmm in the *current* default
                // timezone so a TIMEZONE_CHANGED restore does not reinstall a stale epoch.
                Long recomputed = AutoDeductionScheduler.computeEpochMs(date, time);
                if (recomputed == null) {
                    if (!scheduler.removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                        Log.i("AutoDeductionScheduler", "restore: recompute-null cleanup ownership_lost: " + prefKey);
                    }
                    continue;
                }
                if (recomputed <= scheduler.recoveryNowForService()) {
                    // After TZ change this occurrence is now in the past: multi-day catch-up.
                    if (!new AutoDeductionStockStore(scheduler.appContext()).isInitialized()) {
                        Log.i("AutoDeductionScheduler", "restore: TZ past occurrence deferred until Native stock is initialized: "
                                + prefKey);
                        continue;
                    }
                    long snapGenTz;
                    synchronized (scheduler.scheduleLock()) {
                        snapGenTz = scheduler.getRecurrenceGenerationLocked(medId, doseId);
                    }
                    CatchUpResult catchUp = catchUpMissedOccurrencesAndScheduleNext(
                            medId, doseId, date, time, amount, snapGenTz,
                            prefKey, observedVersion);
                    if (catchUp.futureInstalled) {
                        restored++;
                    }
                    if (catchUp.incomplete) {
                        Log.e("AutoDeductionScheduler", "restore: TZ catch-up incomplete for " + prefKey);
                        failed++;
                        boundaryOk = false;
                    }
                    continue;
                }
                epoch = recomputed;
                // Future: atomic ownership check + schedule under one lock.
                // operationVersion is assigned inside scheduleOccurrenceLocked (under
                // scheduler.scheduleLock()) so ordering vs concurrent cancel is correct.
                String key = occurrenceKey;
                AutoDeductionPersistenceModels.ScheduleRecord restoredRecord =
                        new AutoDeductionPersistenceModels.ScheduleRecord(
                                new AutoDeductionPersistenceModels.OccurrenceId(
                                        medId, doseId, date),
                                time,
                                amount,
                                epoch,
                                treatmentEndDate,
                                "");
                synchronized (scheduler.scheduleLock()) {
                    // drop future schedules whose generation was invalidated.
                    long metaGen = scheduler.getRecurrenceGenerationLocked(medId, doseId);
                    if (metaGen > 0L
                            && !scheduler.isRecurrenceGenerationAuthorizedLocked(medId, doseId, metaGen)) {
                        Log.i("AutoDeductionScheduler", "restore skip (recurrence generation invalid): " + prefKey);
                        // Dropping invalidated generation is expected; ownership_lost ok.
                        scheduler.removeScheduleMetadataIfVersionLocked(prefKey, observedVersion);
                        continue;
                    }
                    ScheduleResult r = scheduler.scheduleOccurrenceLocked(
                            prefKey, restoredRecord, observedVersion);
                    if (r.ok) {
                        restored++;
                    } else if ("ownership_lost".equals(r.error)) {
                        // Canceled or replaced after snapshot — expected concurrent outcome.
                        Log.i("AutoDeductionScheduler", "restore skip (ownership lost): " + prefKey);
                    } else {
                        Log.w("AutoDeductionScheduler", "restore schedule failed for " + prefKey + ": " + r.error);
                        failed++;
                        boundaryOk = false;
                    }
                }
            }
        // Also recover independent fire-retry evidence (may exist without shared schedule rows).
        RestoreResult retryPass = recoverIndependentFireRetryEvidencePass();
        restored += retryPass.restored;
        failed += retryPass.failed;
        if (!retryPass.ok) {
            boundaryOk = false;
        }
        if (!scheduler.compactTerminalState()) {
            Log.e("AutoDeductionScheduler",
                    "restore: terminal-state compaction incomplete");
            failed++;
            boundaryOk = false;
        }
        if (!boundaryOk || failed > 0) {
            return RestoreResult.failure(restored, failed,
                    "restore_boundary_incomplete");
        }
        return RestoreResult.success(restored, failed);
    }

boolean quarantineMalformedScheduleMetadata(
            String prefKey,
            String expectedRaw,
            String reason
    ) {
        synchronized (scheduler.scheduleLock()) {
            String currentRaw = scheduler.schedulingAdapter().getScheduleRaw(prefKey);
            if (currentRaw == null) return true;
            if (expectedRaw != null && !expectedRaw.equals(currentRaw)) return true;
            ScheduleStorageIdentity identity = parseScheduleStorageKey(prefKey);
            if (identity == null) return false;
            String occurrenceKey = AutoDeductionContract.occurrenceKey(
                    identity.medicationId,
                    identity.doseId,
                    identity.calendarDate);
                        AutoDeductionSchedulingAdapter.CancelResult result =
                    scheduler.schedulingAdapter().cancelOccurrence(
                            identity.medicationId,
                            identity.doseId,
                            identity.calendarDate);
            if (!result.isOk()) return false;
            Log.w("AutoDeductionScheduler", "quarantined malformed schedule metadata: " + prefKey
                    + " reason=" + reason);
            return true;
        }
    }

public List<AutoDeductionPersistenceModels.ScheduledOccurrenceRecord>
        listScheduledOccurrences() {
        List<AutoDeductionPersistenceModels.ScheduledOccurrenceRecord> out =
                new ArrayList<>();
        synchronized (scheduler.scheduleLock()) {
            Map<String, String> all = scheduler.getAllScheduleMetadata();
            for (Map.Entry<String, String> e : all.entrySet()) {
                try {
                    AutoDeductionPersistenceModels.ScheduleRecord record =
                            AutoDeductionPersistenceCodec.decodeSchedule(e.getValue());
                    AutoDeductionPersistenceModels.RetryEvidenceRecord retry =
                            scheduler.retryEvidenceStore().get(
                                    record.occurrence.medicationId,
                                    record.occurrence.doseId,
                                    record.occurrence.calendarDate);
                    out.add(new AutoDeductionPersistenceModels.ScheduledOccurrenceRecord(
                            record,
                            retry == null ? 0 : retry.retryCount));
                } catch (JSONException ex) {
                    if (!quarantineMalformedScheduleMetadata(
                            e.getKey(), e.getValue(), "invalid_schedule_record")) {
                        throw new IllegalStateException(
                                "malformed_schedule_metadata_cleanup_failed");
                    }
                }
            }
        }
        return out;
    }
}
