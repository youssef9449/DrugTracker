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

    boolean putEvent(String key, String value) {
        return eventPrefs.edit().putString(key, value).commit();
    }

    boolean putPending(String key, String value) {
        return pendingPrefs.edit().putString(key, value).commit();
    }

    boolean removeEvent(String key) {
        return eventPrefs.edit().remove(key).commit();
    }

    boolean removePending(String key) {
        return pendingPrefs.edit().remove(key).commit();
    }

    boolean removePendingKeys(java.util.List<String> keys) {
        if (keys.isEmpty()) return true;
        SharedPreferences.Editor editor = pendingPrefs.edit();
        for (String key : keys) editor.remove(key);
        return editor.commit();
    }

    SharedPreferences.Editor eventEditor() {
        return eventPrefs.edit();
    }

    SharedPreferences.Editor pendingEditor() {
        return pendingPrefs.edit();
    }
}
