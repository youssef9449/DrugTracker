package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Auto-owned durable stock authority.
 *
 * <p>This is intentionally smaller than a second Medication store. It keeps
 * only the live currentPills balance per medication, occurrence-specific Auto
 * application markers, and the last foreground mutation sequence already
 * applied to Native stock.</p>
 *
 * <p>The JavaScript Medication object remains the UI/cache representation.
 * Whenever JS is available it is converged from this native balance. Native
 * Auto execution uses this store directly so it can mutate stock while the
 * WebView/process is unavailable.</p>
 */
public final class AutoDeductionStockStore {

    private static final String PREFS_NAME = "drugtracker_auto_stock_v1";
    private static final String KEY_STOCK_PREFIX = "stock:";
    private static final String KEY_AUTO_PREFIX = "auto:";
    private static final String KEY_LAST_FOREGROUND_SEQ = "lastForegroundMutationSeq";
    private static final char KEY_SEPARATOR = '\u001f';

    private static final Object LOCK = new Object();

    private final SharedPreferences prefs;

    public AutoDeductionStockStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static final class StockSeed {
        public final String medicationId;
        public final double currentPills;

        public StockSeed(String medicationId, double currentPills) {
            this.medicationId = medicationId;
            this.currentPills = currentPills;
        }
    }

    public static final class SnapshotResult {
        public final boolean ok;
        public final Map<String, Double> stocks;
        public final String error;

        private SnapshotResult(boolean ok, Map<String, Double> stocks, String error) {
            this.ok = ok;
            this.stocks = stocks;
            this.error = error;
        }

        public static SnapshotResult success(Map<String, Double> stocks) {
            return new SnapshotResult(true, stocks, null);
        }

        public static SnapshotResult failure(String error) {
            return new SnapshotResult(
                    false,
                    new LinkedHashMap<String, Double>(),
                    error != null && !error.isEmpty() ? error : "stock_snapshot_failed");
        }
    }

    public static final class AutoApplyResult {
        public final boolean ok;
        public final boolean applied;
        public final double actualDeducted;
        public final double currentPills;
        public final String error;

        private AutoApplyResult(
                boolean ok,
                boolean applied,
                double actualDeducted,
                double currentPills,
                String error
        ) {
            this.ok = ok;
            this.applied = applied;
            this.actualDeducted = actualDeducted;
            this.currentPills = currentPills;
            this.error = error;
        }

        public static AutoApplyResult applied(double actualDeducted, double currentPills) {
            return new AutoApplyResult(true, true, actualDeducted, currentPills, null);
        }

        public static AutoApplyResult alreadyApplied(
                double actualDeducted,
                double currentPills
        ) {
            return new AutoApplyResult(true, false, actualDeducted, currentPills, null);
        }

        public static AutoApplyResult failure(String error) {
            return new AutoApplyResult(false, false, 0.0, 0.0,
                    error != null && !error.isEmpty() ? error : "auto_stock_failed");
        }
    }

    public static final class ForegroundApplyResult {
        public final boolean ok;
        public final boolean alreadyApplied;
        public final Map<String, Double> stocks;
        public final String error;

        private ForegroundApplyResult(
                boolean ok,
                boolean alreadyApplied,
                Map<String, Double> stocks,
                String error
        ) {
            this.ok = ok;
            this.alreadyApplied = alreadyApplied;
            this.stocks = stocks;
            this.error = error;
        }

        public static ForegroundApplyResult success(Map<String, Double> stocks) {
            return new ForegroundApplyResult(
                    true, false, stocks, null);
        }

        public static ForegroundApplyResult alreadyApplied(Map<String, Double> stocks) {
            return new ForegroundApplyResult(
                    true, true, stocks, null);
        }

        public static ForegroundApplyResult failure(String error) {
            return new ForegroundApplyResult(
                    false,
                    false,
                    new LinkedHashMap<String, Double>(),
                    error != null && !error.isEmpty() ? error : "foreground_stock_failed");
        }
    }

    public static final class StockDelta {
        public final String medicationId;
        public final double delta;

        public StockDelta(String medicationId, double delta) {
            this.medicationId = medicationId;
            this.delta = delta;
        }
    }

