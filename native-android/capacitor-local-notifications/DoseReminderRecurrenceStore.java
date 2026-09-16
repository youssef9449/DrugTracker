package com.capacitorjs.plugins.localnotifications;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Durable native evidence that {@link TimedNotificationPublisher} successfully
 * re-armed the next calendar-day dose reminder via raw AlarmManager.
 *
 * <p>Keyed by {@code medicationId + doseId} (not notification id alone) so
 * sibling doses never share state. Survives process death. Written only after
 * AlarmManager.set* succeeds.
 *
 * <p>JS reconciliation uses {@link #getNextOccurrenceMs} to distinguish:
 * <ul>
 *   <li>true missing alarm → repair</li>
 *   <li>post-delivery native re-arm → no-op</li>
 * </ul>
 */
public final class DoseReminderRecurrenceStore {

    /** SharedPreferences file name (app-private). Readable from any package in the app. */
    public static final String PREFS_NAME = "dose_reminder_recurrence";

    private static final String KEY_PREFIX = "next_at_ms:";
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
     * Record a successful next-day re-arm. Call only after AlarmManager.set*
     * returns without throwing.
     *
     * @param nextOccurrenceMs wall-clock trigger of the armed occurrence
     */
    public static void markReArmed(
            Context context,
            String medicationId,
            String doseId,
            long nextOccurrenceMs
    ) {
        if (context == null || nextOccurrenceMs <= 0) {
            return;
        }
        String key = storeKey(medicationId, doseId);
        if (key == null) {
            return;
        }
        try {
            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putLong(key, nextOccurrenceMs).commit();
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.markReArmed failed", e);
        }
    }

    /**
     * Next armed occurrence epoch ms, or {@code -1} if absent.
     * Does not validate expiry — callers use {@link #isValidReArm}.
     */
    public static long getNextOccurrenceMs(Context context, String medicationId, String doseId) {
        if (context == null) {
            return -1L;
        }
        String key = storeKey(medicationId, doseId);
        if (key == null) {
            return -1L;
        }
        try {
            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            if (!prefs.contains(key)) {
                return -1L;
            }
            return prefs.getLong(key, -1L);
        } catch (Exception e) {
            Log.e("LN", "DoseReminderRecurrenceStore.getNextOccurrenceMs failed", e);
            return -1L;
        }
    }

    /**
     * True when a persisted next occurrence exists and is still in the future
     * (60s skew tolerance). Expired/absent → false (JS may repair).
     */
    public static boolean isValidReArm(
            Context context,
            String medicationId,
            String doseId,
            long nowMs
    ) {
        long next = getNextOccurrenceMs(context, medicationId, doseId);
        if (next <= 0) {
            return false;
        }
        return next > nowMs - 60_000L;
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
}
