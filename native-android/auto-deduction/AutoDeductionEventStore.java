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
 * Durable native auto-deduction event ledger (SharedPreferences).
 *
 * Idempotency: at most one event per occurrence key
 * (medicationId + doseId + calendarDate).
 *
 * insert-if-absent is protected by a process-wide static lock so that
 * two different EventStore instances (e.g. two receiver deliveries)
 * still serialize the check+write and cannot both insert the same key.
 *
 * When primary FIRED commit fails, a pending-fire record is written to an
 * independent SharedPreferences file so the exact occurrence remains
 * recoverable. promotePendingFires() later inserts FIRED (idempotent) and
 * clears the pending record.
 *
 * Does NOT mutate stock, React state, or localStorage.
 */
public final class AutoDeductionEventStore {

    private static final String TAG = "AutoDeductionEventStore";
    private static final String KEY_EVENT_PREFIX = "evt:";
    private static final String KEY_PENDING_PREFIX = "pend:";

    /**
     * Process-wide lock shared by every EventStore instance.
     * Instance fields cannot serialize concurrent receiver deliveries.
     */
    private static final Object LOCK = new Object();

    /**
     * Test-only seam: when non-null, overrides SharedPreferences.Editor.commit()
     * results for REJECTED terminalization paths. Production leaves this null.
     */
    static volatile Boolean testForceCommitResult = null;

    /** @hide test-only */
    static void __setTestForceCommitResult(Boolean result) {
        testForceCommitResult = result;
    }

    private final SharedPreferences prefs;
    private final SharedPreferences pendingPrefs;

    public AutoDeductionEventStore(Context context) {
        Context app = context.getApplicationContext();
        this.prefs = app.getSharedPreferences(
                AutoDeductionContract.PREFS_EVENTS, Context.MODE_PRIVATE);
        this.pendingPrefs = app.getSharedPreferences(
                AutoDeductionContract.PREFS_PENDING, Context.MODE_PRIVATE);
    }

    /**
     * Result of an insertFiredIfAbsent attempt.
     * <ul>
     *   <li>{@link Status#CREATED} — event did not exist and was durably committed</li>
     *   <li>{@link Status#ALREADY_EXISTS} — event already present for the occurrence identity</li>
     *   <li>{@link Status#FAILED} — could not confirm durable insertion (invalid payload,
     *       JSON failure, or SharedPreferences commit failure). Never treated as duplicate.
     *       When FAILED due to commit, a pending-fire record may still have been written
     *       for later promotion.</li>
     * </ul>
     */
    public static final class InsertFiredResult {
        public enum Status {
            CREATED,
            ALREADY_EXISTS,
            FAILED
        }

        public final Status status;
        /** True if a pending-fire record was durably written after primary failure. */
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

    /**
     * Insert a FIRED event if and only if no event exists for the key.
     *
     * Distinguishes CREATED / ALREADY_EXISTS / FAILED so a persistence failure
     * is never silently treated as a duplicate fire.
     *
     * On primary commit failure: one immediate retry, then a best-effort write
     * of a pending-fire record to the independent pending prefs file.
     *
     * Thread-safe across instances: check + durable write under {@link #LOCK}.
     */
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

        final String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        final String prefKey = KEY_EVENT_PREFIX + key;

        synchronized (LOCK) {
            if (prefs.contains(prefKey)) {
                return new InsertFiredResult(InsertFiredResult.Status.ALREADY_EXISTS);
            }
            long now = System.currentTimeMillis();
            JSONObject obj = new JSONObject();
            try {
                obj.put("medicationId", medicationId);
                obj.put("doseId", doseId);
                obj.put("calendarDate", calendarDate);
                obj.put("scheduledAtEpochMs", scheduledAtEpochMs);
                obj.put("amount", amount);
                obj.put("status", AutoDeductionContract.STATUS_FIRED);
                obj.put("createdAtEpochMs", now);
                obj.put("reconciledAtEpochMs", JSONObject.NULL);
            } catch (JSONException e) {
                Log.e(TAG, "JSON build failed", e);
                return new InsertFiredResult(InsertFiredResult.Status.FAILED);
            }
            String payload = obj.toString();

            // Primary commit with one immediate retry.
            boolean written = prefs.edit().putString(prefKey, payload).commit();
            if (!written) {
                Log.w(TAG, "commit failed for key=" + key + "; retrying once");
                written = prefs.edit().putString(prefKey, payload).commit();
            }
            if (written) {
                // Clear any stale pending for this key.
                pendingPrefs.edit().remove(KEY_PENDING_PREFIX + key).commit();
                return new InsertFiredResult(InsertFiredResult.Status.CREATED);
            }

            Log.e(TAG, "commit failed after retry for key=" + key);
            // Best-effort durable pending record in independent prefs.
            boolean pendingOk = writePendingLocked(key, payload);
            return new InsertFiredResult(InsertFiredResult.Status.FAILED, pendingOk);
        }
    }