    /**
     * Seed only missing medication balances, then return the authoritative native
     * balances for exactly the requested medication IDs.
     *
     * <p>An existing native value is never overwritten by a JS snapshot. That
     * rule is what prevents a stale localStorage value from erasing an Auto
     * deduction that happened while JS was unavailable.</p>
     */
    public SnapshotResult ensureMissingAndRead(List<StockSeed> seeds) {
        synchronized (LOCK) {
            SharedPreferences.Editor editor = prefs.edit();
            boolean changed = false;

            if (seeds != null) {
                for (StockSeed seed : seeds) {
                    if (!isValidId(seed != null ? seed.medicationId : null)) continue;
                    if (!isValidStock(seed.currentPills)) continue;
                    String key = stockKey(seed.medicationId);
                    if (!prefs.contains(key)) {
                        editor.putString(key, encode(seed.currentPills));
                        changed = true;
                    }
                }
            }

            if (changed && !editor.commit()) {
                return SnapshotResult.failure("stock_seed_commit_failed");
            }

            Map<String, Double> out = new LinkedHashMap<String, Double>();
            if (seeds != null) {
                for (StockSeed seed : seeds) {
                    if (!isValidId(seed != null ? seed.medicationId : null)) continue;
                    Double value = readStockLocked(seed.medicationId);
                    if (value != null) {
                        out.put(seed.medicationId, value);
                    }
                }
            }
            return SnapshotResult.success(out);
        }
    }

    /** Read all native stock balances (used only by diagnostics/tests). */
    public SnapshotResult readAll() {
        synchronized (LOCK) {
            Map<String, Double> out = new LinkedHashMap<String, Double>();
            Map<String, ?> all = prefs.getAll();
            for (Map.Entry<String, ?> entry : all.entrySet()) {
                if (!entry.getKey().startsWith(KEY_STOCK_PREFIX)) continue;
                if (!(entry.getValue() instanceof String)) continue;
                String medicationId = entry.getKey().substring(KEY_STOCK_PREFIX.length());
                try {
                    double value = Double.parseDouble((String) entry.getValue());
                    if (isValidStock(value)) {
                        out.put(medicationId, value);
                    }
                } catch (NumberFormatException ignored) {
                    // Invalid rows are ignored by the diagnostic snapshot.
                }
            }
            return SnapshotResult.success(out);
        }
    }

    /**
     * Apply one exact Auto occurrence exactly once.
     *
     * <p>The occurrence marker and the resulting stock balance are committed in
     * one SharedPreferences transaction. Re-delivery therefore returns the
     * original actualDeducted amount without subtracting again.</p>
     */
    public AutoApplyResult applyAutoDeduction(
            String medicationId,
            String doseId,
            String calendarDate,
            double requestedAmount
    ) {
        if (!isValidId(medicationId)
                || !isValidId(doseId)
                || calendarDate == null
                || calendarDate.trim().isEmpty()
                || !AutoDeductionContract.isValidAmount(requestedAmount)) {
            return AutoApplyResult.failure("invalid_auto_stock_args");
        }

        final String occurrenceKey =
                medicationId + KEY_SEPARATOR + doseId + KEY_SEPARATOR + calendarDate;
        final String autoKey = KEY_AUTO_PREFIX + occurrenceKey;

        synchronized (LOCK) {
            String markerRaw = prefs.getString(autoKey, null);
            if (markerRaw != null) {
                double actual;
                try {
                    actual = Double.parseDouble(markerRaw);
                } catch (NumberFormatException e) {
                    return AutoApplyResult.failure("invalid_auto_marker");
                }
                Double current = readStockLocked(medicationId);
                if (current == null) {
                    return AutoApplyResult.failure("stock_not_initialized");
                }
                return AutoApplyResult.alreadyApplied(actual, current);
            }

            Double currentObj = readStockLocked(medicationId);
            if (currentObj == null) {
                return AutoApplyResult.failure("stock_not_initialized");
            }

            double current = Math.max(0.0, currentObj.doubleValue());
            double actual = Math.min(requestedAmount, current);
            double next = Math.max(0.0, current - actual);

            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(stockKey(medicationId), encode(next));
            editor.putString(autoKey, encode(actual));
            if (!editor.commit()) {
                return AutoApplyResult.failure("auto_stock_commit_failed");
            }

            return AutoApplyResult.applied(actual, next);
        }
    }

