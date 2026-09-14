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
 * Does NOT mutate stock, React state, or localStorage.
 */
public final class AutoDeductionEventStore {

    private static final String TAG = "AutoDeductionEventStore";
    private static final String KEY_EVENT_PREFIX = "evt:";

    /**
     * Process-wide lock shared by every EventStore instance.
     * Instance fields cannot serialize concurrent receiver deliveries.
     */
    private static final Object LOCK = new Object();

    private final SharedPreferences prefs;

    public AutoDeductionEventStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(AutoDeductionContract.PREFS_EVENTS, Context.MODE_PRIVATE);
    }

    /**
     * Result of an insertFiredIfAbsent attempt.
     * <ul>
     *   <li>{@link Status#CREATED} — event did not exist and was durably committed</li>
     *   <li>{@link Status#ALREADY_EXISTS} — event already present for the occurrence identity</li>
     *   <li>{@link Status#FAILED} — could not confirm durable insertion (invalid payload,
     *       JSON failure, or SharedPreferences commit failure). Never treated as duplicate.</li>
     * </ul>
     */
    public static final class InsertFiredResult {
        public enum Status {
            CREATED,
            ALREADY_EXISTS,
            FAILED
        }

        public final Status status;

        public InsertFiredResult(Status status) {
            this.status = status;
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
            // commit() so the event is on disk before the receiver returns
            // (important if the process is killed immediately after fire).
            boolean written = prefs.edit().putString(prefKey, obj.toString()).commit();
            if (!written) {
                Log.e(TAG, "commit failed for key=" + key);
                return new InsertFiredResult(InsertFiredResult.Status.FAILED);
            }
            return new InsertFiredResult(InsertFiredResult.Status.CREATED);
        }
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

    /** List all events (FIRED and RECONCILED) as JSON objects. */
    public List<JSONObject> listEvents() {
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

    /** List only FIRED (unreconciled) events. */
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
