package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

/**
 * Recurrence authorization generation persistence (#489 responsibility
 * extraction from AutoDeductionRecurrence).
 *
 * Owns ONLY the durable medication+dose generation counter used to
 * authorize future recurrence scheduling: raw read, authorization check,
 * first-generation allocation, and commit. Cancellation orchestration and
 * business policy (when a generation is invalidated) stay in
 * AutoDeductionRecurrence / AutoDeductionScheduler.
 *
 * Locking: callers hold the shared Auto operation lock — every method here
 * is a *Locked operation by contract and performs no locking of its own.
 */
final class AutoDeductionRecurrenceGenerationStore {
    private final SharedPreferences prefs;

    AutoDeductionRecurrenceGenerationStore(Context context) {
        this.prefs = context.getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH,
                Context.MODE_PRIVATE);
    }

    private static String recurrenceAuthKey(String medicationId, String doseId) {
        return AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                + AutoDeductionContract.scheduleIdentityKey(medicationId, doseId);
    }

    long getLocked(String medicationId, String doseId) {
        return prefs.getLong(recurrenceAuthKey(medicationId, doseId), 0L);
    }

    boolean isAuthorizedLocked(String medicationId, String doseId, long expectedGeneration) {
        long active = getLocked(medicationId, doseId);
        return expectedGeneration > 0L && expectedGeneration == active;
    }

    /**
     * Allocate the first generation for a medication+dose. Returns 0 when the
     * durable commit fails (the caller must treat 0 as "not allocated").
     */
    long ensureLocked(String medicationId, String doseId) {
        String key = recurrenceAuthKey(medicationId, doseId);
        long g = prefs.getLong(key, 0L);
        if (g > 0L) {
            return g;
        }
        g = 1L;
        if (!prefs.edit().putLong(key, g).commit()) {
            Log.e("AutoDeductionScheduler",
                    "ensureRecurrenceGenerationLocked: commit failed for " + key);
            return 0L;
        }
        return g;
    }

    /** Durable generation bump under the caller's lock. */
    boolean commitLocked(String medicationId, String doseId, long nextGeneration) {
        return prefs.edit()
                .putLong(recurrenceAuthKey(medicationId, doseId), nextGeneration)
                .commit();
    }
}