    private boolean writePendingLocked(String occurrenceKey, String eventJson) {
        String pendKey = KEY_PENDING_PREFIX + occurrenceKey;
        boolean ok = pendingPrefs.edit().putString(pendKey, eventJson).commit();
        if (!ok) {
            Log.e(TAG, "pending-fire commit also failed for " + occurrenceKey);
        } else {
            Log.i(TAG, "pending-fire recorded for recovery: " + occurrenceKey);
        }
        return ok;
    }

    /**
     * Result of promoting pending-fire records into the main FIRED ledger.
     *
     * ok=false means at least one valid pending occurrence could not be made
     * visible in the main FIRED ledger. Callers that use the FIRED ledger as an
     * authoritative stock input must fail closed rather than treating that
     * occurrence as ABSENT/SCHEDULED.
     */
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
                    error != null && !error.isEmpty() ? error : "pending_promotion_failed");
        }
    }

    /**
     * Promote any pending-fire records into the main FIRED ledger (idempotent).
     * Safe to call from boot, listEvents, or any recovery path.
     *
     * A valid pending occurrence that cannot be durably promoted is a real
     * lookup failure, not an ordinary empty result. The pending record remains
     * retryable until promotion succeeds.
     */
    public PendingFiresResult promotePendingFiresResult() {
        int promoted = 0;
        boolean promotionFailed = false;
        synchronized (LOCK) {
            Map<String, ?> all = pendingPrefs.getAll();
            List<String> toRemove = new ArrayList<>();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                if (!e.getKey().startsWith(KEY_PENDING_PREFIX)) continue;
                Object v = e.getValue();
                if (!(v instanceof String)) {
                    toRemove.add(e.getKey());
                    continue;
                }
                String raw = (String) v;
                try {
                    JSONObject obj = new JSONObject(raw);
                    String medId = obj.optString("medicationId", "");
                    String doseId = obj.optString("doseId", "");
                    String date = obj.optString("calendarDate", "");
                    if (medId.isEmpty() || doseId.isEmpty()
                            || !AutoDeductionContract.isValidCalendarDate(date)
                            || !AutoDeductionContract.isValidAmount(
                                    obj.optDouble("amount", Double.NaN))) {
                        toRemove.add(e.getKey());
                        continue;
                    }

                    String eventKey = KEY_EVENT_PREFIX
                            + AutoDeductionContract.occurrenceKey(medId, doseId, date);
                    if (prefs.contains(eventKey)) {
                        // Already FIRED/RECONCILED — drop pending.
                        toRemove.add(e.getKey());
                        promoted++;
                        continue;
                    }

                    // Ensure status FIRED.
                    obj.put("status", AutoDeductionContract.STATUS_FIRED);
                    if (!obj.has("createdAtEpochMs")) {
                        obj.put("createdAtEpochMs", System.currentTimeMillis());
                    }
                    if (!obj.has("reconciledAtEpochMs")) {
                        obj.put("reconciledAtEpochMs", JSONObject.NULL);
                    }
                    String payload = obj.toString();
                    boolean written = commitEditor(
                            prefs.edit().putString(eventKey, payload));
                    if (!written) {
                        written = commitEditor(
                                prefs.edit().putString(eventKey, payload));
                    }
                    if (written) {
                        toRemove.add(e.getKey());
                        promoted++;
                        Log.i(TAG, "promoted pending-fire to FIRED: " + medId + "/" + doseId + "/" + date);
                    } else {
                        // Keep the pending-fire record for a later retry. Do not
                        // allow callers to fall through to the JS/SCHEDULED amount.
                        promotionFailed = true;
                        Log.e(TAG, "promote pending commit failed for " + e.getKey());
                    }
                } catch (JSONException ex) {
                    Log.e(TAG, "promote pending parse failed", ex);
                    // Invalid pending records cannot safely represent a FIRED
                    // occurrence; terminal cleanup is safe.
                    toRemove.add(e.getKey());
                }
            }
            if (!toRemove.isEmpty()) {
                SharedPreferences.Editor ed = pendingPrefs.edit();
                for (String k : toRemove) {
                    ed.remove(k);
                }
                if (!ed.commit()) {
                    // Cleanup failure does not invalidate already-promoted FIRED
                    // rows, so keep the result authoritative.
                    Log.w(TAG, "pending-fire cleanup commit failed");
                }
            }
        }
        return promotionFailed
                ? PendingFiresResult.failure(promoted, "pending_promotion_failed")
                : PendingFiresResult.success(promoted);
    }


    public boolean hasEvent(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (LOCK) {
            return prefs.contains(KEY_EVENT_PREFIX + key);
        }
    }

    /**
     * Explicit result for a FIRED occurrence lookup.
     *
     * ok=true + event=null means the FIRED occurrence is not available to the
     * caller (absent, already terminal, or successfully terminalized during
     * this lookup). ok=false means the lookup could not safely establish that
     * fact because a required terminal persistence operation failed.
     */
    public static final class EventLookupResult {
        public final boolean ok;
        public final JSONObject event;
        public final String error;

        private EventLookupResult(boolean ok, JSONObject event, String error) {
            this.ok = ok;
            this.event = event;
            this.error = error;
        }

        public static EventLookupResult found(JSONObject event) {
            return new EventLookupResult(true, event, null);
        }

        public static EventLookupResult absent() {
            return new EventLookupResult(true, null, null);
        }

        public static EventLookupResult failure(String error) {
            return new EventLookupResult(
                    false,
                    null,
                    error != null && !error.isEmpty() ? error : "event_lookup_failed");
        }
    }

    /** Parsed medicationId + doseId + calendarDate from an evt: storage key. */
    private static final class StorageIdentity {
        final String medicationId;
        final String doseId;
        final String calendarDate;

        StorageIdentity(String medicationId, String doseId, String calendarDate) {
            this.medicationId = medicationId;
            this.doseId = doseId;
            this.calendarDate = calendarDate;
        }
    }

    /** Must match the separator used by AutoDeductionContract.occurrenceKey(). */
    private static final char OCCURRENCE_KEY_SEPARATOR = '\u001f';

    /**
     * Parse the exact identity encoded in an evt: storage key.
     * Returns null when the key cannot represent exactly one canonical
     * medicationId + doseId + calendarDate occurrence.
     */
    private static StorageIdentity parseStorageKeyIdentity(String prefKey) {
        if (prefKey == null || !prefKey.startsWith(KEY_EVENT_PREFIX)) {
            return null;
        }
        String encoded = prefKey.substring(KEY_EVENT_PREFIX.length());
        int first = encoded.indexOf(OCCURRENCE_KEY_SEPARATOR);
        int second = first >= 0
                ? encoded.indexOf(OCCURRENCE_KEY_SEPARATOR, first + 1)
                : -1;
        if (first <= 0 || second <= first + 1 || second >= encoded.length() - 1) {
            return null;
        }
        if (encoded.indexOf(OCCURRENCE_KEY_SEPARATOR, second + 1) >= 0) {
            return null;
        }
        return new StorageIdentity(
                encoded.substring(0, first),
                encoded.substring(first + 1, second),
                encoded.substring(second + 1));
    }

    private static boolean storageIdentityMatchesPayload(
            StorageIdentity identity,
            JSONObject o
    ) {
        if (identity == null || o == null) return false;
        String medId = o.optString("medicationId", "");
        String doseId = o.optString("doseId", "");
        String calendarDate = o.optString("calendarDate", "");
        if (medId.trim().isEmpty() || doseId.trim().isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate.trim())) {
            return false;
        }
        return identity.medicationId.equals(medId)
                && identity.doseId.equals(doseId)
                && identity.calendarDate.equals(calendarDate);
    }

    /**
     * Terminalize one malformed FIRED row while EventStore.LOCK is held.
     * A failed commit is a lookup FAILURE, never an ordinary ABSENT result.
     */
    private EventLookupResult terminalizeFiredRowLocked(
            String prefKey,
            JSONObject row,
            String rejectionReason
    ) {
        try {
            row.put("status", AutoDeductionContract.STATUS_REJECTED);
            row.put("rejectedAt", System.currentTimeMillis());
            row.put("rejectionReason", rejectionReason);
            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(prefKey, row.toString());
            if (!commitEditor(editor)) {
                Log.e(TAG, "REJECTED terminalization commit failed for " + prefKey);
                return EventLookupResult.failure("rejected_persist_failed");
            }
            return EventLookupResult.absent();
        } catch (JSONException e) {
            Log.e(TAG, "failed to terminalize FIRED row: " + prefKey, e);
            return EventLookupResult.failure("rejected_persist_failed");
        }
    }

    private EventLookupResult terminalizeInvalidJsonLocked(String prefKey) {
        try {
            JSONObject rejected = new JSONObject();
            rejected.put("status", AutoDeductionContract.STATUS_REJECTED);
            rejected.put("rejectedAt", System.currentTimeMillis());
            rejected.put("rejectionReason", "invalid_json");
            rejected.put("storageKey", prefKey);
            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(prefKey, rejected.toString());
            if (!commitEditor(editor)) {
                Log.e(TAG, "REJECTED terminalization commit failed for " + prefKey);
                return EventLookupResult.failure("rejected_persist_failed");
            }
            return EventLookupResult.absent();
        } catch (JSONException e) {
            Log.e(TAG, "failed to build REJECTED record for invalid JSON: " + prefKey, e);
            return EventLookupResult.failure("rejected_persist_failed");
        }
    }

    /**
     * Result of an acknowledgement attempt.
     * <ul>
     *   <li>{@code ok=true, changed=true} — FIRED → RECONCILED transition succeeded</li>
     *   <li>{@code ok=true, changed=false} — already terminal (RECONCILED or
     *       REJECTED), or a corrupt FIRED row was terminalized REJECTED instead
     *       of being acknowledged (terminal success, no retry)</li>
     *   <li>{@code ok=false, changed=false} — real failure (missing, unexpected
     *       status, parse/terminalization, or commit); remains retryable</li>
     * </ul>
     */
    public static final class MarkResult {
        public final boolean ok;
        public final boolean changed;

        public MarkResult(boolean ok, boolean changed) {
            this.ok = ok;
            this.changed = changed;
        }
    }

    /**
     * Mark an existing FIRED event as RECONCILED.
     * Returns explicit ok/changed so callers can distinguish success, already-terminal,
     * and real acknowledgement failure without treating a resolved call as success.
     */
    public MarkResult markReconciled(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = KEY_EVENT_PREFIX + key;
        synchronized (LOCK) {
            String raw = prefs.getString(prefKey, null);
            if (raw == null) {
                // Missing event: cannot establish RECONCILED; treat as failure so JS retries.
                return new MarkResult(false, false);
            }
            try {
                JSONObject obj = new JSONObject(raw);
                String status = obj.optString("status", "");
                if (AutoDeductionContract.STATUS_RECONCILED.equals(status)) {
                    return new MarkResult(true, false);
                }
                if (AutoDeductionContract.STATUS_REJECTED.equals(status)) {
                    // Already terminal via a REJECTED decision. Never resurrect a
                    // rejected occurrence into RECONCILED through the ack path.
                    return new MarkResult(true, false);
                }
                // Identity/status hardening (mirrors the read paths): only a
                // well-formed FIRED row whose payload matches its storage key may
                // be acknowledged as RECONCILED. A corrupt FIRED row is
                // terminalized REJECTED here instead of being blessed; it will
                // not be listed as FIRED again, so callers converge without an
                // ack retry loop.
                if (!AutoDeductionContract.STATUS_FIRED.equals(status)) {
                    Log.w(TAG, "markReconciled refused: unexpected status for " + key);
                    return new MarkResult(false, false);
                }
                boolean identityMatches = storageIdentityMatchesPayload(
                        parseStorageKeyIdentity(prefKey), obj);
                boolean malformed = isMalformedFired(obj);
                if (!identityMatches || malformed) {
                    String reason = malformed ? "malformed_fields" : "identity_mismatch";
                    EventLookupResult terminalized =
                            terminalizeFiredRowLocked(prefKey, obj, reason);
                    if (!terminalized.ok) {
                        return new MarkResult(false, false);
                    }
                    return new MarkResult(true, false);
                }
                obj.put("status", AutoDeductionContract.STATUS_RECONCILED);
                obj.put("reconciledAtEpochMs", System.currentTimeMillis());
                boolean committed = prefs.edit().putString(prefKey, obj.toString()).commit();
                if (committed) {
                    return new MarkResult(true, true);
                }
                Log.e(TAG, "markReconciled commit failed for " + key);
                return new MarkResult(false, false);
            } catch (JSONException e) {
                Log.e(TAG, "markReconciled parse failed", e);
                // Invalid JSON can never be acknowledged. Terminalize REJECTED
                // like the read paths do; if that persistence also fails, the
                // result stays retryable.
                EventLookupResult terminalized = terminalizeInvalidJsonLocked(prefKey);
                if (!terminalized.ok) {
                    return new MarkResult(false, false);
                }
                return new MarkResult(true, false);
            }
        }
    }

    /** List all events (FIRED and RECONCILED) as JSON objects. Promotes pending first. */
    public List<JSONObject> listEvents() {
        promotePendingFires();
        List<JSONObject> out = new ArrayList<>();
        synchronized (LOCK) {
            Map<String, ?> all = prefs.getAll();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                if (!e.getKey().startsWith(KEY_EVENT_PREFIX)) continue;
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                try {
                    out.add(new JSONObject((String) v));
                } catch (JSONException ignored) {
                }
            }
        }
        return out;
    }

    /** Explicit result for bulk FIRED-event listing.
     * ok=false means native could not safely establish the terminal state.
     * In that case events is empty and JS must fail closed rather than treating
     * the result as a successful empty snapshot. */
    public static final class FiredEventsResult {
        public final boolean ok;
        public final List<JSONObject> events;
        public final String error;

        private FiredEventsResult(boolean ok, List<JSONObject> events, String error) {
            this.ok = ok;
            this.events = events;
            this.error = error;
        }

        public static FiredEventsResult success(List<JSONObject> events) {
            return new FiredEventsResult(true, events, null);
        }

        public static FiredEventsResult failure(String error) {
            return new FiredEventsResult(false, new ArrayList<>(),
                    error != null && !error.isEmpty() ? error : "fired_list_failed");
        }
    }

    /**
     * List only FIRED (unreconciled) events. Malformed rows are terminalized
     * as REJECTED before the snapshot is exposed to JS.
     */
    public FiredEventsResult listFiredEventsResult() {
        PendingFiresResult promotion = promotePendingFiresResult();
        if (!promotion.ok) {
            return FiredEventsResult.failure(promotion.error);
        }
        List<JSONObject> fired = new ArrayList<>();
        synchronized (LOCK) {
            Map<String, ?> all = prefs.getAll();
            SharedPreferences.Editor editor = null;
            boolean needsTerminalization = false;
            for (Map.Entry<String, ?> e : all.entrySet()) {
                if (!e.getKey().startsWith(KEY_EVENT_PREFIX)) continue;
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                try {
                    JSONObject o = new JSONObject((String) v);
                    String status = o.optString("status", "");
                    if (!AutoDeductionContract.STATUS_FIRED.equals(status)) continue;

                    boolean malformed = isMalformedFired(o);
                    StorageIdentity storageIdentity = parseStorageKeyIdentity(e.getKey());
                    boolean identityMismatch = !storageIdentityMatchesPayload(storageIdentity, o);
                    if (malformed || identityMismatch) {
                        o.put("status", AutoDeductionContract.STATUS_REJECTED);
                        o.put("rejectedAt", System.currentTimeMillis());
                        o.put("rejectionReason",
                                malformed ? "malformed_fields" : "identity_mismatch");
                        if (editor == null) editor = prefs.edit();
                        editor.putString(e.getKey(), o.toString());
                        needsTerminalization = true;
                        Log.w(TAG, "queued invalid FIRED identity for REJECTED: " + e.getKey());
                        continue;
                    }
                    fired.add(o);
                } catch (JSONException parseEx) {
                    try {
                        JSONObject rejected = new JSONObject();
                        rejected.put("status", AutoDeductionContract.STATUS_REJECTED);
                        rejected.put("rejectedAt", System.currentTimeMillis());
                        rejected.put("rejectionReason", "invalid_json");
                        rejected.put("storageKey", e.getKey());
                        if (editor == null) editor = prefs.edit();
                        editor.putString(e.getKey(), rejected.toString());
                        needsTerminalization = true;
                        Log.w(TAG, "queued invalid JSON event row for REJECTED: " + e.getKey());
                    } catch (JSONException writeEx) {
                        Log.e(TAG, "failed to build REJECTED record for invalid JSON: "
                                + e.getKey(), writeEx);
                        return FiredEventsResult.failure("rejected_build_failed");
                    }
                }
            }

            if (needsTerminalization && !commitEditor(editor)) {
                // Critical: valid events from the same scan are NOT exposed when
                // an invalid FIRED row could not be terminalized. Callers must
                // retry instead of interpreting a partial snapshot as authoritative.
                Log.e(TAG, "REJECTED terminalization commit failed — bulk FIRED read failed");
                return FiredEventsResult.failure("rejected_persist_failed");
            }
        }
        return FiredEventsResult.success(fired);
    }

    /** Backward-compatible list API used by focused native tests/callers. */
    public List<JSONObject> listFiredEvents() {
        return listFiredEventsResult().events;
    }

    /**
     * Commit editor, respecting optional test seam {@link #testForceCommitResult}.
     * @return true only when durable write confirmed.
     */
    private static boolean commitEditor(SharedPreferences.Editor editor) {
        Boolean forced = testForceCommitResult;
        if (forced != null) {
            // Still attempt real commit when force=true so storage reflects REJECTED;
            // when force=false, skip real commit so storage stays pre-terminal.
            if (forced) {
                return editor.commit();
            }
            // Discard pending edits without writing (simulate commit failure).
            return false;
        }
        return editor.commit();
    }

    /**
     * True when a FIRED row lacks a valid occurrence identity, calendar date, or amount.
     * Such records cannot be safely reconciled and must become terminal REJECTED.
     */
    static boolean isMalformedFired(JSONObject o) {
        if (o == null) return true;
        String medId = o.optString("medicationId", "").trim();
        String doseId = o.optString("doseId", "").trim();
        String calendarDate = o.optString("calendarDate", "").trim();
        if (medId.isEmpty() || doseId.isEmpty()) return true;
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)) return true;
        double amt = o.optDouble("amount", Double.NaN);
        if (!AutoDeductionContract.isValidAmount(amt)) return true;
        return false;
    }
    /**
     * Promote pending fires, then return an explicit FIRED lookup result for one
     * occurrence identity. A malformed row that cannot be durably terminalized
     * is returned as FAILURE so callers cannot fall through to SCHEDULED/ABSENT.
     * Nested under EventStore.LOCK after caller holds SCHEDULE_LOCK.
     */
    public EventLookupResult getFiredUnreconciledEvent(
            String medicationId, String doseId, String calendarDate) {
        PendingFiresResult promotion = promotePendingFiresResult();
        if (!promotion.ok) {
            return EventLookupResult.failure(promotion.error);
        }
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = KEY_EVENT_PREFIX + key;
        synchronized (LOCK) {
            String raw = prefs.getString(prefKey, null);
            if (raw == null) return EventLookupResult.absent();
            try {
                JSONObject obj = new JSONObject(raw);
                String status = obj.optString("status", "");
                if (!AutoDeductionContract.STATUS_FIRED.equals(status)) {
                    return EventLookupResult.absent();
                }

                StorageIdentity storageIdentity = parseStorageKeyIdentity(prefKey);
                String rowMed = obj.optString("medicationId", "");
                String rowDose = obj.optString("doseId", "");
                String rowDate = obj.optString("calendarDate", "");
                boolean requestIdentityMatches =
                        medicationId.equals(rowMed)
                        && doseId.equals(rowDose)
                        && calendarDate.equals(rowDate);
                boolean malformed = isMalformedFired(obj);
                boolean storageIdentityMatches =
                        storageIdentityMatchesPayload(storageIdentity, obj);

                if (malformed || !storageIdentityMatches || !requestIdentityMatches) {
                    String rejectionReason = malformed
                            ? "malformed_fields"
                            : "identity_mismatch";
                    return terminalizeFiredRowLocked(prefKey, obj, rejectionReason);
                }
                return EventLookupResult.found(obj);
            } catch (JSONException e) {
                EventLookupResult result = terminalizeInvalidJsonLocked(prefKey);
                if (!result.ok) {
                    Log.e(TAG, "invalid JSON terminalization failed for " + prefKey);
                }
                return result;
            }
        }
    }
}
