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
     * Insert a FIRED event if and only if no event exists for the key.
     * Returns true if this call created the event; false if one already existed
     * or the payload was invalid.
     *
     * Thread-safe across instances: check + durable write under {@link #LOCK}.
     */
    public boolean insertFiredIfAbsent(
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
            return false;
        }

        final String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        final String prefKey = KEY_EVENT_PREFIX + key;

        synchronized (LOCK) {
            if (prefs.contains(prefKey)) {
                return false;
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
                return false;
            }
            // commit() so the event is on disk before the receiver returns
            // (important if the process is killed immediately after fire).
            boolean written = prefs.edit().putString(prefKey, obj.toString()).commit();
            if (!written) {
                Log.e(TAG, "commit failed for key=" + key);
                return false;
            }
            return true;
        }
    }

    public boolean hasEvent(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (LOCK) {
            return prefs.contains(KEY_EVENT_PREFIX + key);
        }
    }

    /**
     * Result of an acknowledgement attempt.
     * <ul>
     *   <li>{@code ok=true, changed=true} — FIRED → RECONCILED transition succeeded</li>
     *   <li>{@code ok=true, changed=false} — already RECONCILED (terminal success, no retry)</li>
     *   <li>{@code ok=false, changed=false} — real failure (missing, parse, or commit); remains retryable</li>
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
                return new MarkResult(false, false);
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
