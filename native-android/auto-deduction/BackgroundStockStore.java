package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Auto-owned durable stock execution ledger used while the WebView is unavailable.
 *
 * <p>The canonical UI stock remains Medication.currentPills in JavaScript/localStorage.
 * This store is the Auto feature's native execution shadow: it mirrors the last
 * JavaScript stock generation and applies exact Auto deductions durably when an
 * AlarmManager delivery runs with the app fully closed. Foreground JavaScript
 * mutations are synchronized as generation-aware deltas so an intervening native
 * Auto deduction can never be overwritten by the later foreground snapshot.</p>
 *
 * <p>All state is protected by one process-wide lock. Every Auto occurrence is
 * applied at most once by its medicationId+doseId+calendarDate identity.</p>
 */
public final class BackgroundStockStore {

    private static final String TAG = "BackgroundStockStore";
    private static final String PREFS = "drugtracker_auto_background_stock_v1";
    private static final String KEY_VERSION = "version";
    private static final String KEY_GLOBAL_JS_GENERATION = "lastJsGeneration";
    private static final String KEY_MED_PREFIX = "med:";
    private static final String KEY_APPLIED_PREFIX = "applied:";
    private static final Object LOCK = new Object();

    private static final String MARKER_SOURCE_AUTO = "auto";
    private static final String MARKER_SOURCE_JS = "js";

    public static final class MedicationState {
        public final String medicationId;
        public final double currentPills;
        public final long lastJsGeneration;

        MedicationState(String medicationId, double currentPills, long lastJsGeneration) {
            this.medicationId = medicationId;
            this.currentPills = currentPills;
            this.lastJsGeneration = lastJsGeneration;
        }
    }

    public static final class SyncResult {
        public final boolean ok;
        public final long backgroundVersion;
        public final Map<String, Double> currentPillsByMedication;
        public final String error;

        private SyncResult(
                boolean ok,
                long backgroundVersion,
                Map<String, Double> currentPillsByMedication,
                String error) {
            this.ok = ok;
            this.backgroundVersion = backgroundVersion;
            this.currentPillsByMedication = currentPillsByMedication;
            this.error = error;
        }

        static SyncResult success(long version, Map<String, Double> pills) {
            return new SyncResult(true, version, pills, null);
        }

        static SyncResult failure(long version, Map<String, Double> pills, String error) {
            return new SyncResult(false, version, pills, error);
        }
    }

    public static final class ApplyResult {
        public final boolean ok;
        public final boolean changed;
        public final double currentPills;
        public final double deductedAmount;
        public final long backgroundVersion;
        public final String error;

        private ApplyResult(
                boolean ok,
                boolean changed,
                double currentPills,
                double deductedAmount,
                long backgroundVersion,
                String error) {
            this.ok = ok;
            this.changed = changed;
            this.currentPills = currentPills;
            this.deductedAmount = deductedAmount;
            this.backgroundVersion = backgroundVersion;
            this.error = error;
        }

        static ApplyResult success(
                boolean changed,
                double currentPills,
                double deductedAmount,
                long version) {
            return new ApplyResult(true, changed, currentPills, deductedAmount, version, null);
        }

        static ApplyResult failure(double currentPills, long version, String error) {
            return new ApplyResult(false, false, currentPills, 0.0d, version, error);
        }
    }

    private final SharedPreferences prefs;

