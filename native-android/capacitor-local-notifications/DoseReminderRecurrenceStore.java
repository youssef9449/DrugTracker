package com.capacitorjs.plugins.localnotifications;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.util.Calendar;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

/**
 * Temporary delivery-transition evidence that {@link TimedNotificationPublisher}
 * successfully re-armed one specific next calendar-day dose occurrence via
 * AlarmManager.
 *
 * <p>Not a durable proof that the AlarmManager alarm still exists. Keyed by
 * {@code medicationId + doseId}. Each entry records one occurrence identity:
 * nextOccurrenceMs, nextCalendarDate, reminderTime (HH:MM), and the native
 * notification id used for that arm.
 *
 * <p>{@link #isValidReArm} is true only when the entry matches the current dose
 * config <em>and</em> Capacitor {@code NOTIFICATION_STORE} still holds a future
 * {@code schedule.at} for the same notification id (same source of truth
 * {@code getPending()} uses). If the alarm/storage was wiped without
 * {@link #clear}, evidence is invalid so JS can repair.
 *
 * <p>Written only after AlarmManager.set* and NotificationStorage persist
 * succeed. Cleared on cancel / recurrence change.
 */
public final class DoseReminderRecurrenceStore {

    /** SharedPreferences file name (app-private). */
    public static final String PREFS_NAME = "dose_reminder_recurrence";

    /** Must match Capacitor NotificationStorage.NOTIFICATION_STORE_ID. */
    static final String NOTIFICATION_STORE_PREFS = "NOTIFICATION_STORE";

    private static final String KEY_PREFIX = "rearm:";

    private DoseReminderRecurrenceStore() {}

    /**
     * Stable store key: medicationId + doseId. Requires non-empty doseId.
     * Returns null when medicationId or doseId is missing/empty.
     */
    public static String storeKey(String medicationId, String doseId) {
        if (medicationId == null || medicationId.isEmpty()) {
            return null;
        }
        if (doseId == null || doseId.isEmpty()) {
            return null;
        }
        return KEY_PREFIX + medicationId + "::" + doseId;
    }

