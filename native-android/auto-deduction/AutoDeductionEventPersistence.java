package app.drugtracker.autodeduction;

import android.content.SharedPreferences;
import java.util.Map;

/**
 * Raw SharedPreferences access for Auto event persistence.
 * Event semantics, validation, recovery policy, and state transitions remain
 * in AutoDeductionEventStore.
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
     * Synchronous commit (#493): FIRED event rows are crash-recovery
     * evidence — the write result drives the insertFired state machine and a
     * lost write would silently drop a due deduction. Called under the store
     * lock (background executor), never on a UI thread.
     */
    boolean putEvent(String key, String value) {
        return eventPrefs.edit().putString(key, value).commit();
    }

    /**
     * Synchronous commit (#493): the pending-FIRED marker must be durable
     * BEFORE the occurrence can fire so a crash cannot lose the promotion
     * evidence. Same lock/executor discipline as putEvent.
     */
    boolean putPending(String key, String value) {
        return pendingPrefs.edit().putString(key, value).commit();
    }

    /**
     * Synchronous commit (#493): removal result decides whether a RECONCILED
     * promotion is considered complete; an uncertain removal would force the
     * reconciliation to re-run. Same lock/executor discipline as putEvent.
     */
    boolean removeEvent(String key) {
        return eventPrefs.edit().remove(key).commit();
    }

    /**
     * Synchronous commit (#493): the pending marker is removed only after the
     * FIRED row is durable; the explicit result prevents double promotion.
     */
    boolean removePending(String key) {
        return pendingPrefs.edit().remove(key).commit();
    }

    boolean removePendingKeys(java.util.List<String> keys) {
        if (keys.isEmpty()) return true;
        SharedPreferences.Editor editor = pendingPrefs.edit();
        for (String key : keys) editor.remove(key);
        // Synchronous commit (#493): batched promotion cleanup shares the same
        // explicit-outcome requirement as removePending.
        return editor.commit();
    }

    SharedPreferences.Editor eventEditor() {
        return eventPrefs.edit();
    }

    SharedPreferences.Editor pendingEditor() {
        return pendingPrefs.edit();
    }
}
