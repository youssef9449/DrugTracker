package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Durable Auto fire-retry evidence persistence boundary.
 * JSON is handled only by the persistence codec; callers consume typed records.
 */
final class AutoDeductionRetryEvidenceStore {
    private static final String KEY_PREFIX = "fretry:";
    private final SharedPreferences prefs;

    AutoDeductionRetryEvidenceStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(
                AutoDeductionContract.PREFS_FIRE_RETRY, Context.MODE_PRIVATE);
    }

    AutoDeductionPersistenceModels.RetryEvidenceRecord get(
            String medicationId,
            String doseId,
            String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        String raw = prefs.getString(KEY_PREFIX + key, null);
        if (raw == null || raw.isEmpty()) return null;
        try {
            return AutoDeductionPersistenceCodec.decodeRetryEvidence(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Synchronous commit (#493): the evidence record is the crash-recovery
     * proof that a fire delivery reached the Auto boundary, so it must be
     * durably written before the caller schedules the retry that depends on
     * it; the outcome drives the retry-scheduling decision.
     */
    boolean save(
            AutoDeductionPersistenceModels.RetryEvidenceRecord record,
            AutoDeductionFailurePolicy failurePolicy) {
        if (record == null) return false;
        try {
            String payload = AutoDeductionPersistenceCodec.encodeRetryEvidence(record);
            return failurePolicy.allowFireRetryEvidenceCommit()
                    && prefs.edit().putString(
                            KEY_PREFIX + record.occurrence.canonicalKey(),
                            payload).commit();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Asynchronous cleanup (#493): invoked only after the occurrence's
     * completion is already durably recorded (FIRED row / idempotency marker /
     * successor chain), so the evidence is redundant. No outcome is reported:
     * a record that survives a crash is re-processed idempotently by recovery
     * (ownership/generation guards plus the occurrence-level idempotency
     * markers) and re-cleaned there.
     */
    void clear(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return;
        String key = KEY_PREFIX + occurrenceKey;
        if (!prefs.contains(key)) return;
        prefs.edit().remove(key).apply();
    }

    static final class ListResult {
        final boolean ok;
        final List<AutoDeductionPersistenceModels.RetryEvidenceRecord> records;
        final String error;

        private ListResult(
                boolean ok,
                List<AutoDeductionPersistenceModels.RetryEvidenceRecord> records,
                String error) {
            this.ok = ok;
            this.records = records;
            this.error = error;
        }

        static ListResult success(List<AutoDeductionPersistenceModels.RetryEvidenceRecord> records) {
            return new ListResult(true, records, null);
        }

        static ListResult failure(String error) {
            return new ListResult(false, new ArrayList<>(),
                    error == null ? "retry_evidence_list_failed" : error);
        }
    }

    ListResult listAll() {
        List<AutoDeductionPersistenceModels.RetryEvidenceRecord> out =
                new ArrayList<>();
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            if (!entry.getKey().startsWith(KEY_PREFIX)) continue;
            if (!(entry.getValue() instanceof String)) {
                return ListResult.failure("retry_evidence_type_invalid");
            }
            try {
                out.add(AutoDeductionPersistenceCodec.decodeRetryEvidence(
                        (String) entry.getValue()));
            } catch (Exception e) {
                // Never treat malformed durable evidence as successful absence.
                return ListResult.failure("retry_evidence_invalid");
            }
        }
        return ListResult.success(out);
    }
}