    /**
     * Apply one foreground stock mutation as signed deltas.
     *
     * <p>The delta model is deliberate: an Auto alarm may fire between the JS
     * snapshot and this foreground write. Applying the user's signed delta to
     * the then-current native balance preserves both mutations; an absolute
     * "set currentPills" would risk overwriting the Auto deduction.</p>
     *
     * <p>The mutation sequence makes retry/recovery idempotent.</p>
     */
    public ForegroundApplyResult applyForegroundDeltas(
            long mutationSeq,
            List<StockDelta> deltas
    ) {
        if (mutationSeq <= 0L) {
            return ForegroundApplyResult.failure("invalid_mutation_seq");
        }

        synchronized (LOCK) {
            long last = prefs.getLong(KEY_LAST_FOREGROUND_SEQ, 0L);
            if (mutationSeq <= last) {
                return ForegroundApplyResult.alreadyApplied(readAllStocksLocked());
            }

            Map<String, Double> nextValues = new LinkedHashMap<String, Double>();
            if (deltas != null) {
                for (StockDelta delta : deltas) {
                    if (delta == null || !isValidId(delta.medicationId)
                            || !Double.isFinite(delta.delta)) {
                        return ForegroundApplyResult.failure("invalid_stock_delta");
                    }

                    Double existingObj = readStockLocked(delta.medicationId);
                    if (existingObj == null) {
                        // A positive delta can initialize a newly-added medication
                        // from zero. A negative delta cannot safely invent a balance.
                        if (delta.delta < 0.0) {
                            return ForegroundApplyResult.failure("stock_not_initialized");
                        }
                        existingObj = 0.0;
                    }

                    double base = Math.max(0.0, existingObj.doubleValue());
                    Double previous = nextValues.get(delta.medicationId);
                    if (previous != null) {
                        base = previous.doubleValue();
                    }
                    nextValues.put(
                            delta.medicationId,
                            Math.max(0.0, base + delta.delta));
                }
            }

            SharedPreferences.Editor editor = prefs.edit();
            for (Map.Entry<String, Double> entry : nextValues.entrySet()) {
                editor.putString(entry.getKey().startsWith(KEY_STOCK_PREFIX)
                        ? entry.getKey()
                        : stockKey(entry.getKey()), encode(entry.getValue()));
            }
            editor.putLong(KEY_LAST_FOREGROUND_SEQ, mutationSeq);

            if (!editor.commit()) {
                return ForegroundApplyResult.failure("foreground_stock_commit_failed");
            }
            return ForegroundApplyResult.success(readAllStocksLocked());
        }
    }

    private Map<String, Double> readAllStocksLocked() {
        Map<String, Double> out = new LinkedHashMap<String, Double>();
        Map<String, ?> all = prefs.getAll();
        for (Map.Entry<String, ?> entry : all.entrySet()) {
            String key = entry.getKey();
            if (!key.startsWith(KEY_STOCK_PREFIX) || !(entry.getValue() instanceof String)) {
                continue;
            }
            String medicationId = key.substring(KEY_STOCK_PREFIX.length());
            try {
                double value = Double.parseDouble((String) entry.getValue());
                if (isValidStock(value)) {
                    out.put(medicationId, value);
                }
            } catch (NumberFormatException ignored) {
                // Ignore malformed diagnostic rows.
            }
        }
        return out;
    }

    private Double readStockLocked(String medicationId) {
        String raw = prefs.getString(stockKey(medicationId), null);
        if (raw == null) return null;
        try {
            double value = Double.parseDouble(raw);
            return isValidStock(value) ? value : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static boolean isValidId(String id) {
        return id != null && !id.trim().isEmpty();
    }

    private static boolean isValidStock(double value) {
        return Double.isFinite(value) && value >= 0.0;
    }

    private static String stockKey(String medicationId) {
        return KEY_STOCK_PREFIX + medicationId;
    }

    private static String encode(double value) {
        // Avoid persisting negative zero, which is semantically identical to zero
        // but can create needless JS/native snapshot differences.
        double normalized = value == 0.0 ? 0.0 : value;
        return Double.toString(normalized);
    }
}
