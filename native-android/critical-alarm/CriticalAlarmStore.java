package app.drugtracker.criticalalarm;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Durable metadata for armed future Critical Stock alarms.
 * Used by {@link CriticalAlarmSystemReceiver} on TIMEZONE_CHANGED to
 * recompute absolute fire timestamps from local calendar date + HH:mm
 * under the new default timezone without opening the app.
 *
 * Only future Critical alarms are recorded. Claim / business dedup state
 * remains in JS (criticalNotificationClaims); this store is native
 * lifecycle only.
 */
public final class CriticalAlarmStore {
    private static final String TAG = "CriticalAlarmStore";
    private static final String PREFS = "drugtracker_critical_alarms_v1";
    private static final String KEY_ALARMS = "alarms";

    private CriticalAlarmStore() {}

    public static synchronized void put(
            Context context,
            String medicationId,
            int notificationId,
            String targetDate,
            String targetLocalTime,
            long fireAtMs,
            String timezoneId,
            String title,
            String body
    ) {
        try {
            JSONArray arr = loadArray(context);
            // Replace existing entry for same medicationId.
            JSONArray next = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!medicationId.equals(o.optString("medicationId"))) {
                    next.put(o);
                }
            }
            JSONObject entry = new JSONObject();
            entry.put("medicationId", medicationId);
            entry.put("notificationId", notificationId);
            entry.put("targetDate", targetDate);
            entry.put("targetLocalTime", targetLocalTime);
            entry.put("fireAtMs", fireAtMs);
            entry.put("timezoneId", timezoneId);
            entry.put("title", title);
            entry.put("body", body);
            next.put(entry);
            saveArray(context, next);
        } catch (JSONException e) {
            Log.e(TAG, "put failed", e);
        }
    }

    public static synchronized void remove(Context context, String medicationId) {
        try {
            JSONArray arr = loadArray(context);
            JSONArray next = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!medicationId.equals(o.optString("medicationId"))) {
                    next.put(o);
                }
            }
            saveArray(context, next);
        } catch (JSONException e) {
            Log.e(TAG, "remove failed", e);
        }
    }

    public static synchronized JSONArray all(Context context) {
        return loadArray(context);
    }

    private static JSONArray loadArray(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_ALARMS, "[]");
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void saveArray(Context context, JSONArray arr) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_ALARMS, arr.toString())
                .commit();
    }
}
