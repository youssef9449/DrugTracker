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
     * Promote any pending-fire records into the main FIRED ledger (idempotent).
     * Safe to call from boot, listEvents, or any recovery path.
     * Returns number of pending entries successfully promoted or already present.
     */
    public int promotePendingFires() {
        int promoted = 0;
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
                    long scheduledAt = obj.optLong("scheduledAtEpochMs", 0L);
                    double amount = obj.optDouble("amount", Double.NaN);
                    if (medId.isEmpty() || doseId.isEmpty()
                            || !AutoDeductionContract.isValidCalendarDate(date)
                            || !AutoDeductionContract.isValidAmount(amount)) {
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
                    boolean written = prefs.edit().putString(eventKey, obj.toString()).commit();
                    if (!written) {
                        written = prefs.edit().putString(eventKey, obj.toString()).commit();
                    }
                    if (written) {
                        toRemove.add(e.getKey());
                        promoted++;
                        Log.i(TAG, "promoted pending-fire to FIRED: " + medId + "/" + doseId + "/" + date);
                    } else {
                        Log.e(TAG, "promote pending commit failed for " + e.getKey());
                    }
                } catch (JSONException ex) {
                    Log.e(TAG, "promote pending parse failed", ex);
                    toRemove.add(e.getKey());
                }
            }
            if (!toRemove.isEmpty()) {
                SharedPreferences.Editor ed = pendingPrefs.edit();
                for (String k : toRemove) {
                    ed.remove(k);
                }
                ed.commit();
            }
        }
        return promoted;
    }

    public boolean hasEvent(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (LOCK) {
            return prefs.contains(KEY_EVENT_PREFIX + key);
        }
    }

    /**
     * Mark an existing FIRED event as RECONCILED. No-op if missing or already reconciled.
     * Returns true if status transitioned to RECONCILED.
     */
    public boolean markReconciled(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = KEY_EVENT_PREFIX + key;
        synchronized (LOCK) {
            String raw = prefs.getString(prefKey, null);
            if (raw == null) return false;
            try {
                JSONObject obj = new JSONObject(raw);
                String status = obj.optString("status", "");
                if (AutoDeductionContract.STATUS_RECONCILED.equals(status)) {
                    return false;
                }
                obj.put("status", AutoDeductionContract.STATUS_RECONCILED);
                obj.put("reconciledAtEpochMs", System.currentTimeMillis());
                return prefs.edit().putString(prefKey, obj.toString()).commit();
            } catch (JSONException e) {
                Log.e(TAG, "markReconciled parse failed", e);
                return false;
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

    /** List only FIRED (unreconciled) events. Promotes pending first. */
    public List<JSONObject> listFiredEvents() {
        List<JSONObject> all = listEvents();
        List<JSONObject> fired = new ArrayList<>();
        for (JSONObject o : all) {
            if (AutoDeductionContract.STATUS_FIRED.equals(o.optString("status", ""))) {
                fired.add(o);
            }
        }
        return fired;
    }
}
