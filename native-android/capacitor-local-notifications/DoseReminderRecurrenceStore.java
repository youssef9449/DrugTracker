package com.capacitorjs.plugins.localnotifications;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import org.json.JSONObject;

/**
 * Temporary delivery-transition evidence that {@link TimedNotificationPublisher}
 * successfully re-armed one specific next calendar-day dose occurrence via
 * AlarmManager.
 *
 * <p>Not a durable proof that the AlarmManager alarm still exists. Keyed by
 * {@code medicationId + doseId}. Each entry records the armed next occurrence
 * and the source schedule identity ({@code reminderTime} HH:MM) so validation
 * can reject stale evidence after config change.
 *
 * <p>Written only after AlarmManager.set* succeeds. Cleared on cancel /
 * recurrence change. JS must pass the current desired {@code reminderTime}
 * when querying validity.
 */
public final class DoseReminderRecurrenceStore {

    /** SharedPreferences file name (app-private). */
    public static final String PREFS_NAME = "dose_reminder_recurrence";

    private static final String KEY_PREFIX = "rearm:";
    private static final String LEGACY_DOSE_SENTINEL = "__legacy__";

    private DoseReminderRecurrenceStore() {}

    /**
     * Stable store key: medicationId + doseId. Empty/null doseId maps to the
     * legacy sentinel (single-dose meds without a schedule row id).
     */
    public static String storeKey(String medicationId, String doseId) {
        if (medicationId == null || medicationId.isEmpty()) {
            return null;
        }
        String d =
                (doseId == null || doseId.isEmpty() || "__legacy__".equals(doseId))
                        ? LEGACY_DOSE_SENTINEL
                        : doseId;
        return KEY_PREFIX + medicationId + "::" + d;
    }

    /**
     * Record a successful next-day re-arm for one occurrence. Call only after
     * AlarmManager.set* returns without throwing.
     *
     * @param nextOccurrenceMs wall-clock trigger of the armed occurrence
     * @param reminderTime     HH:MM schedule identity that produced this arm
     *                         (must match current dose config for validity)
     */
    public static void markReArmed(
            Context context,
            String medicationId,
            String doseId,
            long nextOccurrenceMs,
            String reminderTime
    ) {
        if (context == null || nextOccurrenceMs <= 0) {
            return;
        }
        if (reminderTime == null || reminderTime.indexOf(':') < 0) {
            return;
        }
        String key = storeKey(medicationId, doseId);
        if (key == null) {
            return;
        }
        try {
            String normalizedTime = normalizeReminderTime(reminderTime);
            if (normalizedTime == null) {
                return;
            }
            JSONObject obj = new JSONObject();
            obj.put("medicationId", medicationId);
            obj.put(
                    "doseId",
                    (doseId == null || doseId.isEmpty()) ? LEGACY_DOSE_SENTINEL : doseId);
            obj.put("nextOccurrenceMs", nextOccurrenceMs);
            obj.put("reminderTime", normalizedTime);
            // Calendar day of the armed next occurrence (yyyy-MM-dd local).
            java.util.Calendar cal = java.util.Calendar.getInstance();
            cal.setTimeInMillis(nextOccurrenceMs);
            int y = cal.get(java.util.Calendar.YEAR);
            int m = cal.get(java.util.Calendar.MONTH) + 1;
            int day = cal.get(java.util.Calendar.DAY_OF_MONTH);
            String nextDate = String.format(java.util.Locale.US, "%04d-%02d-%02d", y, m, day);
            obj.put("nextCalendarDate", nextDate);

            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(key, obj.toString()).commit();
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.markReArmed failed", e);
        }
    }

    /**
     * Next armed occurrence epoch ms, or {@code -1} if absent / unreadable.
     * Does not validate schedule match — callers use {@link #isValidReArm}.
     */
    public static long getNextOccurrenceMs(Context context, String medicationId, String doseId) {
        JSONObject obj = readEntry(context, medicationId, doseId);
        if (obj == null) {
            return -1L;
        }
        return obj.optLong("nextOccurrenceMs", -1L);
    }