    /**
     * Record a successful next-day re-arm for one occurrence. Call only after
     * AlarmManager.set* and NotificationStorage persist succeed.
     *
     * @param nextOccurrenceMs wall-clock trigger of the armed occurrence
     * @param reminderTime     HH:MM schedule identity that produced this arm
     * @param notificationId   stable dose-alarm id (PendingIntent request code)
     */
    public static void markReArmed(
            Context context,
            String medicationId,
            String doseId,
            long nextOccurrenceMs,
            String reminderTime,
            int notificationId
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
            String nextDate = calendarDateOf(nextOccurrenceMs);
            // Integrity: nextOccurrenceMs local HH:MM must match reminderTime.
            if (!occurrenceTimeMatches(nextOccurrenceMs, normalizedTime)) {
                Log.w("LN", "DoseReminderRecurrenceStore: nextOccurrenceMs HH:MM mismatch; skip mark");
                return;
            }

            JSONObject obj = new JSONObject();
            obj.put("medicationId", medicationId);
            obj.put("doseId", doseId);
            obj.put("nextOccurrenceMs", nextOccurrenceMs);
            obj.put("reminderTime", normalizedTime);
            obj.put("nextCalendarDate", nextDate);
            obj.put("notificationId", notificationId);

            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(key, obj.toString()).commit();
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.markReArmed failed", e);
        }
    }

    /**
     * Next armed occurrence epoch ms, or {@code -1} if absent / unreadable.
     * Does not validate usability — callers use {@link #isValidReArm}.
     */
    public static long getNextOccurrenceMs(Context context, String medicationId, String doseId) {
        JSONObject obj = readEntry(context, medicationId, doseId);
        if (obj == null) {
            return -1L;
        }
        return obj.optLong("nextOccurrenceMs", -1L);
    }

    /** Stored reminderTime for this slot, or null if absent. */
    public static String getStoredReminderTime(Context context, String medicationId, String doseId) {
        JSONObject obj = readEntry(context, medicationId, doseId);
        if (obj == null) {
            return null;
        }
        String t = obj.optString("reminderTime", "");
        return t.isEmpty() ? null : t;
    }

    /**
     * True only when evidence is usable for the current dose recurrence:
     * <ul>
     *   <li>entry exists for medicationId + doseId</li>
     *   <li>stored reminderTime matches expectedReminderTime</li>
     *   <li>nextOccurrenceMs still future (60s skew)</li>
     *   <li>nextCalendarDate matches the local date of nextOccurrenceMs</li>
     *   <li>local HH:MM of nextOccurrenceMs matches reminderTime</li>
     *   <li>NOTIFICATION_STORE still has that notificationId with a future schedule.at
     *       consistent with nextOccurrenceMs — otherwise evidence is stale and is cleared</li>
     * </ul>
     * SharedPreferences alone never proves the AlarmManager alarm still exists.
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
            String expectedDose = normalizeDoseId(doseId);
            String storedDose = normalizeDoseId(obj.optString("doseId", ""));
            if (expectedDose.isEmpty() || storedDose.isEmpty() || !storedDose.equals(expectedDose)) {
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
            if (next <= nowMs - 60_000L) {
                // Occurrence spent — drop evidence so it cannot linger.
                clear(context, medicationId, doseId);
                return false;
            }
            String storedDate = obj.optString("nextCalendarDate", "");
            String dateFromMs = calendarDateOf(next);
            if (storedDate.isEmpty() || !storedDate.equals(dateFromMs)) {
                clear(context, medicationId, doseId);
                return false;
            }
            if (!occurrenceTimeMatches(next, storedTime)) {
                clear(context, medicationId, doseId);
                return false;
            }
            int notificationId = obj.optInt("notificationId", Integer.MIN_VALUE);
            if (notificationId == Integer.MIN_VALUE) {
                // Pre-notificationId entries cannot prove storage liveness.
                clear(context, medicationId, doseId);
                return false;
            }
            if (!notificationStoreHasFutureOccurrence(context, notificationId, next, nowMs)) {
                // Alarm/storage gone while prefs entry remained — stale; allow repair.
                clear(context, medicationId, doseId);
                return false;
            }
            return true;
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

    /**
     * True when Capacitor NOTIFICATION_STORE still has a JSON entry for
     * {@code notificationId} whose schedule.at is a future time consistent
     * with {@code expectedNextMs} (within 2 minutes).
     */
    static boolean notificationStoreHasFutureOccurrence(
            Context context,
            int notificationId,
            long expectedNextMs,
            long nowMs
    ) {
        if (context == null || notificationId == Integer.MIN_VALUE) {
            return false;
        }
        try {
            SharedPreferences storage =
                    context.getApplicationContext()
                            .getSharedPreferences(NOTIFICATION_STORE_PREFS, Context.MODE_PRIVATE);
            String raw = storage.getString(Integer.toString(notificationId), null);
            if (raw == null || raw.isEmpty()) {
                return false;
            }
            JSONObject notif = new JSONObject(raw);
            JSONObject schedule = notif.optJSONObject("schedule");
            if (schedule == null) {
                return false;
            }
            String at = schedule.optString("at", "");
            if (at.isEmpty()) {
                return false;
            }
            long atMs = parseScheduleAtMs(at);
            if (atMs <= 0) {
                return false;
            }
            if (atMs <= nowMs - 60_000L) {
                return false;
            }
            // Must refer to the same armed occurrence (not an unrelated reschedule).
            return Math.abs(atMs - expectedNextMs) <= 120_000L;
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.notificationStore check failed", e);
            return false;
        }
    }

    private static long parseScheduleAtMs(String at) {
        try {
            // ISO-8601 written by TimedNotificationPublisher.persistDoseReminderNextAt
            java.text.SimpleDateFormat iso =
                    new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
            java.util.Date d = iso.parse(at);
            return d != null ? d.getTime() : -1L;
        } catch (Exception ignored) {
            // Fall through
        }
        try {
            return java.time.Instant.parse(at).toEpochMilli();
        } catch (Exception ignored) {
            // Fall through
        }
        try {
            long asLong = Long.parseLong(at.trim());
            return asLong > 0 ? asLong : -1L;
        } catch (Exception e) {
            return -1L;
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
            if (!prefs.contains(key)) {
                return null;
            }
            // Prefer typed inspection so legacy putLong keys are dropped cleanly
            // (getString on a long value can ClassCastException on some devices).
            Map<String, ?> all = prefs.getAll();
            Object rawVal = all.get(key);
            if (rawVal == null) {
                prefs.edit().remove(key).commit();
                return null;
            }
            if (rawVal instanceof Number) {
                // Legacy long-only format — cannot validate config or storage.
                prefs.edit().remove(key).commit();
                return null;
            }
            if (!(rawVal instanceof String)) {
                prefs.edit().remove(key).commit();
                return null;
            }
            String raw = ((String) rawVal).trim();
            if (raw.isEmpty()) {
                prefs.edit().remove(key).commit();
                return null;
            }
            // Legacy numeric string without JSON structure.
            if (raw.charAt(0) != '{') {
                prefs.edit().remove(key).commit();
                return null;
            }
            try {
                return new JSONObject(raw);
            } catch (Exception parseErr) {
                prefs.edit().remove(key).commit();
                return null;
            }
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.readEntry failed", e);
            try {
                String key2 = storeKey(medicationId, doseId);
                if (key2 != null) {
                    context.getApplicationContext()
                            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                            .edit()
                            .remove(key2)
                            .commit();
                }
            } catch (Exception ignored) {
                // best-effort purge
            }
            return null;
        }
    }

    private static String normalizeDoseId(String doseId) {
        if (doseId == null || doseId.isEmpty()) {
            return "";
        }
        return doseId;
    }

    static String calendarDateOf(long epochMs) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(epochMs);
        int y = cal.get(Calendar.YEAR);
        int m = cal.get(Calendar.MONTH) + 1;
        int day = cal.get(Calendar.DAY_OF_MONTH);
        return String.format(Locale.US, "%04d-%02d-%02d", y, m, day);
    }

    static boolean occurrenceTimeMatches(long occurrenceMs, String normalizedHhmm) {
        if (normalizedHhmm == null) {
            return false;
        }
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(occurrenceMs);
        int hour = cal.get(Calendar.HOUR_OF_DAY);
        int minute = cal.get(Calendar.MINUTE);
        String actual = String.format(Locale.US, "%02d:%02d", hour, minute);
        return actual.equals(normalizedHhmm);
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
            int end = rest.indexOf(':');
            if (end > 0) {
                rest = rest.substring(0, end);
            }
            int minute = Integer.parseInt(rest.trim());
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                return null;
            }
            return String.format(Locale.US, "%02d:%02d", hour, minute);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
