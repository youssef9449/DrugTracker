package app.drugtracker.autodeduction;

import android.content.Context;
import android.util.Log;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

/**
 * Owns the Auto occurrence-state read model and bounded terminal-state compaction.
 * It deliberately does not own AlarmManager mechanics or Auto business recurrence.
 */
final class AutoDeductionOccurrenceState {
    private static final String TAG = "AutoDeductionOccurrenceState";

    interface Host {
        Context appContext();
        Map<String, String> getAllScheduleMetadata();
        AutoDeductionEventStore eventStore();
        AutoDeductionRetryEvidenceStore retryEvidenceStore();
        AutoSuccessorObligationStore successorObligationStore();
        AutoDeductionFailurePolicy failurePolicy();
        boolean isOccurrenceCancelledKey(String occurrenceKey);
        AutoDeductionSchedulingAdapter schedulingAdapter();
    }

    private final Host host;
    private final Context appContext;

    AutoDeductionOccurrenceState(Host host) {
        this.host = host;
        this.appContext = host.appContext();
    }

    boolean compactTerminalState() {
        String cutoff = terminalOccurrenceCutoffDate();

        synchronized (AutoDeductionScheduler.class) {
            Set<String> protectedKeys = new HashSet<String>();
            Map<String, String> schedules =
                    host.getAllScheduleMetadata();
            for (String rawKey : schedules.keySet()) {
                if (rawKey == null || rawKey.isEmpty()) continue;
                String key = rawKey.startsWith("sch:")
                        ? rawKey.substring(4)
                        : rawKey;
                if (!key.isEmpty()) protectedKeys.add(key);
            }

            // A Native marker must remain until every independent recovery source
            // for the same occurrence is terminal. Otherwise a late FIRED/retry/
            // successor recovery could lose its idempotency marker and deduct twice.
            AutoDeductionEventStore.FiredEventsResult fired =
                    host.eventStore().listFiredEventsResult();
            if (!fired.ok) {
                Log.w(TAG, "cannot compact terminal state: fired-event snapshot failed: "
                        + fired.error);
                return false;
            }
            for (AutoDeductionPersistenceModels.EventRecord event : fired.records) {
                if (event != null && event.occurrence != null) {
                    protectedKeys.add(event.occurrence.canonicalKey());
                }
            }

            AutoDeductionRetryEvidenceStore.ListResult retry =
                    host.retryEvidenceStore().listAll();
            if (!retry.ok) {
                Log.w(TAG, "cannot compact terminal state: retry-evidence snapshot failed: "
                        + retry.error);
                return false;
            }
            for (AutoDeductionPersistenceModels.RetryEvidenceRecord record : retry.records) {
                if (record != null && record.occurrence != null) {
                    protectedKeys.add(record.occurrence.canonicalKey());
                }
            }

            AutoSuccessorObligationStore.ListResult obligations =
                    host.successorObligationStore().listAll();
            if (!obligations.ok) {
                Log.w(TAG, "cannot compact terminal state: successor-obligation snapshot failed: "
                        + obligations.error);
                return false;
            }
            for (AutoDeductionPersistenceModels.SuccessorObligationRecord record
                    : obligations.obligations) {
                if (record != null && record.sourceOccurrence != null) {
                    protectedKeys.add(record.sourceOccurrence.canonicalKey());
                }
            }

            try {
                AutoDeductionEventStore.CompactionResult events =
                        host.eventStore().compactTerminalEvents(
                                cutoff, protectedKeys);
                AutoDeductionStockStore.CompactionResult markers =
                        new AutoDeductionStockStore(
                                appContext,
                                host.failurePolicy())
                                .compactTerminalOccurrenceMarkers(
                                        cutoff, protectedKeys);
                if (!events.ok) {
                    Log.w(TAG, "terminal event compaction failed: " + events.error);
                }
                if (!markers.ok) {
                    Log.w(TAG, "terminal marker compaction failed: " + markers.error);
                }
                return events.ok && markers.ok;
            } catch (RuntimeException e) {
                Log.w(TAG, "terminal-state compaction failed", e);
                return false;
            }
        }
    }

    AutoDeductionScheduler.OccurrenceSnapshot getOccurrenceSnapshot(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return new AutoDeductionScheduler.OccurrenceSnapshot(
                    AutoDeductionScheduler.OccurrenceSnapshot.Status.ABSENT,
                    null);
        }

        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);

        synchronized (AutoDeductionScheduler.class) {
            AutoDeductionEventStore.EventLookupResult firedLookup =
                    host.eventStore().getFiredUnreconciledEvent(
                            medicationId, doseId, calendarDate);
            if (!firedLookup.ok) {
                return AutoDeductionScheduler.OccurrenceSnapshot.failure(
                        firedLookup.error);
            }

            AutoDeductionPersistenceModels.EventRecord fired =
                    firedLookup.record;
            if (fired != null) {
                if (AutoDeductionContract.isValidAmount(fired.amount)) {
                    return new AutoDeductionScheduler.OccurrenceSnapshot(
                            AutoDeductionScheduler.OccurrenceSnapshot.Status.FIRED,
                            fired.amount);
                }
                return AutoDeductionScheduler.OccurrenceSnapshot.failure(
                        "invalid_fired_amount");
            }

            if (host.isOccurrenceCancelledKey(key)) {
                return new AutoDeductionScheduler.OccurrenceSnapshot(
                        AutoDeductionScheduler.OccurrenceSnapshot.Status.CANCELLED,
                        null);
            }

            AutoDeductionPersistenceModels.ScheduleRecord schedule =
                    host.schedulingAdapter().getScheduleRecord(key);
            if (schedule != null) {
                return new AutoDeductionScheduler.OccurrenceSnapshot(
                        AutoDeductionScheduler.OccurrenceSnapshot.Status.SCHEDULED,
                        AutoDeductionContract.isValidAmount(schedule.amount)
                                ? schedule.amount
                                : null);
            }

            return new AutoDeductionScheduler.OccurrenceSnapshot(
                    AutoDeductionScheduler.OccurrenceSnapshot.Status.ABSENT,
                    null);
        }
    }

    private static String terminalOccurrenceCutoffDate() {
        Calendar cal = Calendar.getInstance(
                TimeZone.getDefault(),
                Locale.US);
        cal.add(
                Calendar.DAY_OF_MONTH,
                -AutoDeductionContract.TERMINAL_OCCURRENCE_MAX_AGE_DAYS);
        return String.format(
                Locale.US,
                "%04d-%02d-%02d",
                cal.get(Calendar.YEAR),
                cal.get(Calendar.MONTH) + 1,
                cal.get(Calendar.DAY_OF_MONTH));
    }
}
