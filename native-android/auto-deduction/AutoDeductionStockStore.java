package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;

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
    private static final String KEY_FOREGROUND_OCCURRENCE_PREFIX = "foreground:";
    private static final String KEY_LAST_FOREGROUND_SEQ = "lastForegroundMutationSeq";
    private static final String KEY_STOCK_INITIALIZED = "stockInitialized";
    private static final char KEY_SEPARATOR = '\u001f';

    private static final Object LOCK = new Object();

    private final SharedPreferences prefs;
    private final AutoDeductionFailurePolicy failurePolicy;

    public AutoDeductionStockStore(Context context) {
        this(context, AutoDeductionFailurePolicy.ALLOW_ALL);
    }

    AutoDeductionStockStore(
            Context context,
            AutoDeductionFailurePolicy failurePolicy) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.failurePolicy = failurePolicy == null
                ? AutoDeductionFailurePolicy.ALLOW_ALL
                : failurePolicy;
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

    public static final class OccurrenceResolution {
        public enum Type {
            CONSUMED,
            SKIPPED
        }

        public final String medicationId;
        public final String doseId;
        public final String calendarDate;
        public final Type type;

        public OccurrenceResolution(
                String medicationId,
                String doseId,
                String calendarDate,
                Type type
        ) {
            this.medicationId = medicationId;
            this.doseId = doseId;
            this.calendarDate = calendarDate;
            this.type = type;
        }
    }

    /**
     * Seed only missing medication balances, then return authoritative Native
     * balances for the requested medication IDs. Existing Native balances are
     * never overwritten by the JavaScript snapshot.
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
                    } else if (readStockLocked(seed.medicationId) == null) {
                        // A present-but-invalid Native row must never be treated
                        // as an absent row and silently replaced by JS. Fail
                        // closed so a corrupted balance cannot be guessed.
                        return SnapshotResult.failure("invalid_native_stock");
                    }
                }
            }

            // The durable Native stock baseline (#493): the seeds and the
            // stockInitialized flag are committed atomically, and lifecycle
            // recovery is gated on isInitialized(). The synchronous outcome
            // therefore matters — recovery may only run after this durable
            // baseline exists, and its failure is reported to the caller.
            editor.putBoolean(KEY_STOCK_INITIALIZED, true);
            if (!editor.commit()) {
                return SnapshotResult.failure(
                        changed ? "stock_seed_commit_failed" : "stock_init_commit_failed");
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

    public boolean isInitialized() {
        synchronized (LOCK) {
            return prefs.getBoolean(KEY_STOCK_INITIALIZED, false);
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
     * Apply one exact Auto occurrence exactly once. The occurrence marker and
     * the resulting stock balance are committed in one atomic SharedPreferences
     * transaction (#493): the synchronous outcome drives the AutoApplyResult
     * contract, and a lost write would either re-deduct stock or leave a
     * deduction without its idempotency marker. Re-delivery therefore returns
     * the original actualDeducted amount without subtracting again.
     *
     * <p>Safe default for direct/non-recovery callers. Old occurrences are
     * rejected unless an existing marker/resolution already proves idempotent
     * completion.</p>
     */
    public AutoApplyResult applyAutoDeduction(
            String medicationId,
            String doseId,
            String calendarDate,
            double requestedAmount
    ) {
        return applyAutoDeductionInternal(
                medicationId, doseId, calendarDate, requestedAmount, true);
    }

    /**
     * Explicitly authorized historical recovery path for durable FIRED evidence.
     * Only native recovery/reconciliation code should use this entry point.
     */
    public AutoApplyResult applyAutoDeductionForRecovery(
            String medicationId,
            String doseId,
            String calendarDate,
            double requestedAmount
    ) {
        return applyAutoDeductionInternal(
                medicationId, doseId, calendarDate, requestedAmount, false);
    }

    private AutoApplyResult applyAutoDeductionInternal(
            String medicationId,
            String doseId,
            String calendarDate,
            double requestedAmount,
            boolean rejectStaleDirectApply
    ) {
        if (!isValidId(medicationId)
                || !isValidId(doseId)
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
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
                if (!Double.isFinite(actual) || actual < 0.0) {
                    return AutoApplyResult.failure("invalid_auto_marker");
                }
                Double current = readStockLocked(medicationId);
                if (current == null) {
                    return AutoApplyResult.failure("stock_not_initialized");
                }
                return AutoApplyResult.alreadyApplied(actual, current);
            }

            // A foreground Take/Restore for this exact occurrence is already
            // reflected in Native stock. The upcoming Auto alarm must not deduct
            // the same occurrence again. The resolution is committed atomically
            // with the foreground stock delta.
            String foregroundResolution =
                    prefs.getString(foregroundOccurrenceKey(
                            medicationId, doseId, calendarDate), null);
            if (foregroundResolution != null) {
                Double current = readStockLocked(medicationId);
                if (current == null) {
                    return AutoApplyResult.failure("stock_not_initialized");
                }
                return AutoApplyResult.alreadyApplied(0.0, current);
            }

            if (rejectStaleDirectApply
                    && AutoDeductionDateTime.isOlderThanLocalDays(
                            calendarDate,
                            AutoDeductionContract.DIRECT_AUTO_STOCK_MAX_AGE_DAYS)) {
                return AutoApplyResult.failure("stale_auto_occurrence");
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
            List<StockDelta> deltas,
            List<OccurrenceResolution> resolutions
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
            if (resolutions != null) {
                for (OccurrenceResolution resolution : resolutions) {
                    if (!isValidResolution(resolution)) {
                        return ForegroundApplyResult.failure("invalid_occurrence_resolution");
                    }
                    editor.putString(
                            foregroundOccurrenceKey(
                                    resolution.medicationId,
                                    resolution.doseId,
                                    resolution.calendarDate),
                            resolution.type.name());
                }
            }
            for (Map.Entry<String, Double> entry : nextValues.entrySet()) {
                editor.putString(entry.getKey().startsWith(KEY_STOCK_PREFIX)
                        ? entry.getKey()
                        : stockKey(entry.getKey()), encode(entry.getValue()));
            }
            editor.putLong(KEY_LAST_FOREGROUND_SEQ, mutationSeq);
            editor.putBoolean(KEY_STOCK_INITIALIZED, true);

            // Synchronous commit (#493): the mutation sequence is the
            // idempotency fence and is durable only in the same transaction as
            // the deltas it covers; an asynchronously lost write would let a
            // foreground retry re-apply the same deltas on top of the already
            // mutated balance. The explicit outcome drives the
            // ForegroundApplyResult contract.
            if (!editor.commit()) {
                return ForegroundApplyResult.failure("foreground_stock_commit_failed");
            }
            return ForegroundApplyResult.success(readAllStocksLocked());
        }
    }

    private static boolean isValidResolution(OccurrenceResolution resolution) {
        return resolution != null
                && isValidId(resolution.medicationId)
                && isValidId(resolution.doseId)
                && resolution.calendarDate != null
                && AutoDeductionContract.isValidCalendarDate(resolution.calendarDate)
                && resolution.type != null;
    }

    private static String foregroundOccurrenceKey(
            String medicationId,
            String doseId,
            String calendarDate
    ) {
        return KEY_FOREGROUND_OCCURRENCE_PREFIX
                + medicationId + KEY_SEPARATOR + doseId + KEY_SEPARATOR + calendarDate;
    }

    public static final class CompactionResult {
        public final boolean ok;
        public final int removed;
        public final String error;

        private CompactionResult(boolean ok, int removed, String error) {
            this.ok = ok;
            this.removed = removed;
            this.error = error;
        }

        static CompactionResult success(int removed) {
            return new CompactionResult(true, removed, null);
        }

        static CompactionResult failure(String error, int removed) {
            return new CompactionResult(
                    false,
                    removed,
                    error != null && !error.isEmpty()
                            ? error
                            : "terminal_marker_compaction_failed");
        }
    }

    /**
     * Compact occurrence markers older than the current local day when there is
     * no active schedule for that occurrence. Active schedules stay protected so
     * a delayed duplicate delivery can still be rejected idempotently. The result
     * distinguishes successful zero-row work from a failed persistence commit.
     */
    public CompactionResult compactTerminalOccurrenceMarkers(
            String cutoffCalendarDate,
            java.util.Set<String> protectedOccurrenceKeys) {
        if (!AutoDeductionContract.isValidCalendarDate(cutoffCalendarDate)) {
            return CompactionResult.failure("invalid_cutoff", 0);
        }
        synchronized (LOCK) {
            SharedPreferences.Editor editor = null;
            int removed = 0;
            for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
                String key = entry.getKey();
                if (key == null || !(entry.getValue() instanceof String)) continue;
                String occurrenceKey = null;
                if (key.startsWith(KEY_AUTO_PREFIX)) {
                    occurrenceKey = key.substring(KEY_AUTO_PREFIX.length());
                } else if (key.startsWith(KEY_FOREGROUND_OCCURRENCE_PREFIX)) {
                    occurrenceKey = key.substring(KEY_FOREGROUND_OCCURRENCE_PREFIX.length());
                }
                if (occurrenceKey == null || occurrenceKey.isEmpty()
                        || (protectedOccurrenceKeys != null
                        && protectedOccurrenceKeys.contains(occurrenceKey))) {
                    continue;
                }
                int sep = occurrenceKey.lastIndexOf(
                        KEY_SEPARATOR);
                if (sep <= 0 || sep >= occurrenceKey.length() - 1) continue;
                String calendarDate = occurrenceKey.substring(sep + 1);
                if (!AutoDeductionContract.isValidCalendarDate(calendarDate)
                        || calendarDate.compareTo(cutoffCalendarDate) >= 0) {
                    continue;
                }
                if (editor == null) editor = prefs.edit();
                editor.remove(key);
                removed++;
            }
            if (editor != null) {
                // Synchronous commit (#493): the explicit outcome is part of
                // the CompactionResult contract consumed by the terminal-state
                // sweep (AutoDeductionOccurrenceState); a failed sweep must be
                // observable rather than reported as a successful no-op.
                if (!failurePolicy.allowTerminalStateCompactionCommit()
                        || !editor.commit()) {
                    return CompactionResult.failure(
                            "terminal_marker_compaction_commit_failed",
                            removed);
                }
            }
            return CompactionResult.success(removed);
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
