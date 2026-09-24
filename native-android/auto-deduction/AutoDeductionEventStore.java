package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Durable Auto-Deduction event ledger.
 *
 * <p>Responsibility split (#467): raw SharedPreferences access is isolated in
 * AutoDeductionEventPersistence, all JSON encoding/decoding is isolated in
 * AutoDeductionPersistenceCodec, and key-identity parsing / read-model
 * classification live in AutoDeductionEventQueries. Business state
 * transitions (insert-if-absent, pending-fire promotion, FIRED → RECONCILED,
 * fail-closed terminalization) and terminal-state compaction live here.</p>
 */
public final class AutoDeductionEventStore {

    private static final String TAG = "AutoDeductionEventStore";
    private static final String KEY_EVENT_PREFIX = "evt:";
    private static final String KEY_PENDING_PREFIX = "pend:";
    static final String KEY_PENDING_QUARANTINE_PREFIX = "quarantine:pend:";
    private static final Object LOCK = new Object();

    private final AutoDeductionEventPersistence persistence;
    private final AutoDeductionFailurePolicy failurePolicy;

    public AutoDeductionEventStore(Context context) {
        this(context, AutoDeductionFailurePolicy.ALLOW_ALL);
    }

    AutoDeductionEventStore(
            Context context,
            AutoDeductionFailurePolicy failurePolicy) {
        Context app = context.getApplicationContext();
        this.persistence = new AutoDeductionEventPersistence(
                app.getSharedPreferences(
                        AutoDeductionContract.PREFS_EVENTS, Context.MODE_PRIVATE),
                app.getSharedPreferences(
                        AutoDeductionContract.PREFS_PENDING, Context.MODE_PRIVATE));
        this.failurePolicy = failurePolicy == null
                ? AutoDeductionFailurePolicy.ALLOW_ALL
                : failurePolicy;
    }

    public static final class InsertFiredResult {
        public enum Status { CREATED, ALREADY_EXISTS, FAILED }

        public final Status status;
        public final boolean pendingRecorded;

        public InsertFiredResult(Status status) {
            this(status, false);
        }

        public InsertFiredResult(Status status, boolean pendingRecorded) {
            this.status = status;
            this.pendingRecorded = pendingRecorded;
        }

        public boolean isCreated() {
            return status == Status.CREATED;
        }

        public boolean isAlreadyExists() {
            return status == Status.ALREADY_EXISTS;
        }

        public boolean isFailed() {
            return status == Status.FAILED;
        }
    }

    public InsertFiredResult insertFiredIfAbsent(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w(TAG, "reject insert: invalid payload");
            return new InsertFiredResult(InsertFiredResult.Status.FAILED);
        }

        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        final String prefKey = KEY_EVENT_PREFIX + key;

        synchronized (LOCK) {
            if (persistence.containsEvent(prefKey)) {
                return new InsertFiredResult(
                        InsertFiredResult.Status.ALREADY_EXISTS);
            }

            try {
                AutoDeductionPersistenceModels.EventRecord record =
                        AutoDeductionPersistenceCodec.fired(
                                medicationId,
                                doseId,
                                calendarDate,
                                scheduledAtEpochMs,
                                amount,
                                System.currentTimeMillis());
                String payload =
                        AutoDeductionPersistenceCodec.encodeEventString(record);

                boolean written = commitEvent(prefKey, payload);
                if (!written) {
                    Log.w(TAG, "commit failed for key=" + key + "; retrying once");
                    written = commitEvent(prefKey, payload);
                }

                if (written) {
                    persistence.removePending(KEY_PENDING_PREFIX + key);
                    return new InsertFiredResult(
                            InsertFiredResult.Status.CREATED);
                }

                Log.e(TAG, "commit failed after retry for key=" + key);
                boolean pendingOk = failurePolicy.allowPendingFireCommit()
                        && persistence.putPending(
                                KEY_PENDING_PREFIX + key, payload);
                return new InsertFiredResult(
                        InsertFiredResult.Status.FAILED,
                        pendingOk);
            } catch (JSONException e) {
                Log.e(TAG, "event serialization failed", e);
                return new InsertFiredResult(InsertFiredResult.Status.FAILED);
            }
        }
    }

    public static final class PendingFiresResult {
        public final boolean ok;
        public final int promoted;
        public final String error;

        private PendingFiresResult(boolean ok, int promoted, String error) {
            this.ok = ok;
            this.promoted = promoted;
            this.error = error;
        }

        static PendingFiresResult success(int promoted) {
            return new PendingFiresResult(true, promoted, null);
        }

        static PendingFiresResult failure(int promoted, String error) {
            return new PendingFiresResult(
                    false,
                    promoted,
                    error != null && !error.isEmpty()
                            ? error
                            : "pending_promotion_failed");
        }
    }

    public PendingFiresResult promotePendingFiresResult() {
        int promoted = 0;
        boolean promotionFailed = false;
        synchronized (LOCK) {
            Map<String, ?> all = persistence.getAllPending();
            List<String> toRemove = new ArrayList<>();
            for (Map.Entry<String, ?> entry : all.entrySet()) {
                if (!entry.getKey().startsWith(KEY_PENDING_PREFIX)) continue;
                Object value = entry.getValue();
                if (!(value instanceof String)) {
                    if (!quarantineMalformedPendingLocked(
                            entry.getKey(),
                            value,
                            "invalid_pending_storage_type")) {
                        promotionFailed = true;
                    }
                    continue;
                }

                String raw = (String) value;
                try {
                    AutoDeductionPersistenceModels.EventRecord record =
                            AutoDeductionPersistenceCodec.fromPending(raw);
                    String key = record.occurrence.canonicalKey();
                    String expectedPendingKey = KEY_PENDING_PREFIX + key;
                    if (!entry.getKey().equals(expectedPendingKey)) {
                        if (!quarantineMalformedPendingLocked(
                                entry.getKey(),
                                raw,
                                "pending_identity_mismatch")) {
                            promotionFailed = true;
                        }
                        continue;
                    }
                    String eventKey = KEY_EVENT_PREFIX + key;

                    if (persistence.containsEvent(eventKey)) {
                        toRemove.add(entry.getKey());
                        promoted++;
                        continue;
                    }

                    AutoDeductionPersistenceModels.EventRecord fired =
                            record.withStatus(
                                    AutoDeductionContract.STATUS_FIRED,
                                    record.reconciledAtEpochMs,
                                    null,
                                    null);
                    String payload =
                            AutoDeductionPersistenceCodec.encodeEventString(fired);

                    boolean written = commitEvent(eventKey, payload);
                    if (!written) {
                        written = commitEvent(eventKey, payload);
                    }
                    if (written) {
                        toRemove.add(entry.getKey());
                        promoted++;
                    } else {
                        promotionFailed = true;
                        Log.e(TAG, "pending promotion failed for " + entry.getKey());
                    }
                } catch (JSONException e) {
                    if (!quarantineMalformedPendingLocked(
                            entry.getKey(),
                            raw,
                            "malformed_pending_record")) {
                        promotionFailed = true;
                    }
                }
            }

            if (!persistence.removePendingKeys(toRemove)) {
                Log.w(TAG, "pending-fire cleanup commit failed");
            }
        }

        return promotionFailed
                ? PendingFiresResult.failure(
                        promoted, "pending_promotion_failed")
                : PendingFiresResult.success(promoted);
    }

    /**
     * Preserve malformed crash-recovery evidence in a separate durable namespace.
     * The original live pending key is removed only in the same successful commit
     * that creates its quarantine record.
     */
    private boolean quarantineMalformedPendingLocked(
            String pendingKey,
            Object value,
            String reason) {
        if (!failurePolicy.allowPendingQuarantineCommit()) {
            Log.e(TAG, "pending quarantine commit blocked: " + pendingKey);
            return false;
        }
        try {
            JSONObject quarantine = new JSONObject();
            quarantine.put(
                    "status",
                    "QUARANTINED");
            quarantine.put(
                    "quarantinedAtEpochMs",
                    System.currentTimeMillis());
            quarantine.put(
                    "reason",
                    reason == null || reason.isEmpty()
                            ? "malformed_pending_record"
                            : reason);
            quarantine.put("originalKey", pendingKey);
            if (value instanceof String) {
                quarantine.put("raw", (String) value);
            } else {
                quarantine.put(
                        "rawType",
                        value == null
                                ? "null"
                                : value.getClass().getName());
                quarantine.put(
                        "rawValue",
                        String.valueOf(value));
            }

            String suffix = pendingKey.startsWith(KEY_PENDING_PREFIX)
                    ? pendingKey.substring(KEY_PENDING_PREFIX.length())
                    : pendingKey;
            SharedPreferences.Editor editor = persistence.pendingEditor();
            editor.putString(
                    KEY_PENDING_QUARANTINE_PREFIX + suffix,
                    quarantine.toString());
            editor.remove(pendingKey);
            return editor.commit();
        } catch (JSONException | RuntimeException e) {
            Log.e(TAG, "pending quarantine build failed: " + pendingKey, e);
            return false;
        }
    }

    public boolean hasEvent(
            String medicationId,
            String doseId,
            String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (LOCK) {
            return persistence.containsEvent(KEY_EVENT_PREFIX + key);
        }
    }

    public static final class EventLookupResult {
        public final boolean ok;
        /** Typed domain record consumed by native business/recovery code. */
        public final AutoDeductionPersistenceModels.EventRecord record;
        public final String error;

        private EventLookupResult(
                boolean ok,
                AutoDeductionPersistenceModels.EventRecord record,
                String error) {
            this.ok = ok;
            this.record = record;
            this.error = error;
        }

        static EventLookupResult found(
                AutoDeductionPersistenceModels.EventRecord record) {
            return new EventLookupResult(true, record, null);
        }

        public static EventLookupResult absent() {
            return new EventLookupResult(true, null, null);
        }

        public static EventLookupResult failure(String error) {
            return new EventLookupResult(
                    false,
                    null,
                    error != null && !error.isEmpty()
                            ? error
                            : "event_lookup_failed");
        }
    }



    /** Key-identity parsing delegated to the query/validation collaborator (#467). */
    private static AutoDeductionEventQueries.StorageIdentity parseStorageKeyIdentity(String prefKey) {
        return AutoDeductionEventQueries.parseStorageKeyIdentity(KEY_EVENT_PREFIX, prefKey);
    }

    private static boolean storageIdentityMatchesPayload(
            AutoDeductionEventQueries.StorageIdentity identity,
            AutoDeductionPersistenceModels.EventRecord record) {
        return AutoDeductionEventQueries.storageIdentityMatchesPayload(identity, record);
    }

    private EventLookupResult terminalizeRejectedLocked(
            String prefKey,
            String reason) {
        try {
            String rejected = AutoDeductionPersistenceCodec.encodeRejected(
                    prefKey,
                    reason,
                    System.currentTimeMillis());
            if (!commitEvent(prefKey, rejected)) {
                Log.e(TAG, "REJECTED terminalization commit failed for " + prefKey);
                return EventLookupResult.failure("rejected_persist_failed");
            }
            return EventLookupResult.absent();
        } catch (JSONException e) {
            return EventLookupResult.failure("rejected_persist_failed");
        }
    }

    public static final class MarkResult {
        public final boolean ok;
        public final boolean changed;

        public MarkResult(boolean ok, boolean changed) {
            this.ok = ok;
            this.changed = changed;
        }
    }

    public MarkResult markReconciled(
            String medicationId,
            String doseId,
            String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        String prefKey = KEY_EVENT_PREFIX + key;

        synchronized (LOCK) {
            String raw = persistence.getEvent(prefKey);
            if (raw == null) {
                return new MarkResult(false, false);
            }

            AutoDeductionPersistenceCodec.DecodeResult decoded =
                    AutoDeductionPersistenceCodec.decodeEvent(raw);
            if (AutoDeductionContract.STATUS_REJECTED.equals(decoded.status)) {
                return new MarkResult(true, false);
            }
            if (!decoded.isSuccess()) {
                if (decoded.status != null
                        && !decoded.status.isEmpty()
                        && !AutoDeductionContract.STATUS_REJECTED.equals(decoded.status)
                        && !AutoDeductionContract.STATUS_FIRED.equals(decoded.status)
                        && !AutoDeductionContract.STATUS_RECONCILED.equals(decoded.status)) {
                    // Unknown status is not a valid event transition target. Leave the
                    // row untouched so an explicit recovery/quarantine path can own it.
                    return new MarkResult(false, false);
                }
                if ("invalid_json".equals(decoded.error)) {
                    return new MarkResult(
                            terminalizeRejectedLocked(prefKey, "invalid_json").ok,
                            false);
                }
                return new MarkResult(
                        terminalizeRejectedLocked(
                                prefKey,
                                "malformed_fields").ok,
                        false);
            }

            AutoDeductionPersistenceModels.EventRecord record = decoded.record;
            if (AutoDeductionContract.STATUS_RECONCILED.equals(record.status)) {
                return new MarkResult(true, false);
            }
            if (!AutoDeductionContract.STATUS_FIRED.equals(record.status)) {
                return new MarkResult(false, false);
            }

            AutoDeductionEventQueries.StorageIdentity storageIdentity = parseStorageKeyIdentity(prefKey);
            if (!storageIdentityMatchesPayload(storageIdentity, record)) {
                String reason = storageIdentity != null
                        && !storageIdentity.medicationId.equals(record.occurrence.medicationId)
                        ? "identity_mismatch"
                        : "malformed_fields";
                EventLookupResult terminalized =
                        terminalizeRejectedLocked(prefKey, reason);
                return new MarkResult(terminalized.ok, false);
            }
            if (!medicationId.equals(record.occurrence.medicationId)
                    || !doseId.equals(record.occurrence.doseId)
                    || !calendarDate.equals(record.occurrence.calendarDate)) {
                EventLookupResult terminalized =
                        terminalizeRejectedLocked(prefKey, "malformed_fields");
                return new MarkResult(terminalized.ok, false);
            }

            AutoDeductionPersistenceModels.EventRecord reconciled =
                    record.withStatus(
                            AutoDeductionContract.STATUS_RECONCILED,
                            System.currentTimeMillis(),
                            null,
                            null);
            try {
                return new MarkResult(
                        commitEvent(
                                prefKey,
                                AutoDeductionPersistenceCodec.encodeEventString(
                                        reconciled)),
                        true);
            } catch (JSONException e) {
                return new MarkResult(false, false);
            }
        }
    }


    public static final class FiredEventsResult {
        public final boolean ok;
        /** Typed records consumed by native recovery/business code. */
        public final List<AutoDeductionPersistenceModels.EventRecord> records;
        public final String error;

        private FiredEventsResult(
                boolean ok,
                List<AutoDeductionPersistenceModels.EventRecord> records,
                String error) {
            this.ok = ok;
            this.records = records;
            this.error = error;
        }

        public static FiredEventsResult success(
                List<AutoDeductionPersistenceModels.EventRecord> records) {
            return new FiredEventsResult(true, records, null);
        }

        public static FiredEventsResult failure(String error) {
            return new FiredEventsResult(
                    false,
                    new ArrayList<>(),
                    error != null && !error.isEmpty()
                            ? error
                            : "fired_list_failed");
        }
    }

    public FiredEventsResult listFiredEventsResult() {
        PendingFiresResult promotion = promotePendingFiresResult();
        if (!promotion.ok) return FiredEventsResult.failure(promotion.error);

        List<AutoDeductionPersistenceModels.EventRecord> firedRecords = new ArrayList<>();
        synchronized (LOCK) {
            SharedPreferences.Editor editor = null;
            boolean needsTerminalization = false;

            for (Map.Entry<String, ?> entry : persistence.getAllEvents().entrySet()) {
                if (!entry.getKey().startsWith(KEY_EVENT_PREFIX)
                        || !(entry.getValue() instanceof String)) {
                    continue;
                }

                String prefKey = entry.getKey();
                String raw = (String) entry.getValue();
                AutoDeductionPersistenceCodec.DecodeResult decoded =
                        AutoDeductionPersistenceCodec.decodeEvent(raw);

                // Read-model classification lives in the query collaborator
                // (#467): this loop only consumes its verdict and owns the
                // fail-closed terminalization write for non-FIRED rows.
                AutoDeductionEventQueries.FiredRowClassification classification =
                        AutoDeductionEventQueries.classifyFiredRow(
                                decoded,
                                raw,
                                parseStorageKeyIdentity(prefKey));
                if (classification.isFired()) {
                    firedRecords.add(classification.firedRecord);
                    continue;
                }
                if (classification.rejectionReason == null) {
                    // REJECTED / RECONCILED terminal rows are left untouched.
                    continue;
                }

                String rejected = AutoDeductionPersistenceCodec.encodeRejected(
                        prefKey,
                        classification.rejectionReason,
                        System.currentTimeMillis());
                if (editor == null) editor = persistence.eventEditor();
                editor.putString(prefKey, rejected);
                needsTerminalization = true;
            }

            if (needsTerminalization && !commitEditor(editor)) {
                return FiredEventsResult.failure("rejected_persist_failed");
            }
        }

        return FiredEventsResult.success(firedRecords);
    }


    public static final class CompactionResult {
        public final boolean ok;
        public final int removed;
        public final String error;

        private CompactionResult(boolean ok, int removed, String error) {
            this.ok = ok;
            this.removed = removed;
            this.error = error;
        }

        static CompactionResult success(int removed) {
            return new CompactionResult(true, removed, null);
        }

        static CompactionResult failure(String error, int removed) {
            return new CompactionResult(
                    false,
                    removed,
                    error != null && !error.isEmpty()
                            ? error
                            : "terminal_event_compaction_failed");
        }
    }

    /**
     * Compact terminal event rows while preserving unresolved FIRED evidence.
     *
     * <p>RECONCILED rows are bounded by calendar date. REJECTED rows have no
     * trustworthy occurrence identity by design, so they use their durable
     * rejectedAt timestamp and a fixed retention window instead.</p>
     */
    public CompactionResult compactTerminalEvents(
            String cutoffCalendarDate,
            java.util.Set<String> protectedOccurrenceKeys) {
        if (!AutoDeductionContract.isValidCalendarDate(cutoffCalendarDate)) {
            return CompactionResult.failure("invalid_cutoff", 0);
        }
        final long rejectedCutoffEpochMs =
                System.currentTimeMillis()
                        - (AutoDeductionContract.REJECTED_TERMINAL_RETENTION_DAYS
                        * 24L * 60L * 60L * 1000L);
        int removed = 0;
        synchronized (LOCK) {
            SharedPreferences.Editor editor = null;
            for (Map.Entry<String, ?> entry : persistence.getAllEvents().entrySet()) {
                if (!entry.getKey().startsWith(KEY_EVENT_PREFIX)
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
                    return CompactionResult.failure(
                            "terminal_event_compaction_commit_failed",
                            removed);
                }
            }
        }
        return CompactionResult.success(removed);
    }

    public EventLookupResult getFiredUnreconciledEvent(
            String medicationId,
            String doseId,
            String calendarDate) {
        PendingFiresResult promotion = promotePendingFiresResult();
        if (!promotion.ok) return EventLookupResult.failure(promotion.error);

        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        String prefKey = KEY_EVENT_PREFIX + key;

        synchronized (LOCK) {
            String raw = persistence.getEvent(prefKey);
            if (raw == null) return EventLookupResult.absent();

            AutoDeductionPersistenceCodec.DecodeResult decoded =
                    AutoDeductionPersistenceCodec.decodeEvent(raw);
            if (AutoDeductionContract.STATUS_REJECTED.equals(decoded.status)) {
                return EventLookupResult.absent();
            }
            if (!decoded.isSuccess()) {
                if (decoded.status != null
                        && !decoded.status.isEmpty()
                        && !AutoDeductionContract.STATUS_FIRED.equals(decoded.status)
                        && !AutoDeductionContract.STATUS_RECONCILED.equals(decoded.status)) {
                    return EventLookupResult.absent();
                }
                return terminalizeRejectedLocked(
                        prefKey,
                        "invalid_json".equals(decoded.error)
                                ? "invalid_json"
                                : "malformed_fields");
            }

            AutoDeductionPersistenceModels.EventRecord record = decoded.record;
            if (!AutoDeductionContract.STATUS_FIRED.equals(record.status)) {
                return EventLookupResult.absent();
            }

            AutoDeductionEventQueries.StorageIdentity storageIdentity = parseStorageKeyIdentity(prefKey);
            if (!storageIdentityMatchesPayload(storageIdentity, record)) {
                String reason = storageIdentity != null
                        && !storageIdentity.medicationId.equals(record.occurrence.medicationId)
                        ? "identity_mismatch"
                        : "malformed_fields";
                return terminalizeRejectedLocked(prefKey, reason);
            }
            if (!medicationId.equals(record.occurrence.medicationId)
                    || !doseId.equals(record.occurrence.doseId)
                    || !calendarDate.equals(record.occurrence.calendarDate)) {
                return terminalizeRejectedLocked(prefKey, "malformed_fields");
            }

            return EventLookupResult.found(record);
        }
    }

    private boolean commitEditor(SharedPreferences.Editor editor) {
        return editor != null
                && failurePolicy.allowEventCommit()
                && editor.commit();
    }

    private boolean commitEvent(String key, String value) {
        return failurePolicy.allowEventCommit()
                && persistence.putEvent(key, value);
    }

}