    public BackgroundStockStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(
                PREFS,
                Context.MODE_PRIVATE);
    }

    /**
     * Sync a complete JS medication snapshot into the native execution shadow.
     *
     * <p>{@code jsGeneration} is the post-commit generation of the JS durable
     * stock domain. If Auto fired after the last generation known by native,
     * the incoming JS snapshot is treated as a delta from that older generation
     * and applied on top of the native balance rather than overwriting it.</p>
     *
     * @param medications list of rows: medicationId/currentPills
     * @param jsGeneration current durable JS stock generation
     * @param alreadyAppliedOccurrences occurrence identities already represented
     *        by JS stock/history/logs (used to make upgrades safe)
     */
    public SyncResult syncFromJs(
            List<MedicationState> medications,
            long jsGeneration,
            Set<String> alreadyAppliedOccurrences) {
        return syncFromJs(
                medications,
                jsGeneration,
                alreadyAppliedOccurrences,
                java.util.Collections.emptySet(),
                java.util.Collections.emptySet(),
                java.util.Collections.emptySet());
    }

    public SyncResult syncFromJs(
            List<MedicationState> medications,
            long jsGeneration,
            Set<String> alreadyAppliedOccurrences,
            Set<String> clearAppliedOccurrences) {
        return syncFromJs(
                medications,
                jsGeneration,
                alreadyAppliedOccurrences,
                clearAppliedOccurrences,
                java.util.Collections.emptySet(),
                java.util.Collections.emptySet());
    }

    public SyncResult syncFromJs(
            List<MedicationState> medications,
            long jsGeneration,
            Set<String> alreadyAppliedOccurrences,
            Set<String> clearAppliedOccurrences,
            Set<String> jsManualTakeOccurrences,
            Set<String> jsRestoreOccurrences) {
        if (medications == null || jsGeneration < 0L) {
            return SyncResult.failure(
                    readVersion(),
                    readAllCurrentPills(),
                    "invalid_sync_request");
        }

        synchronized (LOCK) {
            long lastGlobalJsGeneration =
                    prefs.getLong(KEY_GLOBAL_JS_GENERATION, -1L);
            if (lastGlobalJsGeneration > jsGeneration) {
                // A stale snapshot must be ignored as a whole: not only its
                // balance, but also its applied-occurrence markers and cleanup
                // decisions. The generation is global because every committed
                // JS stock mutation advances the same stock generation.
                return SyncResult.success(
                        readVersionLocked(),
                        readAllCurrentPillsLocked());
            }

            Map<String, Double> resultPills = new HashMap<>();
            Set<String> incomingIds = new HashSet<>();
            Map<String, String> nextRows = new HashMap<>();
            Map<String, ?> existingPrefs = prefs.getAll();

            for (MedicationState incoming : medications) {
                if (incoming == null
                        || incoming.medicationId == null
                        || incoming.medicationId.trim().isEmpty()
                        || !Double.isFinite(incoming.currentPills)
                        || incoming.currentPills < 0.0d) {
                    return SyncResult.failure(
                            readVersionLocked(),
                            readAllCurrentPillsLocked(),
                            "invalid_medication_snapshot");
                }

                final String id = incoming.medicationId.trim();
                incomingIds.add(id);

                String raw = prefs.getString(KEY_MED_PREFIX + id, null);
                double nativePills = incoming.currentPills;
                long priorJsGeneration = -1L;
                double baseJsPills = incoming.currentPills;

                if (raw != null) {
                    try {
                        JSONObject obj = new JSONObject(raw);
                        nativePills = clamp(obj.optDouble("currentPills", incoming.currentPills));
                        priorJsGeneration = obj.optLong("lastJsGeneration", -1L);
                        baseJsPills = clamp(
                                obj.optDouble(
                                        "baseJsPills",
                                        incoming.currentPills));
                    } catch (Exception e) {
                        Log.w(TAG, "invalid medication shadow; reinitializing " + id, e);
                        nativePills = incoming.currentPills;
                        priorJsGeneration = -1L;
                        baseJsPills = incoming.currentPills;
                    }
                }

                if (priorJsGeneration < 0L) {
                    nativePills = incoming.currentPills;
                } else if (jsGeneration > priorJsGeneration) {
                    // Apply the net foreground JS mutation(s) on top of every
                    // native Auto deduction that happened since priorJsGeneration.
                    //
                    // A Manual Take or Restore for the same occurrence can race the
                    // native Auto fire. In that case the native ledger already contains
                    // an Auto deduction while the JS snapshot represents the user's
                    // manual resolution. Remove the native Auto effect first.
                    double nativeAutoCorrection = 0.0d;
                    double restoreDeltaToExclude = 0.0d;
                    for (String occurrence : jsManualTakeOccurrences == null
                            ? java.util.Collections.<String>emptySet()
                            : jsManualTakeOccurrences) {
                        if (!isOccurrenceForMedication(occurrence, id)) continue;
                        AppliedMarker marker = readAppliedMarkerLocked(occurrence, existingPrefs);
                        if (marker.nativeAuto && marker.deductedAmount > 0.0d) {
                            nativeAutoCorrection += marker.deductedAmount;
                        }
                    }
                    for (String occurrence : jsRestoreOccurrences == null
                            ? java.util.Collections.<String>emptySet()
                            : jsRestoreOccurrences) {
                        if (!isOccurrenceForMedication(occurrence, id)) continue;
                        AppliedMarker marker = readAppliedMarkerLocked(occurrence, existingPrefs);
                        if (marker.nativeAuto && marker.deductedAmount > 0.0d) {
                            nativeAutoCorrection += marker.deductedAmount;
                            restoreDeltaToExclude += marker.deductedAmount;
                        }
                    }
                    double jsDelta = incoming.currentPills - baseJsPills;
                    nativePills = clamp(nativePills + nativeAutoCorrection
                            + jsDelta - restoreDeltaToExclude);
                } else if (jsGeneration < priorJsGeneration) {
                    // A stale foreground snapshot arrived after a newer JS
                    // generation was already synchronized. Do not mutate the
                    // native balance or the stored JS baseline from stale data.
                    resultPills.put(id, clamp(nativePills));
                    continue;
                }

                JSONObject next = new JSONObject();
                try {
                    next.put("medicationId", id);
                    next.put("currentPills", nativePills);
                    next.put("baseJsPills", incoming.currentPills);
                    next.put("lastJsGeneration", jsGeneration);
                } catch (Exception e) {
                    return SyncResult.failure(
                            readVersionLocked(),
                            resultPills,
                            "shadow_build_failed");
                }

                nextRows.put(KEY_MED_PREFIX + id, next.toString());
                resultPills.put(id, nativePills);
            }

            // Build one SharedPreferences transaction for the complete sync:
            // medication rows, stale-row cleanup, occurrence marker changes, and
            // the global JS generation advance become visible together. This
            // avoids a partial background shadow when any individual write fails.
            SharedPreferences.Editor sync = prefs.edit();
            for (Map.Entry<String, String> row : nextRows.entrySet()) {
                sync.putString(row.getKey(), row.getValue());
            }

            for (String key : existingPrefs.keySet()) {
                if (!key.startsWith(KEY_MED_PREFIX)) continue;
                String id = key.substring(KEY_MED_PREFIX.length());
                if (!incomingIds.contains(id)) {
                    sync.remove(key);
                }
            }

            if (clearAppliedOccurrences != null) {
                for (String occurrence : clearAppliedOccurrences) {
                    if (occurrence != null && !occurrence.isEmpty()) {
                        sync.remove(KEY_APPLIED_PREFIX + occurrence);
                    }
                }
            }

            // Restore-before-fire: a Restore occurrence without active skip history
            // must re-arm the occurrence even when no explicit clear list is supplied.
            if (jsRestoreOccurrences != null) {
                for (String occurrence : jsRestoreOccurrences) {
                    if (occurrence == null || occurrence.isEmpty()) continue;
                    if (!containsOccurrence(alreadyAppliedOccurrences, occurrence)) {
                        sync.remove(KEY_APPLIED_PREFIX + occurrence);
                    }
                }
            }

            if (alreadyAppliedOccurrences != null) {
                for (String occurrence : alreadyAppliedOccurrences) {
                    if (occurrence == null || occurrence.isEmpty()) continue;

                    AppliedMarker existing = readAppliedMarkerLocked(occurrence);
                    if (containsOccurrence(jsManualTakeOccurrences, occurrence)
                            || containsOccurrence(jsRestoreOccurrences, occurrence)) {
                        // The JS mutation is now the authoritative resolution for this
                        // occurrence. Keep it permanently applied so a later native
                        // alarm cannot deduct it again, but discard the native Auto
                        // source/amount because the native effect was compensated.
                        sync.putString(
                                KEY_APPLIED_PREFIX + occurrence,
                                buildMarkerJson(MARKER_SOURCE_JS, 0.0d));
                    } else if (existing.exists) {
                        // Preserve a native Auto marker (including its amount) so a
                        // later JS Restore can compensate the native effect if the
                        // occurrence is reversed after a race.
                        if (existing.nativeAuto) {
                            sync.putString(
                                    KEY_APPLIED_PREFIX + occurrence,
                                    buildMarkerJson(
                                            MARKER_SOURCE_AUTO,
                                            existing.deductedAmount));
                        } else {
                            sync.putString(
                                    KEY_APPLIED_PREFIX + occurrence,
                                    buildMarkerJson(MARKER_SOURCE_JS, 0.0d));
                        }
                    } else {
                        // Legacy/upgrade seed: JS state already contains this
                        // occurrence, so create a JS-owned marker without inventing
                        // any native deduction amount.
                        sync.putString(
                                KEY_APPLIED_PREFIX + occurrence,
                                buildMarkerJson(MARKER_SOURCE_JS, 0.0d));
                    }
                }
            }

            if (jsGeneration > lastGlobalJsGeneration) {
                sync.putLong(KEY_GLOBAL_JS_GENERATION, jsGeneration);
            }

            if (!sync.commit()) {
                return SyncResult.failure(
                        readVersionLocked(),
                        resultPills,
                        "shadow_sync_persist_failed");
            }

            return SyncResult.success(readVersionLocked(), resultPills);
        }
    }

    /**
     * Apply one exact Auto occurrence to native durable stock, idempotently.
     */
    public ApplyResult applyAutoDeduction(
            String medicationId,
            String doseId,
            String calendarDate,
            double requestedAmount) {
        if (medicationId == null || medicationId.trim().isEmpty()
                || doseId == null || doseId.trim().isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(requestedAmount)) {
            return ApplyResult.failure(0.0d, readVersion(), "invalid_request");
        }

        final String id = medicationId.trim();
        final String occurrence = AutoDeductionContract.occurrenceKey(
                id,
                doseId.trim(),
                calendarDate.trim());

        synchronized (LOCK) {
            final String medKey = KEY_MED_PREFIX + id;
            final String appliedKey = KEY_APPLIED_PREFIX + occurrence;

            AppliedMarker marker = readAppliedMarkerLocked(occurrence);
            if (marker.exists) {
                double current = readCurrentPillsLocked(id);
                return ApplyResult.success(
                        false,
                        current,
                        0.0d,
                        readVersionLocked());
            }

            String raw = prefs.getString(medKey, null);
            if (raw == null) {
                return ApplyResult.failure(0.0d, readVersionLocked(), "missing_medication");
            }

            try {
                JSONObject obj = new JSONObject(raw);
                double current = clamp(obj.optDouble("currentPills", 0.0d));
                double actual = Math.min(current, requestedAmount);
                double nextPills = clamp(current - actual);
                long nextVersion = readVersionLocked() + 1L;

                obj.put("currentPills", nextPills);
                if (!prefs.edit()
                        .putString(medKey, obj.toString())
                        .putString(
                                appliedKey,
                                buildMarkerJson(MARKER_SOURCE_AUTO, actual))
                        .putLong(KEY_VERSION, nextVersion)
                        .commit()) {
                    return ApplyResult.failure(
                            current,
                            readVersionLocked(),
                            "auto_deduction_persist_failed");
                }

                return ApplyResult.success(
                        true,
                        nextPills,
                        actual,
                        nextVersion);
            } catch (Exception e) {
                Log.e(TAG, "applyAutoDeduction failed for " + occurrence, e);
                return ApplyResult.failure(
                        readCurrentPillsLocked(id),
                        readVersionLocked(),
                        "auto_deduction_persist_failed");
            }
        }
    }

    /** Return the current native execution shadow for one medication. */
    public MedicationState getMedication(String medicationId) {
        if (medicationId == null || medicationId.trim().isEmpty()) return null;
        synchronized (LOCK) {
            String id = medicationId.trim();
            String raw = prefs.getString(KEY_MED_PREFIX + id, null);
            if (raw == null) return null;
            try {
                JSONObject obj = new JSONObject(raw);
                return new MedicationState(
                        id,
                        clamp(obj.optDouble("currentPills", 0.0d)),
                        obj.optLong("lastJsGeneration", -1L));
            } catch (Exception e) {
                return null;
            }
        }
    }

    public static final class OccurrenceSnapshot {
        public final boolean exists;
        public final boolean nativeAuto;
        public final double deductedAmount;
        public final double currentPills;

        private OccurrenceSnapshot(
                boolean exists,
                boolean nativeAuto,
                double deductedAmount,
                double currentPills) {
            this.exists = exists;
            this.nativeAuto = nativeAuto;
            this.deductedAmount = deductedAmount;
            this.currentPills = currentPills;
        }
    }

    /**
     * Read-only occurrence execution state used when exposing FIRED events to JS.
     * It never mutates the ledger, so listFiredEvents remains a pure read boundary.
     */
    public OccurrenceSnapshot getOccurrenceSnapshot(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.trim().isEmpty()
                || doseId == null || doseId.trim().isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return new OccurrenceSnapshot(false, false, 0.0d, 0.0d);
        }
        final String occurrence = AutoDeductionContract.occurrenceKey(
                medicationId.trim(), doseId.trim(), calendarDate.trim());
        synchronized (LOCK) {
            AppliedMarker marker = readAppliedMarkerLocked(occurrence);
            if (!marker.exists) {
                return new OccurrenceSnapshot(false, false, 0.0d, 0.0d);
            }
            return new OccurrenceSnapshot(
                    true,
                    marker.nativeAuto,
                    marker.deductedAmount,
                    readCurrentPillsLocked(medicationId.trim()));
        }
    }

    public Map<String, Double> readAllCurrentPills() {
        synchronized (LOCK) {
            return readAllCurrentPillsLocked();
        }
    }

    public long getVersion() {
        return readVersion();
    }

    /**
     * Repair helper: apply every currently-FIRED occurrence supplied by the caller.
     * Used at the background-to-JS recovery boundary when a process died between
     * FIRED persistence and native stock application.
     */
    public ApplyResult applyEventIfNeeded(
            String medicationId,
            String doseId,
            String calendarDate,
            double amount) {
        return applyAutoDeduction(
                medicationId,
                doseId,
                calendarDate,
                amount);
    }

    private static final class AppliedMarker {
        final boolean exists;
        final boolean nativeAuto;
        final double deductedAmount;

        AppliedMarker(boolean exists, boolean nativeAuto, double deductedAmount) {
            this.exists = exists;
            this.nativeAuto = nativeAuto;
            this.deductedAmount = deductedAmount;
        }
    }

    private AppliedMarker readAppliedMarkerLocked(String occurrence) {
        return readAppliedMarkerLocked(occurrence, prefs.getAll());
    }

    private static AppliedMarker readAppliedMarkerLocked(
            String occurrence,
            Map<String, ?> snapshot) {
        if (occurrence == null || occurrence.isEmpty()) {
            return new AppliedMarker(false, false, 0.0d);
        }
        Object rawValue = snapshot.get(KEY_APPLIED_PREFIX + occurrence);
        if (rawValue instanceof Boolean) {
            return ((Boolean) rawValue)
                    ? new AppliedMarker(true, false, 0.0d)
                    : new AppliedMarker(false, false, 0.0d);
        }
        if (!(rawValue instanceof String)) {
            return new AppliedMarker(false, false, 0.0d);
        }
        try {
            JSONObject obj = new JSONObject((String) rawValue);
            String source = obj.optString("source", MARKER_SOURCE_JS);
            double amount = obj.optDouble("deductedAmount", 0.0d);
            double normalizedAmount =
                    Double.isFinite(amount) && amount >= 0.0d ? amount : 0.0d;
            return new AppliedMarker(
                    true,
                    MARKER_SOURCE_AUTO.equals(source),
                    normalizedAmount);
        } catch (Exception e) {
            return new AppliedMarker(true, false, 0.0d);
        }
    }

    private static boolean containsOccurrence(Set<String> set, String occurrence) {
        return set != null && occurrence != null && set.contains(occurrence);
    }

    private static boolean isOccurrenceForMedication(String occurrence, String medicationId) {
        if (occurrence == null || medicationId == null) return false;
        return occurrence.startsWith(medicationId + "\u001f");
    }

    private static String buildMarkerJson(String source, double deductedAmount) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("source", source);
            obj.put("deductedAmount", Math.max(0.0d, deductedAmount));
            return obj.toString();
        } catch (Exception e) {
            return "{\"source\":\"" + MARKER_SOURCE_JS + "\",\"deductedAmount\":0}";
        }
    }

    private long readVersion() {
        synchronized (LOCK) {
            return readVersionLocked();
        }
    }

    private long readVersionLocked() {
        long value = prefs.getLong(KEY_VERSION, 0L);
        return value < 0L ? 0L : value;
    }

    private double readCurrentPillsLocked(String medicationId) {
        String raw = prefs.getString(KEY_MED_PREFIX + medicationId, null);
        if (raw == null) return 0.0d;
        try {
            return clamp(new JSONObject(raw).optDouble("currentPills", 0.0d));
        } catch (Exception e) {
            return 0.0d;
        }
    }

    private Map<String, Double> readAllCurrentPillsLocked() {
        Map<String, Double> out = new HashMap<>();
        Map<String, ?> all = prefs.getAll();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            if (!entry.getKey().startsWith(KEY_MED_PREFIX)) continue;
            Object raw = entry.getValue();
            if (!(raw instanceof String)) continue;
            try {
                JSONObject obj = new JSONObject((String) raw);
                out.put(
                        entry.getKey().substring(KEY_MED_PREFIX.length()),
                        clamp(obj.optDouble("currentPills", 0.0d)));
            } catch (Exception ignored) {
            }
        }
        return out;
    }

    private static double clamp(double value) {
        if (!Double.isFinite(value) || value <= 0.0d) {
            return value <= 0.0d ? 0.0d : 0.0d;
        }
        return value;
    }
}