    /**
     * Stored reminderTime for this slot, or null if absent.
     */
    public static String getStoredReminderTime(Context context, String medicationId, String doseId) {
        JSONObject obj = readEntry(context, medicationId, doseId);
        if (obj == null) {
            return null;
        }
        String t = obj.optString("reminderTime", "");
        return t.isEmpty() ? null : t;
    }

    /**
     * True only when evidence proves a successful re-arm for the *current*
     * dose recurrence identity:
     * <ul>
     *   <li>entry exists for medicationId + doseId</li>
     *   <li>nextOccurrenceMs still in the future (60s clock skew)</li>
     *   <li>stored reminderTime matches expectedReminderTime (current config)</li>
     *   <li>entry medicationId/doseId match the query key</li>
     * </ul>
     * Stale config (time change), expired occurrence, or absent entry → false
     * so JS can repair. Does not prove AlarmManager still holds the alarm.
     *
     * @param expectedReminderTime current desired HH:MM for this dose slot
     */
    public static boolean isValidReArm(
            Context context,
            String medicationId,
            String doseId,
            long nowMs,
            String expectedReminderTime
    ) {
        if (expectedReminderTime == null || expectedReminderTime.indexOf(':') < 0) {
            return false;
        }
        String expected = normalizeReminderTime(expectedReminderTime);
        if (expected == null) {
            return false;
        }
        JSONObject obj = readEntry(context, medicationId, doseId);
        if (obj == null) {
            return false;
        }
        try {
            String storedMed = obj.optString("medicationId", "");
            if (!storedMed.equals(medicationId)) {
                return false;
            }
            String expectedDose =
                    (doseId == null || doseId.isEmpty() || "__legacy__".equals(doseId))
                            ? LEGACY_DOSE_SENTINEL
                            : doseId;
            String storedDose = obj.optString("doseId", LEGACY_DOSE_SENTINEL);
            if (!storedDose.equals(expectedDose)
                    && !(LEGACY_DOSE_SENTINEL.equals(expectedDose)
                            && (storedDose.isEmpty() || "__legacy__".equals(storedDose)))) {
                return false;
            }
            String storedTime = normalizeReminderTime(obj.optString("reminderTime", ""));
            if (storedTime == null || !storedTime.equals(expected)) {
                return false;
            }
            long next = obj.optLong("nextOccurrenceMs", -1L);
            if (next <= 0) {
                return false;
            }
            // Still the armed future occurrence — past means this evidence is spent.
            return next > nowMs - 60_000L;
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.isValidReArm failed", e);
            return false;
        }
    }

    /** Clear re-arm evidence for one dose slot (cancel / signature change). */
    public static void clear(Context context, String medicationId, String doseId) {
        if (context == null) {
            return;
        }
        String key = storeKey(medicationId, doseId);
        if (key == null) {
            return;
        }
        try {
            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().remove(key).commit();
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.clear failed", e);
        }
    }

    private static JSONObject readEntry(Context context, String medicationId, String doseId) {
        if (context == null) {
            return null;
        }
        String key = storeKey(medicationId, doseId);
        if (key == null) {
            return null;
        }
        try {
            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(key, null);
            if (raw == null || raw.isEmpty()) {
                // Migrate legacy long-only values: treat as absent (cannot validate config).
                if (prefs.contains(key)) {
                    // Could be old putLong format — drop so it cannot block repair forever.
                    prefs.edit().remove(key).commit();
                }
                return null;
            }
            return new JSONObject(raw);
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.readEntry failed", e);
            return null;
        }
    }

    /**
     * Normalize "H:MM" / "HH:MM" to zero-padded HH:MM. Invalid → null.
     */
    static String normalizeReminderTime(String reminderTime) {
        if (reminderTime == null) {
            return null;
        }
        String t = reminderTime.trim();
        int colon = t.indexOf(':');
        if (colon < 1) {
            return null;
        }
        try {
            int hour = Integer.parseInt(t.substring(0, colon));
            String rest = t.substring(colon + 1);
            // allow optional seconds suffix
            int end = rest.indexOf(':');
            if (end > 0) {
                rest = rest.substring(0, end);
            }
            int minute = Integer.parseInt(rest.trim());
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                return null;
            }
            return String.format(java.util.Locale.US, "%02d:%02d", hour, minute);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
