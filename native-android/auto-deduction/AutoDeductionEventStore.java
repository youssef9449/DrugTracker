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
 * Idempotency: at most one event per occurrence key. Insert-if-absent
 * is synchronized. Does NOT mutate stock, React state, or localStorage.
 */
public final class AutoDeductionEventStore {

    private static final String TAG = "AutoDeductionEventStore";
    private static final String KEY_EVENT_PREFIX = "evt:";

    private final SharedPreferences prefs;
    private final Object lock = new Object();

    public AutoDeductionEventStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(AutoDeductionContract.PREFS_EVENTS, Context.MODE_PRIVATE);
    }

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

        synchronized (lock) {
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
            prefs.edit().putString(prefKey, obj.toString()).commit();
            return true;
        }
    }

    public boolean hasEvent(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (lock) {
            return prefs.contains(KEY_EVENT_PREFIX + key);
        }
    }

    public boolean markReconciled(String medicationId, String doseId, String calendarDate) {
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = KEY_EVENT_PREFIX + key;
        synchronized (lock) {
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
                prefs.edit().putString(prefKey, obj.toString()).commit();
                return true;
            } catch (JSONException e) {
                Log.e(TAG, "markReconciled parse failed", e);
                return false;
            }
        }
    }

    public List<JSONObject> listEvents() {
        List<JSONObject> out = new ArrayList<>();
        synchronized (lock) {
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
