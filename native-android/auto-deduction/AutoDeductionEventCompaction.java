package app.drugtracker.autodeduction;

import android.content.SharedPreferences;

import java.util.Map;
import java.util.Set;

/**
 * Terminal-state compaction for the Auto-Deduction event ledger (#489):
 * extracted from AutoDeductionEventStore so the store's state transitions
 * and this bounded retention sweep evolve independently.
 *
 * <p>RECONCILED rows are bounded by calendar date. REJECTED rows have no
 * trustworthy occurrence identity by design, so they use their durable
 * rejectedAt timestamp and a fixed retention window instead. Unresolved
 * FIRED evidence is never compacted here.</p>
 */
final class AutoDeductionEventCompaction {

    private AutoDeductionEventCompaction() {}

    /**
     * Compact terminal event rows while preserving unresolved FIRED evidence.
     *
     * <p>RECONCILED rows are bounded by calendar date. REJECTED rows have no
     * trustworthy occurrence identity by design, so they use their durable
     * rejectedAt timestamp and a fixed retention window instead.</p>
     */
    static AutoDeductionEventStore.CompactionResult compactTerminalEvents(
            AutoDeductionEventPersistence persistence,
            AutoDeductionFailurePolicy failurePolicy,
            String eventKeyPrefix,
            Object lock,
            String cutoffCalendarDate,
            Set<String> protectedOccurrenceKeys) {
        if (!AutoDeductionContract.isValidCalendarDate(cutoffCalendarDate)) {
            return AutoDeductionEventStore.CompactionResult.failure("invalid_cutoff", 0);
        }
        final long rejectedCutoffEpochMs =
                System.currentTimeMillis()
                        - (AutoDeductionContract.REJECTED_TERMINAL_RETENTION_DAYS
                        * 24L * 60L * 60L * 1000L);
        int removed = 0;
        synchronized (lock) {
            SharedPreferences.Editor editor = null;
            for (Map.Entry<String, ?> entry : persistence.getAllEvents().entrySet()) {
                if (!entry.getKey().startsWith(eventKeyPrefix)
                        || !(entry.getValue() instanceof String)) {
                    continue;
                }
                String raw = (String) entry.getValue();
                AutoDeductionPersistenceCodec.DecodeResult decoded =
                        AutoDeductionPersistenceCodec.decodeEvent(raw);

                if (AutoDeductionContract.STATUS_REJECTED.equals(decoded.status)) {
                    Long rejectedAt = AutoDeductionPersistenceCodec.rejectedAtEpochMs(raw);
                    // REJECTED is irrecoverable. Malformed REJECTED rows that
                    // lack a timestamp are therefore safe to discard on a compaction
                    // pass instead of becoming immortal terminal garbage.
                    if (rejectedAt == null || rejectedAt.longValue() < rejectedCutoffEpochMs) {
                        if (editor == null) editor = persistence.eventEditor();
                        editor.remove(entry.getKey());
                        removed++;
                    }
                    continue;
                }

                AutoDeductionPersistenceModels.EventRecord record = decoded.record;
                if (record == null
                        || !AutoDeductionContract.STATUS_RECONCILED.equals(record.status)
                        || record.occurrence == null
                        || record.occurrence.calendarDate.compareTo(cutoffCalendarDate) >= 0) {
                    continue;
                }
                String occurrenceKey = record.occurrence.canonicalKey();
                if (protectedOccurrenceKeys != null
                        && protectedOccurrenceKeys.contains(occurrenceKey)) {
                    continue;
                }
                if (editor == null) editor = persistence.eventEditor();
                editor.remove(entry.getKey());
                removed++;
            }
            if (editor != null) {
                if (!failurePolicy.allowTerminalStateCompactionCommit()
                        || !editor.commit()) {
                    return AutoDeductionEventStore.CompactionResult.failure(
                            "terminal_event_compaction_commit_failed",
                            removed);
                }
            }
        }
        return AutoDeductionEventStore.CompactionResult.success(removed);
    }
}
