package app.drugtracker.autodeduction;

import android.content.SharedPreferences;
import java.util.Map;

/**
 * Raw SharedPreferences access for Auto event persistence.
 * Event semantics, validation, recovery policy, and state transitions remain
 * in AutoDeductionEventStore.
 *
 * <p>Durability classification (#493): synchronous {@code commit()} is used
 * only where the write outcome is itself part of the state machine or where
 * the next correctness-critical step depends on the write already being
 * durable. Post-completion cleanup uses {@code apply()} because a removal
 * that never lands is re-cleaned idempotently by the next promotion pass
 * (the containsEvent guard prevents double promotion, not the removal).</p>
 */
final class AutoDeductionEventPersistence {
    private final SharedPreferences eventPrefs;
    private final SharedPreferences pendingPrefs;

    AutoDeductionEventPersistence(
            SharedPreferences eventPrefs,
            SharedPreferences pendingPrefs) {
        this.eventPrefs = eventPrefs;
        this.pendingPrefs = pendingPrefs;
    }

    boolean containsEvent(String key) {
        return eventPrefs.contains(key);
    }

    String getEvent(String key) {
        return eventPrefs.getString(key, null);
    }

    Map<String, ?> getAllEvents() {
        return eventPrefs.getAll();
    }

    Map<String, ?> getAllPending() {
        return pendingPrefs.getAll();
    }

    /**
     * Synchronous commit (#493): the FIRED row is the crash-recovery evidence
     * for a due deduction. The caller checks the returned outcome — failure
     * triggers one retry and then switches recovery to the durable
     * pending-fire fallback, so the write must be durably completed before it
     * is reported as successful. Callers hold the store lock on a background
     * thread; bridge callers are dispatched off the Capacitor plugin thread
     * via ExactAlarmRuntime.executeAsync.
     */
    boolean putEvent(String key, String value) {
        return eventPrefs.edit().putString(key, value).commit();
    }

    /**
     * Synchronous commit (#493): this marker is NOT written before an
     * occurrence fires. The actual flow is: the FIRED write fails, the retry
     * also fails, and only then is this pending recovery fallback selected —
     * making this marker the last remaining durable copy of the occurrence
     * evidence. Once that fallback is chosen, the write must be durably
     * completed (a lost marker would permanently drop a due deduction), and
     * the outcome becomes {@code pendingRecorded}, which tells the caller
     * that recovery evidence exists. Same lock/executor discipline as
     * putEvent.
     */
    boolean putPending(String key, String value) {
        return pendingPrefs.edit().putString(key, value).commit();
    }

    /**
     * Asynchronous cleanup (#493): invoked only after the FIRED row for the
     * same occurrence is already durably committed, so this stale pending
     * marker is redundant evidence. A removal that never lands (crash before
     * the async write flushes) is re-cleaned idempotently by the next
     * promotion pass — double promotion is prevented by the promotion pass's
     * containsEvent guard, not by this removal. In-process readers observe
     * applied values immediately.
     */
    void removePending(String key) {
        pendingPrefs.edit().remove(key).apply();
    }

    /**
     * Asynchronous cleanup (#493): batched removal of pending markers whose
     * FIRED promotions (or already-existing FIRED rows) are durably complete.
     * No outcome is reported because nothing depends on the removal being
     * immediately durable: surviving markers are re-cleaned idempotently by
     * the next promotion pass. Same lock/executor discipline as putEvent.
     */
    void removePendingKeys(java.util.List<String> keys) {
        if (keys.isEmpty()) return;
        SharedPreferences.Editor editor = pendingPrefs.edit();
        for (String key : keys) editor.remove(key);
        editor.apply();
    }

    SharedPreferences.Editor eventEditor() {
        return eventPrefs.edit();
    }

    SharedPreferences.Editor pendingEditor() {
        return pendingPrefs.edit();
    }
}
