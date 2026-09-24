package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Durable Auto successor-obligation store.
 *
 * <p>One record is created before a successfully completed fire returns to the
 * receiver. The record is cleared only after the successor chain is known to be
 * installed/terminally complete. Recovery can therefore resume after process
 * death without another scheduler or AlarmManager mechanism.</p>
 */
final class AutoSuccessorObligationStore {
    static final class ListResult {
        final boolean ok;
        final List<AutoDeductionPersistenceModels.SuccessorObligationRecord> obligations;
        final String error;

        private ListResult(
                boolean ok,
                List<AutoDeductionPersistenceModels.SuccessorObligationRecord> obligations,
                String error) {
            this.ok = ok;
            this.obligations = obligations;
            this.error = error;
        }

        static ListResult success(
                List<AutoDeductionPersistenceModels.SuccessorObligationRecord> obligations) {
            return new ListResult(true, obligations, null);
        }

        static ListResult failure(String error) {
            return new ListResult(false, new ArrayList<>(),
                    error == null || error.isEmpty()
                            ? "successor_obligation_read_failed"
                            : error);
        }
    }

    private final SharedPreferences prefs;

    AutoSuccessorObligationStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(
                AutoDeductionContract.PREFS_SUCCESSOR_OBLIGATIONS,
                Context.MODE_PRIVATE);
    }

    private static String key(
            AutoDeductionPersistenceModels.SuccessorObligationRecord record) {
        return AutoDeductionContract.SUCCESSOR_OBLIGATION_KEY_PREFIX
                + record.sourceOccurrence.canonicalKey();
    }

    private static String key(
            String medicationId,
            String doseId,
            String calendarDate) {
        return AutoDeductionContract.SUCCESSOR_OBLIGATION_KEY_PREFIX
                + AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, calendarDate);
    }

    /**
     * Synchronous commit (#493): the obligation is the crash-recovery journal
     * persisted before a fire reports success to the receiver — a lost record
     * would drop the successor chain after process death. The outcome drives
     * the caller's FAILED recovery result.
     */
    boolean save(
            AutoDeductionPersistenceModels.SuccessorObligationRecord record) {
        try {
            return prefs.edit()
                    .putString(
                            key(record),
                            AutoDeductionPersistenceCodec.encodeSuccessorObligation(record))
                    .commit();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Asynchronous cleanup (#493): invoked by callers only after the successor
     * chain is known to be installed or terminally complete, so a removal that
     * never lands (crash before the async write flushes) leaves an obligation
     * that the next recovery boundary re-processes idempotently — generation,
     * cancellation, ownership, and create-if-absent install guards all re-run
     * before anything is mutated. No outcome is reported because no caller
     * depends on the removal result.
     */
    void clear(
            String medicationId,
            String doseId,
            String calendarDate) {
        prefs.edit()
                .remove(key(medicationId, doseId, calendarDate))
                .apply();
    }

    boolean markStockApplied(
            String medicationId,
            String doseId,
            String calendarDate) {
        AutoDeductionPersistenceModels.SuccessorObligationRecord current =
                get(medicationId, doseId, calendarDate);
        if (current == null || current.stockApplied) {
            return current != null && current.stockApplied;
        }
        AutoDeductionPersistenceModels.SuccessorObligationRecord updated =
                new AutoDeductionPersistenceModels.SuccessorObligationRecord(
                        current.sourceOccurrence,
                        current.timeHhmm,
                        current.amount,
                        current.treatmentEndDate,
                        current.operationVersion,
                        current.recurrenceGeneration,
                        true,
                        current.createdAtEpochMs);
        try {
            // Synchronous commit (#493): the stockApplied marker is the
            // recovery-time guard against a second Native stock application
            // for the same obligation, and the outcome drives the caller's
            // FAILED recovery result — a lost marker could double-deduct
            // stock on the next recovery pass.
            return prefs.edit()
                    .putString(
                            key(updated),
                            AutoDeductionPersistenceCodec.encodeSuccessorObligation(updated))
                    .commit();
        } catch (Exception e) {
            return false;
        }
    }

    AutoDeductionPersistenceModels.SuccessorObligationRecord get(
            String medicationId,
            String doseId,
            String calendarDate) {
        String raw = prefs.getString(
                key(medicationId, doseId, calendarDate), null);
        if (raw == null) return null;
        try {
            return AutoDeductionPersistenceCodec.decodeSuccessorObligation(raw);
        } catch (Exception e) {
            return null;
        }
    }

    ListResult listAll() {
        List<AutoDeductionPersistenceModels.SuccessorObligationRecord> out =
                new ArrayList<>();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            String storageKey = entry.getKey();
            if (storageKey == null
                    || !storageKey.startsWith(
                            AutoDeductionContract.SUCCESSOR_OBLIGATION_KEY_PREFIX)) {
                continue;
            }

            Object rawValue = entry.getValue();
            String raw = rawValue instanceof String
                    ? (String) rawValue
                    : String.valueOf(rawValue);
            try {
                out.add(AutoDeductionPersistenceCodec.decodeSuccessorObligation(raw));
            } catch (Exception e) {
                // One malformed obligation must not poison recovery for every
                // medication. Preserve the raw diagnostic row under a separate
                // non-active prefix, then continue listing healthy obligations.
                if (!quarantineMalformed(storageKey, raw)) {
                    return ListResult.failure("successor_obligation_quarantine_failed");
                }
            }
        }
        return ListResult.success(out);
    }

    /**
     * Remove a malformed active obligation from the recovery set only after its
     * raw payload has been copied to a non-active diagnostic key. The quarantine
     * key is deterministic, so one bad source identity cannot grow diagnostics
     * without bound.
     */
    private boolean quarantineMalformed(String storageKey, String raw) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        String quarantineKey =
                AutoDeductionContract.SUCCESSOR_OBLIGATION_QUARANTINE_KEY_PREFIX
                        + storageKey.substring(
                                AutoDeductionContract.SUCCESSOR_OBLIGATION_KEY_PREFIX.length());
        try {
            return prefs.edit()
                    .remove(storageKey)
                    .putString(quarantineKey, raw == null ? "" : raw)
                    .commit();
        } catch (RuntimeException e) {
            return false;
        }
    }
}
