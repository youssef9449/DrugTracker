package app.drugtracker.autodeduction;

import java.util.Map;
import app.drugtracker.autodeduction.AutoDeductionScheduler.CancelResult;

/** Focused Auto-Deduction responsibility collaborator: AutoDeductionCancellation. */
final class AutoDeductionCancellation {
    private final AutoDeductionScheduler scheduler;

    AutoDeductionCancellation(AutoDeductionScheduler scheduler) {
        this.scheduler = scheduler;
    }

CancelResult cancelAllSchedulesForDoseLocked(
            String medicationId,
            String doseId) {
        Map<String, String> all = scheduler.getAllScheduleMetadata();
        if (all == null || all.isEmpty()) return CancelResult.success();

        java.util.List<AutoDeductionPersistenceModels.ScheduleRecord> toCancel =
                new java.util.ArrayList<>();
        for (Map.Entry<String, String> entry : all.entrySet()) {
            String storageKey = entry.getKey();
            String raw = entry.getValue();
            if (storageKey == null || storageKey.isEmpty()) continue;

            AutoDeductionPersistenceModels.ScheduleRecord schedule =
                    scheduler.schedulingAdapter().getScheduleRecord(storageKey);
            if (schedule == null) {
                if (!scheduler.quarantineMalformedScheduleMetadata(
                        storageKey, raw, "malformed_schedule_record")) {
                    return CancelResult.fail("schedule_metadata_removal_failed");
                }
                continue;
            }
            if (medicationId.equals(schedule.occurrence.medicationId)
                    && doseId.equals(schedule.occurrence.doseId)) {
                toCancel.add(schedule);
            }
        }

        java.util.List<AutoDeductionPersistenceModels.ScheduleRecord> canceled =
                new java.util.ArrayList<>();
        for (AutoDeductionPersistenceModels.ScheduleRecord schedule : toCancel) {
            AutoDeductionSchedulingAdapter.CancelResult result =
                    scheduler.schedulingAdapter().cancelOccurrence(
                            medicationId,
                            doseId,
                            schedule.occurrence.calendarDate);
            if (!result.isOk()) {
                // A failed cancel may already have written its tombstone or canceled
                // AlarmManager before failing metadata removal. Include the current
                // schedule in rollback; re-arming the same identity is idempotent.
                java.util.List<AutoDeductionPersistenceModels.ScheduleRecord> rollback =
                        new java.util.ArrayList<>(canceled);
                rollback.add(schedule);
                if (restoreSchedulesLocked(medicationId, doseId, rollback)) {
                    return CancelResult.fail(result.error);
                }
                return canceled.isEmpty()
                        ? CancelResult.fail(result.error + ";rollback_failed")
                        : CancelResult.failAfterPartialCancellation(
                                result.error + ";rollback_failed");
            }
            canceled.add(schedule);
        }
        return CancelResult.success();
    }

public CancelResult cancelOccurrence(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return CancelResult.fail("invalid_args");
        }
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (scheduler.scheduleLock()) {
            AutoDeductionSchedulingAdapter.CancelResult result =
                    scheduler.schedulingAdapter().cancelOccurrence(
                            medicationId,
                            doseId,
                            calendarDate);
            if (!result.isOk()) return CancelResult.fail(result.error);
            return result.status
                    == AutoDeductionSchedulingAdapter.CancelResult.Status.ALREADY_ABSENT
                    ? CancelResult.alreadyAbsent()
                    : CancelResult.success();
        }
    }

boolean hasCancellationTombstone(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (scheduler.scheduleLock()) {
            return scheduler.hasCancellationTombstoneStored(occurrenceKey);
        }
    }

public boolean isOccurrenceCancelled(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return false;
        }
        return isOccurrenceCancelledKey(
                AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, calendarDate));
    }

boolean isOccurrenceCancelledKey(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (scheduler.scheduleLock()) {
            return scheduler.isEffectivelyCancelledStored(occurrenceKey);
        }
    }

boolean clearCancellationTombstoneLocked(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        return scheduler.clearCancellationTombstoneStored(occurrenceKey);
    }
    private boolean restoreSchedulesLocked(
            String medicationId,
            String doseId,
            java.util.List<AutoDeductionPersistenceModels.ScheduleRecord> schedules) {
        boolean allRestored = true;
        for (AutoDeductionPersistenceModels.ScheduleRecord schedule : schedules) {
            Long epoch = schedule.scheduledAtEpochMs > 0L
                    ? Long.valueOf(schedule.scheduledAtEpochMs)
                    : AutoDeductionScheduler.computeEpochMs(
                            schedule.occurrence.calendarDate,
                            schedule.timeHhmm);
            if (epoch == null) {
                allRestored = false;
                continue;
            }
            long generation = scheduler.getRecurrenceGenerationLocked(
                    medicationId, doseId);
            if (generation <= 0L) {
                allRestored = false;
                continue;
            }
            AutoDeductionSchedulingAdapter.ScheduleResult restored =
                    scheduler.schedulingAdapter().scheduleOccurrence(
                            schedule.occurrence.canonicalKey(),
                            medicationId,
                            doseId,
                            schedule.occurrence.calendarDate,
                            schedule.timeHhmm,
                            schedule.amount,
                            epoch.longValue(),
                            schedule.treatmentEndDate.isEmpty()
                                    ? null
                                    : schedule.treatmentEndDate,
                            generation,
                            null);
            if (!restored.ok) {
                Log.e("AutoDeductionScheduler",
                        "cancel rollback failed for "
                                + schedule.occurrence.canonicalKey()
                                + ": " + restored.error);
                allRestored = false;
            }
        }
        return allRestored;
    }

}
