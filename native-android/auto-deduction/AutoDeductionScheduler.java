package app.drugtracker.autodeduction;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;


/**
 * Auto Deduction business/recovery service. Exact Alarm Android scheduling
 * mechanics live behind AutoDeductionSchedulingAdapter → ExactAlarmRuntime;
 * this class owns recurrence authorization, FIRED/recovery, catch-up,
 * cancellation policy, retry evidence, amount authority, and recovery snapshots.
 *
 * Auto business state:
 *   recurrence authorization, FIRED/RECONCILED semantics, catch-up, fire retry,
 *   amount authority, and cancellation policy remain here.
 *
 * Fire/cancel linearization:
 *   SCHEDULE_LOCK remains the common serialization boundary between Auto's
 *   durable FIRED/event-store transitions and the scheduling adapter so exactly
 *   one fire/cancel operation linearizes first. The adapter then delegates the
 *   actual AlarmManager transaction to ExactAlarmRuntime.
 *
 * Native scheduling identity and PendingIntent mechanics are not implemented here;
 * AutoDeductionSchedulingAdapter translates the feature identity and payload into
 * the shared runtime request.
 *
 * Fire-vs-cancel linearization (same SCHEDULE_LOCK):
 *   fireOccurrenceIfNotCancelled performs the effective-cancellation check and
 *   the durable FIRED/pending transition under one continuous critical section
 *   shared with cancelOccurrence. Exactly one of fire or cancel linearizes first.
 *   If cancel linearizes first, a stale alarm delivery cannot create FIRED/pending
 *   or advance recurrence. If fire linearizes first, a later cancel cannot
 *   retroactively erase that fire.
 *   Lock order is always SCHEDULE_LOCK then (nested) EventStore.LOCK — never the
 *   reverse — so nesting cannot deadlock.
 *
 * operationVersion is the shared generic ownership guard for rollback (with
 * only the current operationVersion contract). It guards
 * concurrent metadata replacement and is NOT a medication-level disable epoch.
 *
 * Recurrence authorization (Issue #217):
 *   PREFS_RECURRENCE_AUTH holds a monotonic generation per (medicationId, doseId).
 *   scheduleOccurrence carries the active generation in delivery extras only; new
 *   Shared schedule metadata contains no Auto recurrence-authorization state.
 *   invalidateRecurrenceAuthorization bumps the generation under SCHEDULE_LOCK and
 *   cancels all future scheduled occurrences for that dose slot so post-fire
 *   scheduleNextOccurrenceIfAbsent cannot create D+1 after disable, and restore
 *   cannot resurrect a pre-disable successor.
 *
 * Does not use polling, WorkManager periodic, or foreground services.
 */
public final class AutoDeductionScheduler {

    private static final String TAG = "AutoDeductionScheduler";
    /** JSON/Intent field: medication+dose recurrence authorization generation. */
    public static final String FIELD_RECURRENCE_GENERATION = "recurrenceGeneration";

    /** Auto-owned serialization boundary for business/recovery mutations. */
    private static final Object SCHEDULE_LOCK = new Object();

    private final Context appContext;
    /** Active recurrence generation per (medicationId, doseId) — Issue #217. */
    private final SharedPreferences recurrenceAuthPrefs;
    /**
     * Independent fire-failure / retry evidence (not schedule metadata).
     * Survives config mutation that removes shared schedule rows.
     */
    private final SharedPreferences fireRetryPrefs;
    /** Single Auto-specific scheduling boundary over the shared exact-alarm runtime. */
    private final AutoDeductionSchedulingAdapter schedulingAdapter;
    /**
     * Test-only: when true, {@link #invalidateRecurrenceAuthorization} treats the
     * generation commit as failed (fail-closed). Production code never sets this.
     */
    volatile boolean forceRecurrenceAuthCommitFailureForTest = false;
    /**
     * Test-only: when true, the cancellation tombstone write commit is forced to
     * fail (no tombstone written) to exercise Issue #241 fail-closed behavior.
     */
    volatile boolean forceTombstoneCommitFailureForTest = false;
    /**
     * Test-only: when true, schedule metadata removal commit is forced to fail
     * to exercise Issue #241 fail-closed behavior (the tombstone remains as the
     * durable stale-fire guard until retry completes cleanup).
     */
    volatile boolean forceScheduleMetadataRemovalFailureForTest = false;
    /** Test-only: force restoreFutureSchedules to report ok=false. */
    volatile boolean forceRestoreFutureFailureForTest = false;
    /**
     * Test-only: force failure of independent fire-retry evidence commit.
     */
    volatile boolean forceFireRetryEvidenceCommitFailureForTest = false;
    /**
     * Test-only: when true, the shared runtime's durable operation-version
     * allocation is forced to fail
     * (simulating a durable ordering-token allocation failure) to exercise the
     * Issue #241 fail-closed path. Production never sets this; the durable
     * ordering-token semantics are unchanged when it is false.
     */
    volatile boolean forceOrderingTokenAllocationFailureForTest = false;

    /**
     * Test-only: when non-null, multi-day catch-up treats this as wall-clock "now"
     * (Issue #243 determinism). Production leaves null → System.currentTimeMillis().
     */
    volatile Long recoveryNowOverrideForTest = null;

    /** Wall-clock "now" for recovery; overridable in tests. */
    private long recoveryNowMs() {
        Long o = recoveryNowOverrideForTest;
        return o != null ? o.longValue() : System.currentTimeMillis();
    }

    /**
     * Test-only: CountDownLatch pair to interleave invalidate between generation
     * authorization and locked successor install. Production leaves null.
     */
    volatile java.util.concurrent.CountDownLatch recoveryBeforeSuccessorInstallLatchForTest = null;
    volatile java.util.concurrent.CountDownLatch recoveryResumeSuccessorInstallLatchForTest = null;

    public AutoDeductionScheduler(Context context) {
        this.appContext = context.getApplicationContext();
        this.recurrenceAuthPrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, Context.MODE_PRIVATE);
        this.fireRetryPrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_FIRE_RETRY, Context.MODE_PRIVATE);
        this.schedulingAdapter = new AutoDeductionSchedulingAdapter(appContext);
    }

    private void syncAlarmRuntimeTestControls() {
        schedulingAdapter.forceOrderingTokenAllocationFailureForTest =
                forceOrderingTokenAllocationFailureForTest;
        schedulingAdapter.forceTombstoneCommitFailureForTest =
                forceTombstoneCommitFailureForTest;
        schedulingAdapter.forceScheduleMetadataRemovalFailureForTest =
                forceScheduleMetadataRemovalFailureForTest;
        schedulingAdapter.syncTestControls();
    }


    // ── Recurrence authorization (Issue #217) ─────────────────────────────

    private static String recurrenceAuthKey(String medicationId, String doseId) {
        return AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                + AutoDeductionContract.scheduleIdentityKey(medicationId, doseId);
    }

    /**
     * Read active recurrence generation for a dose slot. Caller must hold
     * {@link #SCHEDULE_LOCK}. Returns 0 when never scheduled/invalidated.
     */
    long getRecurrenceGenerationLocked(String medicationId, String doseId) {
        return recurrenceAuthPrefs.getLong(recurrenceAuthKey(medicationId, doseId), 0L);
    }

    /**
     * Under {@link #SCHEDULE_LOCK}: whether successor creation is still authorized.
     * Requires {@code expectedGeneration > 0} and equality with the durable active
     * recurrence generation for this medicationId + doseId.
     */
    private boolean isRecurrenceGenerationAuthorizedLocked(
            String medicationId,
            String doseId,
            long expectedGeneration
    ) {
        long active = getRecurrenceGenerationLocked(medicationId, doseId);
        return expectedGeneration > 0L && expectedGeneration == active;
    }

    /**
     * Ensure a non-zero active generation exists for the dose slot (first schedule).
     * Caller must hold {@link #SCHEDULE_LOCK}.
     */
    long ensureRecurrenceGenerationLocked(String medicationId, String doseId) {
        String key = recurrenceAuthKey(medicationId, doseId);
        long g = recurrenceAuthPrefs.getLong(key, 0L);
        if (g > 0L) {
            return g;
        }
        g = 1L;
        if (!recurrenceAuthPrefs.edit().putLong(key, g).commit()) {
            Log.e(TAG, "ensureRecurrenceGenerationLocked: commit failed for " + key);
            return 0L;
        }
        return g;
    }

    /**
     * Bump active recurrence generation under {@link #SCHEDULE_LOCK} and cancel every
     * durable scheduled occurrence for this medication+dose slot (alarms + metadata).
     *
     * <p>Linearizes before any concurrent {@link #scheduleNextOccurrenceIfAbsent}:
     * after this returns, a receiver holding a pre-bump generation cannot create D+1,
     * and already-installed successors are cancelled so lifecycle restore cannot
     * resurrect them (their stamped generation is no longer active).
     */
    /**
     * Bump active recurrence generation under {@link #SCHEDULE_LOCK} and, only on
     * durable commit success, cancel every scheduled occurrence for this dose slot.
     *
     * <p><b>Fail-closed:</b> if the generation {@code commit()} fails, this method
     * returns {@code ok=false}, does <em>not</em> treat the chain as invalidated,
     * and does <em>not</em> cancel futures (a concurrent receiver with the old
     * generation could otherwise still create D+1 while callers believed disable
     * succeeded). Callers must retry until {@code ok=true}.
     */
    public InvalidateResult invalidateRecurrenceAuthorization(
            String medicationId,
            String doseId
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()) {
            return InvalidateResult.fail("invalid_args");
        }
        synchronized (SCHEDULE_LOCK) {
            String authKey = recurrenceAuthKey(medicationId, doseId);
            long prev = recurrenceAuthPrefs.getLong(authKey, 0L);
            long next = prev <= 0L ? 1L : prev + 1L;
            boolean committed = !forceRecurrenceAuthCommitFailureForTest
                    && recurrenceAuthPrefs.edit().putLong(authKey, next).commit();
            if (!committed) {
                Log.e(TAG, "invalidateRecurrenceAuthorization: generation commit failed for "
                        + medicationId + "/" + doseId
                        + " — fail-closed (no cancel, generation unchanged=" + prev + ")");
                return InvalidateResult.fail("recurrence_generation_commit_failed");
            }
            Log.i(TAG, "invalidateRecurrenceAuthorization: generation "
                    + prev + " -> " + next + " for " + medicationId + "/" + doseId);
            // Only after durable bump: cancel futures so restore cannot resurrect them.
            // Fail-closed (Issue #241): if any durable cancellation step fails, report
            // ok=false WITHOUT rolling back the generation — the bump is durable and
            // must stay monotonic (rollback itself can fail and create authorization
            // ambiguity). The caller retries; retry is idempotent (existing tombstones
            // and already-absent metadata are handled safely).
            CancelResult cancel = cancelAllSchedulesForDoseLocked(medicationId, doseId);
            if (!cancel.isOk()) {
                Log.e(TAG, "invalidateRecurrenceAuthorization: cancellation failed for "
                        + medicationId + "/" + doseId + " — generation " + next
                        + " remains committed (no rollback); error=" + cancel.error);
                return InvalidateResult.fail(cancel.error);
            }
            return InvalidateResult.success(next);
        }
    }

    /**
     * Cancel each occurrence through the shared exact-alarm runtime; Auto Deduction
 * keeps ownership of which occurrences belong to the dose chain. of
     * this medication+dose. Caller must hold {@link #SCHEDULE_LOCK}.
     * Also writes occurrence cancellation tombstones so fire cannot promote them.
     *
     * <p><b>Fail-closed (Issue #241):</b> returns {@link CancelResult#fail} when any
     * durable cancellation step fails (ordering-token allocation, tombstone write
     * commit, metadata removal commit, or AlarmManager unavailable). The caller
     * ({@link #invalidateRecurrenceAuthorization}) must NOT report disable success
     * until this returns ok. The generation bump stays committed on failure (no
     * rollback). Retry is idempotent: occurrences already carrying a tombstone skip
     * the tombstone rewrite, and occurrences with no metadata skip removal.
     */
    private CancelResult cancelAllSchedulesForDoseLocked(String medicationId, String doseId) {
        Map<String, ?> all = getAllScheduleMetadata();
        if (all == null || all.isEmpty()) return CancelResult.success();

        syncAlarmRuntimeTestControls();
        for (Map.Entry<String, ?> e : all.entrySet()) {
            String storageKey = e.getKey();
            if (storageKey == null || storageKey.isEmpty()) continue;
            if (!(e.getValue() instanceof String)) continue;

            try {
                JSONObject metadata = new JSONObject((String) e.getValue());
                if (!medicationId.equals(metadata.optString("medicationId", ""))
                        || !doseId.equals(metadata.optString("doseId", ""))) continue;

                String date = metadata.optString("calendarDate", "");
                if (!AutoDeductionContract.isValidCalendarDate(date)) {
                    if (!quarantineMalformedScheduleMetadata(
                            storageKey, (String) e.getValue(), "malformed_calendar_date")) {
                        return CancelResult.fail("schedule_metadata_removal_failed");
                    }
                    continue;
                }

                String occurrenceKey = AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, date);
                AutoDeductionSchedulingAdapter.CancelResult result =
                        schedulingAdapter.cancelOccurrence(
                                medicationId,
                                doseId,
                                date);
                if (!result.isOk()) return CancelResult.fail(result.error);
            } catch (JSONException ex) {
                if (!quarantineMalformedScheduleMetadata(
                        storageKey, (String) e.getValue(), "invalid_json")) {
                    return CancelResult.fail("schedule_metadata_removal_failed");
                }
            }
        }
        return CancelResult.success();
    }

    /** Result of multi-day catch-up (Issue #243). FIRED count ≠ future alarms installed. */
    static final class CatchUpResult {
        final int firedCreated;
        /** True only when a new future AlarmManager schedule was installed. */
        final boolean futureInstalled;
        /**
         * True when recovery could not finish (FIRED persistence failure, epoch
         * compute failure, or future install failure that preserves the snapshot).
         * Callers must treat incomplete=true as restore boundary failure.
         */
        final boolean incomplete;

        CatchUpResult(int firedCreated, boolean futureInstalled) {
            this(firedCreated, futureInstalled, false);
        }

        CatchUpResult(int firedCreated, boolean futureInstalled, boolean incomplete) {
            this.firedCreated = firedCreated;
            this.futureInstalled = futureInstalled;
            this.incomplete = incomplete;
        }
    }

    public static final class ScheduleResult {
        public final boolean ok;
        public final String error;
        public final String occurrenceKey;

        public ScheduleResult(boolean ok, String error, String occurrenceKey) {
            this.ok = ok;
            this.error = error;
            this.occurrenceKey = occurrenceKey;
        }

        public static ScheduleResult success(String key) {
            return new ScheduleResult(true, null, key);
        }

        public static ScheduleResult fail(String error) {
            return new ScheduleResult(false, error, null);
        }
    }

    /**
     * Result of {@link #invalidateRecurrenceAuthorization}.
     * Fail-closed: {@code ok=true} only when the durable generation bump committed.
     */
    public static final class InvalidateResult {
        public final boolean ok;
        public final String error;
        /** Active generation after a successful bump; 0 when failed / not bumped. */
        public final long generation;

        public InvalidateResult(boolean ok, String error, long generation) {
            this.ok = ok;
            this.error = error;
            this.generation = generation;
        }

        public static InvalidateResult success(long generation) {
            return new InvalidateResult(true, null, generation);
        }

        public static InvalidateResult fail(String error) {
            return new InvalidateResult(false, error, 0L);
        }
    }

    /**
     * Result of a cancelOccurrence attempt.
     * <ul>
     *   <li>{@link Status#SUCCESS} — alarm canceled (or was absent) and metadata removed
     *       (or was already absent); intended terminal state achieved</li>
     *   <li>{@link Status#ALREADY_ABSENT} — no alarm metadata and cancel path completed
     *       (subset of SUCCESS for callers that care)</li>
     *   <li>{@link Status#FAILED} — AlarmManager unavailable, or metadata remove commit failed;
     *       intended cancellation state not fully confirmed</li>
     * </ul>
     */
    public static final class CancelResult {
        public enum Status {
            SUCCESS,
            ALREADY_ABSENT,
            FAILED
        }

        public final Status status;
        public final String error;

        public CancelResult(Status status, String error) {
            this.status = status;
            this.error = error;
        }

        public boolean isOk() {
            return status == Status.SUCCESS || status == Status.ALREADY_ABSENT;
        }

        public static CancelResult success() {
            return new CancelResult(Status.SUCCESS, null);
        }

        public static CancelResult alreadyAbsent() {
            return new CancelResult(Status.ALREADY_ABSENT, null);
        }

        public static CancelResult fail(String error) {
            return new CancelResult(Status.FAILED, error);
        }
    }

    /**
     * Result of a serialized fire transition ({@link #fireOccurrenceIfNotCancelled}).
     * <ul>
     *   <li>{@link Status#CANCELLED} — cancellation linearized first; no FIRED/pending</li>
     *   <li>{@link Status#CREATED} — fire linearized; FIRED event newly committed</li>
     *   <li>{@link Status#ALREADY_EXISTS} — fire linearized; event already present</li>
     *   <li>{@link Status#FAILED} — fire linearized (not cancelled) but durable write
     *       could not be confirmed; {@link #pendingRecorded} may still be true</li>
     * </ul>
     */
    public static final class FireResult {
        public enum Status {
            CANCELLED,
            CREATED,
            ALREADY_EXISTS,
            FAILED
        }

        public final Status status;
        /** True if a pending-fire record was durably written after primary failure. */
        public final boolean pendingRecorded;

        public FireResult(Status status, boolean pendingRecorded) {
            this.status = status;
            this.pendingRecorded = pendingRecorded;
        }

        public static FireResult cancelled() {
            return new FireResult(Status.CANCELLED, false);
        }

        public static FireResult fromInsert(AutoDeductionEventStore.InsertFiredResult ir) {
            if (ir == null) {
                return new FireResult(Status.FAILED, false);
            }
            switch (ir.status) {
                case CREATED:
                    return new FireResult(Status.CREATED, ir.pendingRecorded);
                case ALREADY_EXISTS:
                    return new FireResult(Status.ALREADY_EXISTS, ir.pendingRecorded);
                case FAILED:
                default:
                    return new FireResult(Status.FAILED, ir.pendingRecorded);
            }
        }

        public boolean isCancelled() {
            return status == Status.CANCELLED;
        }

        /**
         * True when recurrence scheduling is safe because a durable fire outcome
         * exists: primary FIRED (created or already present) or pending-fire record.
         * CANCELLED and FAILED-without-pending must not advance recurrence.
         */
        public boolean allowsRecurrence() {
            return status == Status.CREATED
                    || status == Status.ALREADY_EXISTS
                    || (status == Status.FAILED && pendingRecorded);
        }
    }

    /**
     * Authoritative fire transition serialized with cancellation on {@link #SCHEDULE_LOCK}.
     *
     * <p>Under one continuous critical section:
     * <ol>
     *   <li>Evaluate effective cancellation (tombstone vs schedule ordering)</li>
     *   <li>If cancelled → return {@link FireResult.Status#CANCELLED} (no FIRED, no pending)</li>
     *   <li>Otherwise persist FIRED via {@link AutoDeductionEventStore#insertFiredIfAbsent}
     *       (including pending-fire fallback on primary commit failure)</li>
     * </ol>
     *
     * <p>Because {@link #cancelOccurrence} writes its tombstone under the same lock,
     * the TOCTOU window (check not-cancelled → cancel → insert FIRED) cannot occur.
     * EventStore.LOCK is nested only while SCHEDULE_LOCK is already held; no path
     * acquires EventStore.LOCK then SCHEDULE_LOCK.
     */
    /**
     * Authoritative fire transition serialized with cancellation and schedule
     * ownership validation on {@link #SCHEDULE_LOCK} (Issue #240).
     *
     * <p>Under one continuous critical section:
     * <ol>
     *   <li>Evaluate effective cancellation (tombstone vs schedule ordering)</li>
     *   <li>Require active schedule metadata for this occurrence</li>
     *   <li>Require every delivery to carry a non-empty {@code operationVersion}
     *       and a positive {@code recurrenceGeneration}. The operationVersion must
     *       match the active durable schedule metadata; the recurrenceGeneration
     *       must match Auto-owned recurrence authorization state for the dose slot.
     *       Missing, invalid, or mismatched tokens mean the delivery is stale/cancelled.
     *       There is no pre-token or tokenless compatibility path.</li>
     *   <li>If ownership holds → persist FIRED via insertFiredIfAbsent</li>
     * </ol>
     *
     * @param deliveryOperationVersion {@link AutoDeductionContract#EXTRA_OPERATION_VERSION}
     *        from the firing Intent; must be present and match active schedule metadata
     * @param deliveryRecurrenceGeneration {@link AutoDeductionContract#EXTRA_RECURRENCE_GENERATION}
     *        from the firing Intent; must be positive and match Auto-owned recurrence
     *        authorization state for the medication+dose slot
     */
    public FireResult fireOccurrenceIfNotCancelled(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String deliveryOperationVersion,
            long deliveryRecurrenceGeneration
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w(TAG, "fireOccurrenceIfNotCancelled: invalid payload");
            return new FireResult(FireResult.Status.FAILED, false);
        }
        final String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (SCHEDULE_LOCK) {
            // Re-entrant: isOccurrenceCancelledKey also synchronizes on SCHEDULE_LOCK.
            if (isOccurrenceCancelledKey(key)) {
                Log.i(TAG, "fire linearization: CANCELLED wins for " + key);
                return FireResult.cancelled();
            }

            // Issue #240: delivery must own the *current* schedule row.
            final String prefKey = key;
            final String metaRaw = getScheduleRaw(prefKey);
            if (metaRaw == null || metaRaw.isEmpty()) {
                Log.i(TAG, "fire linearization: STALE (no active schedule metadata) for " + key);
                return FireResult.cancelled();
            }
            // Tokenized delivery must own the current schedule row exactly.
            // Missing or mismatched operationVersion / recurrenceGeneration → STALE.
            try {
                JSONObject meta = new JSONObject(metaRaw);
                String treatmentEndDate = meta.optString(
                        AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
                if (!treatmentEndDate.isEmpty()
                        && (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)
                        || calendarDate.compareTo(treatmentEndDate) > 0)) {
                    Log.i(TAG, "fire linearization: treatment expired for " + key);
                    return FireResult.cancelled();
                }
                String activeVersion = AutoDeductionSchedulingAdapter.extractOperationVersion(meta);
                long activeGen = getEffectiveRecurrenceGenerationLocked(
                        medicationId, doseId, meta);
                if (deliveryOperationVersion == null || deliveryOperationVersion.isEmpty()
                        || deliveryRecurrenceGeneration <= 0L) {
                    Log.i(TAG, "fire linearization: STALE (delivery partially missing version/generation) for "
                            + key);
                    return FireResult.cancelled();
                }
                if (!deliveryOperationVersion.equals(activeVersion)) {
                    Log.i(TAG, "fire linearization: STALE operationVersion for " + key
                            + " delivery=" + deliveryOperationVersion
                            + " active=" + activeVersion);
                    return FireResult.cancelled();
                }
                if (deliveryRecurrenceGeneration != activeGen) {
                    Log.i(TAG, "fire linearization: STALE recurrenceGeneration for " + key
                            + " delivery=" + deliveryRecurrenceGeneration
                            + " active=" + activeGen);
                    return FireResult.cancelled();
                }
            } catch (JSONException e) {
                Log.e(TAG, "fire linearization: malformed schedule metadata for " + key, e);
                return FireResult.cancelled();
            }

            AutoDeductionEventStore store = new AutoDeductionEventStore(appContext);
            AutoDeductionEventStore.InsertFiredResult ir = store.insertFiredIfAbsent(
                    medicationId, doseId, calendarDate, scheduledAtEpochMs, amount);
            FireResult result = FireResult.fromInsert(ir);

            // FIRED evidence and Native stock are one Auto business boundary.
            // A live delivery is not considered recurrence-safe until the same
            // occurrence has also been applied to the Native stock authority.
            if (result.allowsRecurrence()) {
                AutoDeductionStockStore.AutoApplyResult stockResult =
                        new AutoDeductionStockStore(appContext).applyAutoDeduction(
                                medicationId, doseId, calendarDate, amount);
                if (!stockResult.ok) {
                    Log.e(TAG, "fire linearization: Native stock apply failed for "
                            + key + " — " + stockResult.error);

                    // Keep independent retry evidence for a stock-only failure.
                    // It is self-contained so a later config mutation/removal of
                    // the schedule row cannot erase the recovery proof.
                    String timeHhmm = "";
                    String operationVersion = deliveryOperationVersion != null
                            ? deliveryOperationVersion : "";
                    long gen = deliveryRecurrenceGeneration;
                    try {
                        JSONObject meta = new JSONObject(metaRaw);
                        timeHhmm = meta.optString("timeHhmm", "");
                        if (operationVersion.isEmpty()) {
                            operationVersion =
                                    AutoDeductionSchedulingAdapter.extractOperationVersion(meta);
                        }
                        if (gen <= 0L) {
                            gen = getEffectiveRecurrenceGenerationLocked(
                                    medicationId, doseId, meta);
                        }
                    } catch (JSONException ignored) {
                    }

                    recordIndependentFireRetryEvidenceLocked(
                            medicationId, doseId, calendarDate, scheduledAtEpochMs,
                            amount, timeHhmm, gen, operationVersion,
                            /*nextRetryCount=*/1);

                    // Do not return CREATED/ALREADY_EXISTS/FIRED-pending to the
                    // receiver because stock is not complete yet. The receiver
                    // must enter the bounded same-occurrence retry path.
                    return new FireResult(FireResult.Status.FAILED, false);
                }

                // Any old retry proof is no longer needed once this occurrence's
                // Native stock has completed successfully.
                clearIndependentFireRetryEvidenceLocked(key);
            } else if (result.status == FireResult.Status.FAILED
                    && !result.pendingRecorded) {
                // FIRED persistence itself failed without an independent pending
                // record: keep retry evidence so the exact occurrence can be
                // reconstructed even if schedule metadata disappears.
                String timeHhmm = "";
                String operationVersion = deliveryOperationVersion != null
                        ? deliveryOperationVersion : "";
                long gen = deliveryRecurrenceGeneration;
                try {
                    JSONObject meta = new JSONObject(metaRaw);
                    timeHhmm = meta.optString("timeHhmm", "");
                    if (operationVersion.isEmpty()) {
                        operationVersion =
                                AutoDeductionSchedulingAdapter.extractOperationVersion(meta);
                    }
                    if (gen <= 0L) {
                        gen = getEffectiveRecurrenceGenerationLocked(
                                medicationId, doseId, meta);
                    }
                } catch (JSONException ignored) {
                }
                recordIndependentFireRetryEvidenceLocked(
                        medicationId, doseId, calendarDate, scheduledAtEpochMs,
                        amount, timeHhmm, gen, operationVersion, /*nextRetryCount=*/1);
            }

            Log.i(TAG, "fire linearization: " + result.status
                    + " pendingRecorded=" + result.pendingRecorded + " for " + key);
            return result;
        }
    }

    /**
     * Issue #243 — recover a historical missed occurrence as durable FIRED without
     * requiring live schedule metadata for that calendar date (unlike a real
     * AlarmManager delivery which must match operationVersion ownership).
     *
     * <p>Under {@link #SCHEDULE_LOCK}:
     * <ol>
     *   <li>Reject if the occurrence is effectively cancelled</li>
     *   <li>Reject if {@code expectedRecurrenceGeneration} is no longer active</li>
     *   <li>Idempotently {@link AutoDeductionEventStore#insertFiredIfAbsent}</li>
     * </ol>
     * Applies the Auto-owned Native stock mutation before recovery returns; JS only
     * mirrors the resulting Native balance later.
     */
    public FireResult recoverMissedOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            long expectedRecurrenceGeneration
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)) {
            Log.w(TAG, "recoverMissedOccurrence: invalid payload");
            return new FireResult(FireResult.Status.FAILED, false);
        }

        final String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (SCHEDULE_LOCK) {
            if (isOccurrenceCancelledKey(key)) {
                Log.i(TAG, "recoverMissed: CANCELLED occurrence " + key);
                return FireResult.cancelled();
            }
            // Always apply the same generation contract as live recurrence:
            // expected > 0 → active must equal expected;
            // expected <= 0 → active must still be 0 (post-invalidate active > 0 rejects).
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                Log.i(TAG, "recoverMissed: generation not authorized for " + key
                        + " expectedGen=" + expectedRecurrenceGeneration);
                return FireResult.cancelled();
            }
            AutoDeductionEventStore store = new AutoDeductionEventStore(appContext);
            AutoDeductionEventStore.InsertFiredResult ir = store.insertFiredIfAbsent(
                    medicationId, doseId, calendarDate, scheduledAtEpochMs, amount);
            FireResult result = FireResult.fromInsert(ir);

            // The Auto alarm/recovery path owns the stock mutation itself. The
            // native stock marker is occurrence-idempotent, so both CREATED and
            // ALREADY_EXISTS can safely pass through this same operation.
            if (result.allowsRecurrence()) {
                AutoDeductionStockStore.AutoApplyResult stockResult =
                        new AutoDeductionStockStore(appContext).applyAutoDeduction(
                                medicationId, doseId, calendarDate, amount);
                if (!stockResult.ok) {
                    Log.e(TAG, "recoverMissed: native stock apply failed for " + key
                            + " — " + stockResult.error);
                    return new FireResult(FireResult.Status.FAILED, false);
                }
                clearIndependentFireRetryEvidenceLocked(key);
            }

            Log.i(TAG, "recoverMissed: " + result.status
                    + " pendingRecorded=" + result.pendingRecorded + " for " + key);
            return result;
        }
    }

    /**
     * Issue #243 — walk calendar dates from {@code fromCalendarDate} forward with no
     * horizon: every due occurrence is recovered as FIRED; the first not-yet-due
     * date becomes the sole live AlarmManager schedule for this dose slot.
     *
     * @return number of newly {@code CREATED} FIRED events in this invocation
     */
    CatchUpResult catchUpMissedOccurrencesAndScheduleNext(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount,
            long expectedRecurrenceGeneration,
            String pastPrefKey,
            String observedVersion
    ) {
        if (medicationId == null || doseId == null || fromCalendarDate == null
                || timeHhmm == null) {
            return new CatchUpResult(0, false);
        }
        synchronized (SCHEDULE_LOCK) {
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                Log.i(TAG, "catchUp: generation unauthorized — dropping snapshot "
                        + pastPrefKey);
                removeScheduleMetadataIfVersionLocked(pastPrefKey, observedVersion);
                return new CatchUpResult(0, false);
            }
        }

        final long nowMs = recoveryNowMs();
        String treatmentEndDate = "";
        synchronized (SCHEDULE_LOCK) {
            String raw = getScheduleRaw(pastPrefKey);
            if (raw != null && !raw.isEmpty()) {
                try {
                    treatmentEndDate = new JSONObject(raw).optString(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
                } catch (JSONException e) {
                    return new CatchUpResult(0, false, true);
                }
            }
        }
        if (!treatmentEndDate.isEmpty()
                && !AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
            return new CatchUpResult(0, false, true);
        }

        String walkDate = fromCalendarDate;
        int created = 0;
        boolean futureInstalled = false;
        boolean preserveSnapshotForRetry = false;

        while (walkDate != null) {
            if (!treatmentEndDate.isEmpty()
                    && walkDate.compareTo(treatmentEndDate) > 0) {
                break;
            }
            Long epoch = computeEpochMs(walkDate, timeHhmm);
            if (epoch == null) {
                preserveSnapshotForRetry = true;
                break;
            }
            if (epoch > nowMs) {
                // First future occurrence — gen check + install under one SCHEDULE_LOCK.
                // Test seam: optional latches only fire between outer gen probe and
                // the locked install block when set (still re-checked under lock).
                if (recoveryBeforeSuccessorInstallLatchForTest != null) {
                    recoveryBeforeSuccessorInstallLatchForTest.countDown();
                    try {
                        if (recoveryResumeSuccessorInstallLatchForTest != null) {
                            recoveryResumeSuccessorInstallLatchForTest.await(
                                    5, java.util.concurrent.TimeUnit.SECONDS);
                        }
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        preserveSnapshotForRetry = true;
                        break;
                    }
                }
                ScheduleResult sr = installFutureSuccessorIfGenerationHolds(
                        medicationId, doseId, walkDate, timeHhmm, amount,
                        epoch, expectedRecurrenceGeneration,
                        pastPrefKey, observedVersion);
                if (!sr.ok) {
                    if ("recurrence_generation_unauthorized".equals(sr.error)
                            || "snapshot_stale".equals(sr.error)) {
                        Log.i(TAG, "catchUp: future install rejected (" + sr.error + ")");
                    } else {
                        Log.w(TAG, "catchUp: future schedule failed (" + sr.error
                                + ") for " + medicationId + "/" + doseId + "/" + walkDate);
                        preserveSnapshotForRetry = true;
                    }
                } else if (sr.error == null) {
                    // Newly installed AlarmManager schedule for the first future date.
                    futureInstalled = true;
                    Log.i(TAG, "catchUp: scheduled next future "
                            + medicationId + "/" + doseId + "/" + walkDate);
                } else {
                    Log.i(TAG, "catchUp: future successor skipped (" + sr.error + ") for "
                            + medicationId + "/" + doseId + "/" + walkDate);
                }
                break;
            }

            FireResult fr = recoverMissedOccurrence(
                    medicationId, doseId, walkDate, epoch, amount,
                    expectedRecurrenceGeneration);
            if (fr.isCancelled()) {
                synchronized (SCHEDULE_LOCK) {
                    if (!isRecurrenceGenerationAuthorizedLocked(
                            medicationId, doseId, expectedRecurrenceGeneration)) {
                        Log.i(TAG, "catchUp: generation invalidated mid-walk — stop");
                        removeScheduleMetadataIfVersionLocked(pastPrefKey, observedVersion);
                        return new CatchUpResult(created, false);
                    }
                }
                walkDate = nextCalendarDate(walkDate);
                continue;
            }
            if (fr.status == FireResult.Status.CREATED) {
                created++;
            }
            if (!fr.allowsRecurrence()) {
                Log.e(TAG, "catchUp: FIRED persistence failed for "
                        + medicationId + "/" + doseId + "/" + walkDate
                        + " — preserving snapshot for retry");
                preserveSnapshotForRetry = true;
                break;
            }
            walkDate = nextCalendarDate(walkDate);
        }

        if (!preserveSnapshotForRetry) {
            if (!removeScheduleMetadataIfVersion(pastPrefKey, observedVersion)) {
                Log.i(TAG, "catchUp: past metadata already gone/replaced: " + pastPrefKey);
            }
        }
        return new CatchUpResult(created, futureInstalled, preserveSnapshotForRetry);
    }

    /**
     * Issue #243 / #217 — under one continuous {@link #SCHEDULE_LOCK} section:
     * re-validate expected recurrence generation, confirm past snapshot ownership
     * when still present, and install the future successor via
     * {@link #scheduleOccurrenceLocked} stamping that same generation.
     * A concurrent invalidate either wins entirely or loses entirely; there is no
     * window where G1 recovery installs a G2 successor.
     */
    private ScheduleResult installFutureSuccessorIfGenerationHolds(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long triggerAt,
            long expectedRecurrenceGeneration,
            String pastPrefKey,
            String observedVersion
    ) {
        final String futureKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        final String futurePrefKey = futureKey;
        synchronized (SCHEDULE_LOCK) {
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                removeScheduleMetadataIfVersionLocked(pastPrefKey, observedVersion);
                return ScheduleResult.fail("recurrence_generation_unauthorized");
            }
            // Past snapshot must still be the one we are recovering from (if present).
            if (pastPrefKey != null && observedVersion != null && !observedVersion.isEmpty()) {
                String cur = getScheduleRaw(pastPrefKey);
                if (cur != null && !isMetadataOwnedByVersion(cur, observedVersion)) {
                    return ScheduleResult.fail("snapshot_stale");
                }
            }
            String treatmentEndDate = "";
            String currentPast = getScheduleRaw(pastPrefKey);
            if (currentPast != null && !currentPast.isEmpty()) {
                try {
                    treatmentEndDate = new JSONObject(currentPast).optString(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
                } catch (JSONException e) {
                    return ScheduleResult.fail("snapshot_stale");
                }
            }
            if (!treatmentEndDate.isEmpty()) {
                if (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
                    return ScheduleResult.fail("invalid_treatment_end_date");
                }
                if (calendarDate.compareTo(treatmentEndDate) > 0) {
                    return new ScheduleResult(true, "treatment_ended", futureKey);
                }
            }

            // If future already exists under same identity, do not replace.
            // EXCEPTION — same-key recovery: when the first not-yet-due occurrence
            // IS the past snapshot's own date (fromCalendarDate == calendarDate,
            // i.e. a today-occurrence whose time is still ahead), the "existing"
            // metadata is the very snapshot being recovered, not a separate live
            // schedule. It must be re-armed under a fresh ordering token here;
            // otherwise the trailing snapshot removal in catchUp (version match)
            // deletes the only schedule row for the still-pending occurrence and
            // it silently disappears (no FIRED, no SCHEDULED, no alarm).
            boolean sameKeyRecovery =
                    pastPrefKey != null && pastPrefKey.equals(futurePrefKey);
            String existing = sameKeyRecovery
                    ? null
                    : getScheduleRaw(futurePrefKey);
            if (existing != null && !existing.isEmpty()) {
                return new ScheduleResult(true, "already_present", futureKey);
            }
            // Effective cancellation (tombstone) must not be cleared by recovery:
            // scheduleOccurrenceLocked would clearCancellationTombstoneLocked.
            if (isOccurrenceCancelledKey(futureKey)) {
                Log.i(TAG, "catchUp: future successor cancelled — leave tombstone, no reinstall "
                        + futureKey);
                return new ScheduleResult(true, "cancelled_skip", futureKey);
            }

            JSONObject payload = new JSONObject();
            try {
                payload.put("medicationId", medicationId);
                payload.put("doseId", doseId);
                payload.put("calendarDate", calendarDate);
                payload.put("timeHhmm", timeHhmm);
                payload.put("amount", amount);
                payload.put("scheduledAtEpochMs", triggerAt);
                if (!treatmentEndDate.isEmpty()) {
                    payload.put(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE,
                            treatmentEndDate);
                }
            } catch (JSONException e) {
                return ScheduleResult.fail("payload_build_failed");
            }
            // Pass expected generation so the shared runtime cannot stamp a newer gen.
            return scheduleOccurrenceLocked(
                    futurePrefKey,
                    futureKey,
                    payload,
                    triggerAt,
                    null,
                    expectedRecurrenceGeneration);
        }
    }


    /**
     * Pure ownership check used by conditional rollback.
     * Package-visible for focused verification.
     */
    static boolean isMetadataOwnedByVersion(String currentJson, String expectedVersion) {
        return AutoDeductionSchedulingAdapter.isMetadataOwnedByOperationVersion(
                currentJson, expectedVersion);
    }

    /**
     * Whether past-schedule metadata may be deleted after an insertFiredIfAbsent
     * attempt during restore. Metadata must survive when neither the main FIRED
     * ledger nor a pending-fire record was durably established.
     *
     * Package-visible for focused verification of the recovery matrix.
     */
    static boolean shouldRemovePastScheduleMetadata(
            AutoDeductionEventStore.InsertFiredResult ir) {
        if (ir == null) return false;
        return ir.isCreated() || ir.isAlreadyExists() || ir.pendingRecorded;
    }

    /**
     * Same recovery matrix as {@link #shouldRemovePastScheduleMetadata(AutoDeductionEventStore.InsertFiredResult)}
     * plus CANCELLED (drop stale schedule metadata; fire must not be synthesized).
     */
    static boolean shouldRemovePastScheduleMetadata(FireResult fr) {
        if (fr == null) return false;
        if (fr.isCancelled()) return true;
        // Durable fire (primary or pending) — metadata may be resolved after
        // successor scheduling succeeds; see continueRecurrenceAfterPastRecovery.
        return fr.allowsRecurrence();
    }


    /**
     * Bounded one-shot retry for a fire delivery whose durable FIRED/pending
     * persistence failed without pending evidence. The one-shot alarm is
     * consumed by the failed delivery, so without a retry the occurrence would
     * only recover via boot/TZ/JS restore paths.
     *
     * <p>The retry re-delivers the SAME occurrence identity with the same
     * generic operationVersion ownership token and Auto-owned recurrenceGeneration,
     * so {@link #fireOccurrenceIfNotCancelled} remains the single linearized
     * fire path: a retry that races a cancel is rejected as CANCELLED, and
     * insert-if-absent idempotency prevents a duplicate FIRED row or a second
     * JS wake-up. Independent fire-retry evidence in {@link AutoDeductionContract#PREFS_FIRE_RETRY}
     * is the durable authority for failed-fire recovery; the shared schedule row
     * does not carry the retry counter.
     *
     * @param nextRetryCount 1-based retry index carried in
     *        {@link AutoDeductionContract#EXTRA_FIRE_RETRY_COUNT}
     * @return true only when Auto retry evidence was durably recorded and AlarmManager
     *         accepted the retry alarm. Evidence-write failure returns false without scheduling.
     */
    boolean scheduleFireRetry(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String operationVersion,
            int nextRetryCount
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidAmount(amount)
                || nextRetryCount <= 0
                || nextRetryCount > AutoDeductionContract.MAX_FIRE_RETRIES) {
            return false;
        }

        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        final String prefKey = key;

        synchronized (SCHEDULE_LOCK) {
            if (isOccurrenceCancelledKey(key)) {
                return false;
            }

            String currentRaw = getScheduleRaw(prefKey);
            JSONObject existingEvidence =
                    getIndependentFireRetryEvidence(
                            medicationId, doseId, calendarDate);
            int priorRetryCount = existingEvidence == null
                    ? 0
                    : existingEvidence.optInt("retryCount", 0);
            int persistedRetryCount = Math.max(
                    priorRetryCount,
                    nextRetryCount);

            if (currentRaw != null && !currentRaw.isEmpty()) {
                try {
                    JSONObject current = new JSONObject(currentRaw);
                    String activeVersion =
                            AutoDeductionSchedulingAdapter.extractOperationVersion(current);
                    long activeGen =
                            getEffectiveRecurrenceGenerationLocked(
                                    medicationId, doseId, current);
                    if (operationVersion == null || operationVersion.isEmpty()
                            || recurrenceGeneration <= 0L
                            || !operationVersion.equals(activeVersion)
                            || recurrenceGeneration != activeGen) {
                        return false;
                    }
                } catch (JSONException e) {
                    return false;
                }
            } else if (existingEvidence == null) {
                return false;
            }

            if (!recordIndependentFireRetryEvidenceLocked(
                    medicationId, doseId, calendarDate,
                    scheduledAtEpochMs, amount, timeHhmm,
                    recurrenceGeneration, operationVersion,
                    persistedRetryCount)) {
                return false;
            }

            return schedulingAdapter.scheduleFireRetry(
                    medicationId,
                    doseId,
                    calendarDate,
                    scheduledAtEpochMs,
                    amount,
                    timeHhmm,
                    recurrenceGeneration,
                    operationVersion,
                    persistedRetryCount);
        }
    }

    private static final String FIRE_RETRY_KEY_PREFIX = "fretry:";

    /**
     * Persist independent fire-failure evidence for an occurrence.
     * Caller MUST hold SCHEDULE_LOCK. Idempotent: same occurrence increments
     * retryCount to max(existing, nextRetryCount) without duplicating rows.
     */
    boolean recordIndependentFireRetryEvidenceLocked(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount,
            String timeHhmm,
            long recurrenceGeneration,
            String operationVersion,
            int nextRetryCount
    ) {
        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        final String prefKey = FIRE_RETRY_KEY_PREFIX + key;
        try {
            int prior = 0;
            String existing = fireRetryPrefs.getString(prefKey, null);
            if (existing != null && !existing.isEmpty()) {
                try {
                    prior = new JSONObject(existing).optInt("retryCount", 0);
                } catch (JSONException ignored) {
                }
            }
            int count = Math.max(prior, Math.max(1, nextRetryCount));
            if (count > AutoDeductionContract.MAX_FIRE_RETRIES) {
                count = AutoDeductionContract.MAX_FIRE_RETRIES;
            }
            JSONObject obj = new JSONObject();
            obj.put("medicationId", medicationId);
            obj.put("doseId", doseId);
            obj.put("calendarDate", calendarDate);
            obj.put("scheduledAtEpochMs", scheduledAtEpochMs);
            obj.put("amount", amount);
            obj.put("timeHhmm", timeHhmm != null ? timeHhmm : "");
            obj.put("recurrenceGeneration", recurrenceGeneration);
            obj.put("operationVersion", operationVersion != null ? operationVersion : "");
            obj.put("retryCount", count);
            obj.put("updatedAtEpochMs", System.currentTimeMillis());
            boolean ok = !forceFireRetryEvidenceCommitFailureForTest
                    && fireRetryPrefs.edit().putString(prefKey, obj.toString()).commit();
            if (!ok) {
                Log.e(TAG, "independent fire-retry evidence commit failed for " + key);
            } else {
                Log.i(TAG, "independent fire-retry evidence recorded for " + key
                        + " retryCount=" + count);
            }
            return ok;
        } catch (JSONException e) {
            Log.e(TAG, "independent fire-retry evidence build failed for " + key, e);
            return false;
        }
    }

    /** Clear independent fire-retry evidence. Caller MUST hold SCHEDULE_LOCK. */
    boolean clearIndependentFireRetryEvidenceLocked(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        final String prefKey = FIRE_RETRY_KEY_PREFIX + occurrenceKey;
        if (!fireRetryPrefs.contains(prefKey)) return true;
        boolean ok = fireRetryPrefs.edit().remove(prefKey).commit();
        if (!ok) {
            Log.w(TAG, "independent fire-retry evidence clear failed for " + occurrenceKey);
        }
        return ok;
    }

    /**
     * Clear independent fire-retry evidence only after the corresponding Native
     * stock mutation has been confirmed. This is deliberately separate from FIRED
     * persistence because FIRED and stock execution are two durable steps.
     */
    void clearIndependentFireRetryEvidenceAfterStock(
            String medicationId,
            String doseId,
            String calendarDate
    ) {
        if (medicationId == null || doseId == null || calendarDate == null) return;
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (SCHEDULE_LOCK) {
            clearIndependentFireRetryEvidenceLocked(key);
        }
    }

    /**
     * Recover a previously authorized fire from independent failure evidence.
     * Does NOT require shared schedule metadata and does NOT schedule recurrence successors.
     * Lock order: SCHEDULE_LOCK → EventStore.LOCK (via insertFiredIfAbsent).
     */
    public FireResult recoverFireFromIndependentEvidence(
            String medicationId,
            String doseId,
            String calendarDate
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return new FireResult(FireResult.Status.FAILED, false);
        }
        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (SCHEDULE_LOCK) {
            // Independent fire evidence proves an already-authorized fire began
            // persistence before any later config mutation/cancellation. Later
            // tombstones must NOT erase recovery of that prior fire.
            JSONObject evidence = getIndependentFireRetryEvidence(
                    medicationId, doseId, calendarDate);
            if (evidence == null) {
                // No prior failed-fire evidence — cancellation applies to live path.
                if (isOccurrenceCancelledKey(key)) {
                    Log.i(TAG, "recover independent evidence: no evidence + CANCELLED " + key);
                    return FireResult.cancelled();
                }
                return new FireResult(FireResult.Status.FAILED, false);
            }
            double amount = evidence.optDouble("amount", Double.NaN);
            long scheduledAt = evidence.optLong("scheduledAtEpochMs", 0L);
            if (!AutoDeductionContract.isValidAmount(amount)) {
                Log.e(TAG, "recover independent evidence: invalid amount for " + key);
                return new FireResult(FireResult.Status.FAILED, false);
            }
            AutoDeductionEventStore store = new AutoDeductionEventStore(appContext);
            AutoDeductionEventStore.InsertFiredResult ir = store.insertFiredIfAbsent(
                    medicationId, doseId, calendarDate, scheduledAt, amount);
            FireResult result = FireResult.fromInsert(ir);
            if (result.allowsRecurrence()) {
                // Independent recovery is itself a complete Auto execution boundary.
                // Do not leave FIRED-only proof behind: apply the same occurrence-
                // idempotent Native stock mutation used by the live receiver.
                AutoDeductionStockStore.AutoApplyResult stockResult =
                        new AutoDeductionStockStore(appContext).applyAutoDeduction(
                                medicationId, doseId, calendarDate, amount);
                if (!stockResult.ok) {
                    Log.e(TAG, "recover independent evidence: native stock apply failed for "
                            + key + " — " + stockResult.error);
                    return new FireResult(FireResult.Status.FAILED, false);
                }

                // The retry has now completed the same durable Auto occurrence that
                // originally failed. If the original schedule row is still the active
                // owner of this occurrence, continue the recurrence chain immediately.
                // The ownership check is deliberately strict so a later reschedule or
                // disable cannot recreate D+1 from stale retry evidence. When D is no
                // longer present/owned, the independent evidence must not invent a new
                // schedule; the normal scheduler/recovery path remains authoritative.
                ScheduleResult successor = scheduleNextOccurrenceFromIndependentEvidenceLocked(
                        medicationId, doseId, calendarDate, evidence);
                if (!successor.ok) {
                    Log.i(TAG, "recover independent evidence: successor not scheduled from "
                            + "retry evidence (" + successor.error + ") for " + key);
                }
                clearIndependentFireRetryEvidenceLocked(key);
            } else if (result.status == FireResult.Status.FAILED
                    && !result.pendingRecorded) {
                int prior = evidence.optInt("retryCount", 0);
                int next = Math.min(prior + 1, AutoDeductionContract.MAX_FIRE_RETRIES);
                recordIndependentFireRetryEvidenceLocked(
                        medicationId, doseId, calendarDate, scheduledAt, amount,
                        evidence.optString("timeHhmm", ""),
                        evidence.optLong("recurrenceGeneration", 0L),
                        evidence.optString("operationVersion", ""),
                        next);
            }
            Log.i(TAG, "recover independent evidence: " + result.status
                    + " pending=" + result.pendingRecorded + " for " + key);
            return result;
        }
    }

    /**
     * Continue recurrence after a successful independent-fire recovery only when
     * the still-present D schedule metadata proves that the retry evidence owns it.
     *
     * <p>This closes the retry gap where Native stock recovery succeeds after the
     * one-shot D alarm was consumed: D+1 must be re-established before the native
     * process goes idle. The evidence's operationVersion, recurrence generation,
     * amount, and time must still match the live D metadata. Missing/replaced
     * metadata is treated as stale evidence and is never allowed to resurrect a
     * successor from obsolete configuration.</p>
     *
     * Caller MUST hold SCHEDULE_LOCK.
     */
    private ScheduleResult scheduleNextOccurrenceFromIndependentEvidenceLocked(
            String medicationId,
            String doseId,
            String calendarDate,
            JSONObject evidence
    ) {
        if (evidence == null
                || medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return ScheduleResult.fail("snapshot_stale");
        }

        String prefKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        String currentRaw = getScheduleRaw(prefKey);
        if (currentRaw == null || currentRaw.isEmpty()) {
            return ScheduleResult.fail("snapshot_stale");
        }

        String evidenceVersion =
                AutoDeductionSchedulingAdapter.extractOperationVersion(evidence);
        long evidenceGeneration = evidence.optLong("recurrenceGeneration", 0L);
        String evidenceTime = evidence.optString("timeHhmm", "");
        double evidenceAmount = evidence.optDouble("amount", Double.NaN);

        try {
            JSONObject current = new JSONObject(currentRaw);
            String activeVersion =
                    AutoDeductionSchedulingAdapter.extractOperationVersion(current);
            long activeGeneration =
                    getEffectiveRecurrenceGenerationLocked(medicationId, doseId, current);
            String activeTime = current.optString("timeHhmm", "");
            double activeAmount = current.optDouble("amount", Double.NaN);

            if (evidenceVersion.isEmpty()
                    || evidenceGeneration <= 0L
                    || !AutoDeductionContract.isValidTimeHhmm(evidenceTime)
                    || !AutoDeductionContract.isValidAmount(evidenceAmount)
                    || !evidenceVersion.equals(activeVersion)
                    || evidenceGeneration != activeGeneration
                    || !evidenceTime.equals(activeTime)
                    || Double.compare(evidenceAmount, activeAmount) != 0) {
                return ScheduleResult.fail("snapshot_stale");
            }

            return scheduleNextOccurrenceIfAbsent(
                    medicationId,
                    doseId,
                    calendarDate,
                    evidenceTime,
                    evidenceAmount,
                    evidenceGeneration);
        } catch (JSONException e) {
            return ScheduleResult.fail("snapshot_stale");
        }
    }

    /**
     * Restore-boundary pass: ensure every durable FIRED occurrence has also reached
     * the Auto Native stock authority. This is deliberately independent of JavaScript
     * so a FIRED row left behind after a transient stock failure is recoverable on
     * boot/timezone/exact-permission lifecycle events even while the WebView is dead.
     *
     * <p>This pass never acknowledges the FIRED row. JS still owns marker/log
     * reconciliation and the final RECONCILED acknowledgement.</p>
     */
    RestoreResult recoverFiredStockPass() {
        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext);

        // Before the first JS hydration after install/upgrade there is no safe
        // baseline for Native stock. Legacy FIRED rows may already have been
        // applied by the old JS-only implementation, so recovery must wait until
        // JS has seeded the Native authority.
        if (!stock.isInitialized()) {
            Log.i(TAG, "recoverFiredStockPass: Native stock not initialized — defer to JS hydration");
            return RestoreResult.success(0, 0);
        }

        AutoDeductionEventStore store = new AutoDeductionEventStore(appContext);
        AutoDeductionEventStore.FiredEventsResult listed = store.listFiredEventsResult();
        if (!listed.ok) {
            return RestoreResult.failure(
                    0, 1,
                    listed.error != null ? listed.error : "fired_stock_list_failed");
        }

        int recovered = 0;
        int failed = 0;

        for (JSONObject event : listed.events) {
            String medicationId = event.optString("medicationId", "").trim();
            String doseId = event.optString("doseId", "").trim();
            String calendarDate = event.optString("calendarDate", "");
            double amount = event.optDouble("amount", Double.NaN);

            if (medicationId.isEmpty()
                    || doseId.isEmpty()
                    || !AutoDeductionContract.isValidCalendarDate(calendarDate)
                    || !AutoDeductionContract.isValidAmount(amount)) {
                failed++;
                continue;
            }

            AutoDeductionStockStore.AutoApplyResult stockResult =
                    stock.applyAutoDeduction(
                            medicationId, doseId, calendarDate, amount);
            if (stockResult.ok) {
                recovered++;
            } else {
                failed++;
                Log.e(TAG, "recoverFiredStockPass: native stock apply failed for "
                        + medicationId + "/" + doseId + "/" + calendarDate
                        + " — " + stockResult.error);
            }
        }

        if (failed > 0) {
            return RestoreResult.failure(recovered, failed, "fired_stock_pass_failed");
        }
        return RestoreResult.success(recovered, 0);
    }

    /**
     * Restore-boundary pass: attempt recovery for every independent fire-retry
     * evidence row, even when shared schedule metadata is missing.
     */
    RestoreResult recoverIndependentFireRetryEvidencePass() {
        // Retry evidence can only be recovered once the Native stock baseline
        // exists; otherwise there is no authoritative balance to apply against.
        if (!new AutoDeductionStockStore(appContext()).isInitialized()) {
            Log.i(TAG, "independent evidence pass: Native stock not initialized — defer to JS hydration");
            return RestoreResult.success(0, 0);
        }

        int recovered = 0;
        int failed = 0;
        boolean ok = true;
        java.util.List<String[]> rows = new java.util.ArrayList<>();
        synchronized (SCHEDULE_LOCK) {
            Map<String, ?> all = fireRetryPrefs.getAll();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                if (!e.getKey().startsWith(FIRE_RETRY_KEY_PREFIX)) continue;
                if (!(e.getValue() instanceof String)) continue;
                rows.add(new String[]{ e.getKey(), (String) e.getValue() });
            }
        }
        for (String[] row : rows) {
            try {
                JSONObject evidence = new JSONObject(row[1]);
                String medId = evidence.optString("medicationId", "");
                String doseId = evidence.optString("doseId", "");
                String date = evidence.optString("calendarDate", "");
                if (medId.isEmpty() || doseId.isEmpty()
                        || !AutoDeductionContract.isValidCalendarDate(date)) {
                    failed++;
                    ok = false;
                    Log.e(TAG, "independent evidence row malformed: " + row[0]);
                    continue;
                }
                FireResult fr = recoverFireFromIndependentEvidence(medId, doseId, date);
                if (fr.allowsRecurrence()) {
                    recovered++;
                } else if (fr.status == FireResult.Status.CANCELLED) {
                    // cancelled: evidence cleared; not a boundary failure
                } else {
                    // Still FAILED — evidence retained for later retry.
                    int count = evidence.optInt("retryCount", 0);
                    if (count >= AutoDeductionContract.MAX_FIRE_RETRIES) {
                        // Unresolved fire: evidence remains but no durable FIRED/pending
                        // and no further bounded retry is allowed. Recovery boundary is
                        // incomplete — must not report ok=true (would success-cache and
                        // skip later boundaries while the exact deduction never lands).
                        failed++;
                        ok = false;
                        Log.e(TAG, "independent evidence unresolved after MAX_FIRE_RETRIES for "
                                + medId + "/" + doseId + "/" + date
                                + " — evidence retained, no further retry");
                    } else {
                        long scheduledAt = evidence.optLong("scheduledAtEpochMs", 0L);
                        double amount = evidence.optDouble("amount", Double.NaN);
                        String time = evidence.optString("timeHhmm", "");
                        long gen = evidence.optLong("recurrenceGeneration", 0L);
                        String ver = evidence.optString("operationVersion", "");
                        if (!AutoDeductionContract.isValidAmount(amount)) {
                            failed++;
                            ok = false;
                            Log.e(TAG, "independent evidence invalid amount: " + row[0]);
                        } else {
                            boolean retryOk = scheduleFireRetry(
                                    medId, doseId, date, scheduledAt, amount,
                                    time, gen, ver, Math.min(count + 1,
                                            AutoDeductionContract.MAX_FIRE_RETRIES));
                            if (!retryOk) {
                                failed++;
                                ok = false;
                                Log.e(TAG, "independent evidence retry schedule failed for "
                                        + medId + "/" + doseId + "/" + date);
                            }
                        }
                    }
                }
            } catch (JSONException e) {
                failed++;
                ok = false;
                Log.e(TAG, "independent evidence parse failed: " + row[0], e);
            }
        }
        if (!ok || failed > 0) {
            return RestoreResult.failure(recovered, failed, "independent_evidence_pass_failed");
        }
        return RestoreResult.success(recovered, failed);
    }

    /**
     * Read independent fire-retry evidence for an occurrence, or null.
     * Safe without SCHEDULE_LOCK for diagnostics; mutations must use lock.
     */
    public JSONObject getIndependentFireRetryEvidence(
            String medicationId, String doseId, String calendarDate) {
        final String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        String raw = fireRetryPrefs.getString(FIRE_RETRY_KEY_PREFIX + key, null);
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    /**
     * Schedule a single occurrence.
     *
     * Validation runs outside the lock. The Auto business decision plus its
     * scheduling-adapter call run inside one synchronized(SCHEDULE_LOCK) critical
     * section so recurrence authorization and schedule intent cannot interleave.
     */
    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs
    ) {
        return scheduleOccurrence(
                medicationId,
                doseId,
                calendarDate,
                timeHhmm,
                amount,
                scheduledAtEpochMs,
                null);
    }

    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs,
            String treatmentEndDate
    ) {
        if (medicationId == null || medicationId.isEmpty())
            return ScheduleResult.fail("missing_medicationId");
        if (doseId == null || doseId.isEmpty())
            return ScheduleResult.fail("missing_doseId");
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate))
            return ScheduleResult.fail("invalid_calendarDate");
        if (!AutoDeductionContract.isValidTimeHhmm(timeHhmm))
            return ScheduleResult.fail("invalid_time");
        if (!AutoDeductionContract.isValidAmount(amount))
            return ScheduleResult.fail("invalid_amount");

        if (treatmentEndDate != null && !treatmentEndDate.isEmpty()) {
            if (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
                return ScheduleResult.fail("invalid_treatment_end_date");
            }
            if (calendarDate.compareTo(treatmentEndDate) > 0) {
                return ScheduleResult.fail("treatment_ended");
            }
        }

        long triggerAt = scheduledAtEpochMs;
        if (triggerAt <= 0L) {
            Long computed = computeEpochMs(calendarDate, timeHhmm);
            if (computed == null) return ScheduleResult.fail("invalid_datetime");
            triggerAt = computed;
        }
        if (triggerAt <= System.currentTimeMillis() - 2000L)
            return ScheduleResult.fail("trigger_in_past");
        if (!canScheduleExactAlarms())
            return ScheduleResult.fail("exact_alarm_permission_denied");

        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        JSONObject payload = new JSONObject();
        try {
            payload.put("medicationId", medicationId);
            payload.put("doseId", doseId);
            payload.put("calendarDate", calendarDate);
            payload.put("timeHhmm", timeHhmm);
            payload.put("amount", amount);
            payload.put("scheduledAtEpochMs", triggerAt);
            if (treatmentEndDate != null && !treatmentEndDate.isEmpty()) {
                payload.put(
                        AutoDeductionContract.EXTRA_TREATMENT_END_DATE,
                        treatmentEndDate);
            }
        } catch (JSONException e) {
            Log.e(TAG, "schedule payload build failed", e);
            return ScheduleResult.fail("payload_build_failed");
        }

        synchronized (SCHEDULE_LOCK) {
            return scheduleOccurrenceLocked(
                    key,
                    key,
                    payload,
                    triggerAt,
                    null);
        }
    }

    /**
     * Auto business scheduling wrapper.
     *
     * <p>Recurrence authorization remains feature-owned here. Actual durable
     * schedule persistence, operation ordering, PendingIntent construction,
     * AlarmManager installation, and ownership-safe rollback are delegated to
     * {@link AutoDeductionSchedulingAdapter}.</p>
     */
    private ScheduleResult scheduleOccurrenceLocked(
            String prefKey,
            String key,
            JSONObject payload,
            long triggerAt,
            String requiredVersion
    ) {
        return scheduleOccurrenceLocked(
                prefKey,
                key,
                payload,
                triggerAt,
                requiredVersion,
                null);
    }

    private ScheduleResult scheduleOccurrenceLocked(
            String prefKey,
            String key,
            JSONObject payload,
            long triggerAt,
            String requiredVersion,
            Long requiredRecurrenceGeneration
    ) {
        final String medicationId = payload.optString("medicationId", "");
        final String doseId = payload.optString("doseId", "");
        final String calendarDate = payload.optString("calendarDate", "");
        final String timeHhmm = payload.optString("timeHhmm", "");
        final double amount = payload.optDouble("amount", Double.NaN);
        final String treatmentEndDate =
                payload.optString(AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
        if (!treatmentEndDate.isEmpty()
                && (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)
                || calendarDate.compareTo(treatmentEndDate) > 0)) {
            return ScheduleResult.fail("treatment_ended");
        }

        final long recurrenceGeneration;
        if (requiredRecurrenceGeneration != null) {
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId,
                    doseId,
                    requiredRecurrenceGeneration)) {
                return ScheduleResult.fail("recurrence_generation_unauthorized");
            }
            recurrenceGeneration = requiredRecurrenceGeneration;
        } else {
            long ensured = ensureRecurrenceGenerationLocked(
                    medicationId,
                    doseId);
            if (ensured <= 0L) {
                return ScheduleResult.fail("recurrence_generation_write_failed");
            }
            recurrenceGeneration = ensured;
        }

        AutoDeductionSchedulingAdapter.ScheduleResult result =
                schedulingAdapter.scheduleOccurrence(
                        key,
                        medicationId,
                        doseId,
                        calendarDate,
                        timeHhmm,
                        amount,
                        triggerAt,
                        treatmentEndDate.isEmpty() ? null : treatmentEndDate,
                        recurrenceGeneration,
                        requiredVersion);
        if (!result.ok) {
            return ScheduleResult.fail(result.error);
        }
        return ScheduleResult.success(key);
    }

    private String getScheduleRaw(String storageKey) {
        return schedulingAdapter.getScheduleRaw(storageKey);
    }

    private boolean hasSchedule(String storageKey) {
        return storageKey != null
                && !storageKey.isEmpty()
                && schedulingAdapter.hasSchedule(storageKey);
    }

    private Map<String, ?> getAllScheduleMetadata() {
        return schedulingAdapter.listScheduleMetadata();
    }

    private boolean removeScheduleIfOwned(
            String storageKey,
            String expectedOperationVersion) {
        return storageKey != null
                && !storageKey.isEmpty()
                && schedulingAdapter.removeScheduleIfOwned(
                        storageKey,
                        expectedOperationVersion);
    }

    private boolean removeSchedule(String storageKey) {
        return storageKey != null
                && !storageKey.isEmpty()
                && schedulingAdapter.removeSchedule(storageKey);
    }

    private boolean hasCancellationTombstoneStored(String occurrenceKey) {
        return occurrenceKey != null
                && !occurrenceKey.isEmpty()
                && schedulingAdapter.hasCancellationTombstone(occurrenceKey);
    }

    private boolean isEffectivelyCancelledStored(String occurrenceKey) {
        return occurrenceKey != null
                && !occurrenceKey.isEmpty()
                && schedulingAdapter.isEffectivelyCancelled(occurrenceKey);
    }

    private boolean clearCancellationTombstoneStored(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        return schedulingAdapter.clearCancellationTombstone(occurrenceKey);
    }

    /**
     * Conditional rollback — caller MUST already hold {@link #SCHEDULE_LOCK}.
     */
    private boolean removeScheduleMetadataIfVersionLocked(
            String storageKey, String expectedVersion) {
        return removeScheduleIfOwned(storageKey, expectedVersion);
    }

    /**
     * Conditional rollback with lock (for external/test use).
     * Reentrant-safe if already holding SCHEDULE_LOCK.
     */
    boolean removeScheduleMetadataIfVersion(String prefKey, String expectedVersion) {
        synchronized (SCHEDULE_LOCK) {
            return removeScheduleMetadataIfVersionLocked(prefKey, expectedVersion);
        }
    }

    /**
     * Unconditional remove — intentional cancel / malformed restore cleanup.
     * Caller must hold SCHEDULE_LOCK, or use the public cancel path.
     */
    private void removeScheduleMetadataLocked(String storageKey) {
        removeSchedule(storageKey);
    }

    private void removeScheduleMetadata(String prefKey) {
        synchronized (SCHEDULE_LOCK) {
            removeScheduleMetadataLocked(prefKey);
        }
    }

    /**
     * Cancel using the same Intent identity as schedule (action + data URI).
     * Under SCHEDULE_LOCK:
     *   1. Durable cancellation tombstone (survives process death)
     *   2. AlarmManager.cancel
     *   3. Remove active schedule metadata
     * Tombstone first so a crash after alarm cancel but before metadata remove
     * cannot later promote the stale schedule to FIRED on restore.
     *
     * Returns an explicit CancelResult:
     * SUCCESS / ALREADY_ABSENT only when the intended native state is achieved
     * (no live alarm for this occurrence + no schedule metadata, or metadata
     * removal confirmed). FAILED when AlarmManager is unavailable, tombstone
     * write fails, or metadata remove commit fails (stale metadata must not
     * be reported as success when cancellation intent is not durable).
     */
    public CancelResult cancelOccurrence(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return CancelResult.fail("invalid_args");
        }

        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        synchronized (SCHEDULE_LOCK) {
            syncAlarmRuntimeTestControls();
            AutoDeductionSchedulingAdapter.CancelResult result =
                    schedulingAdapter.cancelOccurrence(
                            medicationId,
                            doseId,
                            calendarDate);
            if (!result.isOk()) return CancelResult.fail(result.error);
            return result.status
                    == AutoDeductionSchedulingAdapter.CancelResult.Status.ALREADY_ABSENT
                    ? CancelResult.alreadyAbsent()
                    : CancelResult.success();
        }
    }

    /** True if a durable cancellation tombstone entry exists (raw presence). */
    boolean hasCancellationTombstone(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (SCHEDULE_LOCK) {
            return hasCancellationTombstoneStored(occurrenceKey);
        }
    }

    public boolean isOccurrenceCancelled(
            String medicationId,
            String doseId,
            String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return false;
        }
        return isOccurrenceCancelledKey(
                AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, calendarDate));
    }

    boolean isOccurrenceCancelledKey(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (SCHEDULE_LOCK) {
            return isEffectivelyCancelledStored(occurrenceKey);
        }
    }

    private static long[] parseOrderingToken(String raw) {
        return AutoDeductionSchedulingAdapter.parseOrdering(raw);
    }

    private static long[] parseScheduleVersionOrdering(String scheduleRaw) {
        return AutoDeductionSchedulingAdapter.parseOrdering(
                AutoDeductionSchedulingAdapter.extractOperationVersion(scheduleRaw));
    }

    private static boolean isOrderingNewer(
            long aMillis, long aSeq, long bMillis, long bSeq) {
        return AutoDeductionSchedulingAdapter.isOrderingNewer(
                aMillis, aSeq, bMillis, bSeq);
    }

    private static long parseScheduleVersionEpochMs(String scheduleRaw) {
        return parseScheduleVersionOrdering(scheduleRaw)[0];
    }

    private static long parseCancelEpochMs(String cancelRaw) {
        return parseOrderingToken(cancelRaw)[0];
    }

    private boolean clearCancellationTombstoneLocked(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        return clearCancellationTombstoneStored(occurrenceKey);
    }

    public ScheduleResult scheduleNextOccurrence(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount
    ) {
        String nextDate = nextCalendarDate(fromCalendarDate);
        if (nextDate == null) {
            return ScheduleResult.fail("invalid_next_date");
        }
        Long epoch = computeEpochMs(nextDate, timeHhmm);
        if (epoch == null) {
            return ScheduleResult.fail("invalid_next_datetime");
        }
        if (epoch <= System.currentTimeMillis()) {
            nextDate = nextCalendarDate(nextDate);
            if (nextDate == null) return ScheduleResult.fail("invalid_next_date");
            epoch = computeEpochMs(nextDate, timeHhmm);
            if (epoch == null) return ScheduleResult.fail("invalid_next_datetime");
        }
        return scheduleOccurrence(medicationId, doseId, nextDate, timeHhmm, amount, epoch);
    }

    /**
     * Schedule the next calendar-date occurrence only if it is absent and not
     * effectively cancelled.
     *
     * <p>Under one continuous {@link #SCHEDULE_LOCK} critical section:
     * <ul>
     *   <li>If D+1 durable schedule metadata already exists — return success
     *       without rewriting amount/time/alarm (duplicate/stale D payload must
     *       not overwrite a newer authoritative successor).</li>
     *   <li>If D+1 metadata is absent but the occurrence is effectively cancelled
     *       ({@link #isOccurrenceCancelledKey}) — return success without calling
     *       {@link #scheduleOccurrenceLocked}. Creating would clear the
     *       cancellation tombstone and resurrect a previously cancelled D+1.</li>
     *   <li>If D+1 is absent and not cancelled — install via
     *       {@link #scheduleOccurrenceLocked}.</li>
     * </ul>
     *
     * <p>Used by live fire recurrence ({@code AutoDeductionReceiver}) so
     * {@code ALREADY_EXISTS} / pending recovery cannot corrupt an existing D+1
     * or resurrect a cancelled successor.
     */
    /**
     * @param expectedRecurrenceGeneration generation stamped on the firing occurrence's
     *        Intent. Must be {@code > 0} and match the durable active generation;
     *        otherwise successor creation is refused.
     */
    public ScheduleResult scheduleNextOccurrenceIfAbsent(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount,
            long expectedRecurrenceGeneration
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(fromCalendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)) {
            return ScheduleResult.fail("invalid_args");
        }

        String nextDate = nextCalendarDate(fromCalendarDate);
        if (nextDate == null) {
            return ScheduleResult.fail("invalid_next_date");
        }
        Long epoch = computeEpochMs(nextDate, timeHhmm);
        if (epoch == null) {
            return ScheduleResult.fail("invalid_next_datetime");
        }
        if (epoch <= System.currentTimeMillis()) {
            nextDate = nextCalendarDate(nextDate);
            if (nextDate == null) return ScheduleResult.fail("invalid_next_date");
            epoch = computeEpochMs(nextDate, timeHhmm);
            if (epoch == null) return ScheduleResult.fail("invalid_next_datetime");
        }

        final String resolvedNextDate = nextDate;
        final long triggerAt = epoch;
        final String nextKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, resolvedNextDate);
        final String nextPrefKey = nextKey;

        if (!canScheduleExactAlarms()) {
            synchronized (SCHEDULE_LOCK) {
                if (hasSchedule(nextPrefKey)) {
                    return ScheduleResult.success(nextKey);
                }
                // Absent + cancelled: do not report permission denial as a need to create.
                if (isOccurrenceCancelledKey(nextKey)) {
                    Log.i(TAG, "scheduleNextOccurrenceIfAbsent: successor cancelled — "
                            + "not recreating " + nextKey);
                    return ScheduleResult.success(nextKey);
                }
            }
            return ScheduleResult.fail("exact_alarm_permission_denied");
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("medicationId", medicationId);
            payload.put("doseId", doseId);
            payload.put("calendarDate", resolvedNextDate);
            payload.put("timeHhmm", timeHhmm);
            payload.put("amount", amount);
            payload.put("scheduledAtEpochMs", triggerAt);
        } catch (JSONException e) {
            Log.e(TAG, "scheduleNextOccurrenceIfAbsent payload failed", e);
            return ScheduleResult.fail("payload_failed");
        }

        synchronized (SCHEDULE_LOCK) {
            String treatmentEndDate = "";
            String currentRaw = getScheduleRaw(
                    AutoDeductionContract.occurrenceKey(
                            medicationId, doseId, fromCalendarDate));
            if (currentRaw != null && !currentRaw.isEmpty()) {
                try {
                    treatmentEndDate = new JSONObject(currentRaw).optString(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
                } catch (JSONException e) {
                    return ScheduleResult.fail("malformed_current_schedule");
                }
            }
            if (!treatmentEndDate.isEmpty()) {
                if (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
                    return ScheduleResult.fail("invalid_treatment_end_date");
                }
                if (resolvedNextDate.compareTo(treatmentEndDate) > 0) {
                    return new ScheduleResult(true, "treatment_ended", nextKey);
                }
                try {
                    payload.put(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE,
                            treatmentEndDate);
                } catch (JSONException e) {
                    return ScheduleResult.fail("payload_failed");
                }
            }

            // Issue #217: refuse successor if disable/cancel invalidated this chain.
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                Log.i(TAG, "scheduleNextOccurrenceIfAbsent: recurrence generation invalid — "
                        + "not creating successor for " + medicationId + "/" + doseId
                        + " expectedGen=" + expectedRecurrenceGeneration);
                return ScheduleResult.fail("recurrence_authorization_invalid");
            }
            if (hasSchedule(nextPrefKey)) {
                Log.i(TAG, "scheduleNextOccurrenceIfAbsent: successor already present — "
                        + "not overwriting " + nextPrefKey);
                return ScheduleResult.success(nextKey);
            }
            // Metadata absent but cancellation tombstone still effective: must not
            // call scheduleOccurrenceLocked (it would clear the tombstone and
            // resurrect the cancelled D+1 from a stale/duplicate D delivery).
            if (isOccurrenceCancelledKey(nextKey)) {
                Log.i(TAG, "scheduleNextOccurrenceIfAbsent: successor cancelled — "
                        + "not recreating " + nextKey);
                return ScheduleResult.success(nextKey);
            }
            return scheduleOccurrenceLocked(
                    nextPrefKey, nextKey, payload, triggerAt, /*requiredVersion*/ null);
        }
    }

    /**
     * After a past occurrence is recovered as a durable fire, continue the
     * recurrence chain and only then resolve snapshot-owned schedule metadata.
     *
     * <p>State table:
     * <ul>
     *   <li>CANCELLED — no successor; ownership-safe remove of stale V1</li>
     *   <li>CREATED / ALREADY_EXISTS / FAILED+pending — schedule D+1 only while
     *       the snapshot still owns D; remove V1 only if successor is established</li>
     *   <li>FAILED without pending — no successor; keep metadata as recovery source</li>
     * </ul>
     *
     * <p>Stale-snapshot protection: under {@link #SCHEDULE_LOCK}, the snapshot's
     * {@code observedVersion} must still own the past schedule metadata before
     * any successor is installed from snapshot {@code timeHhmm}/{@code amount}.
     * If D was replaced (newer version) or removed, the snapshot is stale — do
     * not schedule/overwrite D+1 with obsolete parameters. If D+1 already exists,
     * leave it untouched (do not replace with snapshot params).
     */
    private void continueRecurrenceAfterPastRecovery(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            FireResult fr,
            String prefKey,
            String observedVersion
    ) {
        if (fr == null) {
            return;
        }
        if (fr.isCancelled()) {
            if (!removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                Log.i(TAG, "restore past cancel cleanup skipped (ownership lost): " + prefKey);
            }
            return;
        }
        if (!fr.allowsRecurrence()) {
            // FAILED with no durable fire/pending — keep schedule metadata.
            Log.e(TAG, "restore past: FIRED and pending both failed for "
                    + medicationId + "/" + doseId + "/" + calendarDate
                    + " — preserving schedule metadata as recovery source");
            return;
        }

        // Durable fire accepted → establish successor only if snapshot still owns D.
        ScheduleResult next = scheduleNextOccurrenceIfSnapshotOwnsPast(
                medicationId, doseId, calendarDate, timeHhmm, amount, prefKey, observedVersion);
        if (!next.ok) {
            if ("snapshot_stale".equals(next.error)) {
                Log.i(TAG, "restore past: snapshot stale — not scheduling successor from "
                        + "obsolete params: " + medicationId + "/" + doseId + "/" + calendarDate);
                // Do not remove newer D metadata; do not overwrite D+1.
                return;
            }
            Log.w(TAG, "restore past: successor not scheduled (" + next.error
                    + ") — keeping past metadata for retry: "
                    + medicationId + "/" + doseId + "/" + calendarDate);
            return;
        }
        Log.i(TAG, "restore past: recurrence continued to next occurrence for "
                + medicationId + "/" + doseId + "/" + calendarDate
                + " (fire=" + fr.status + ", pendingRecorded=" + fr.pendingRecorded + ")");

        if (!removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
            Log.i(TAG, "restore past metadata keep (ownership lost / already gone): " + prefKey);
        }
    }

    /**
     * Schedule D+1 from a past-recovery snapshot only while that snapshot still
     * owns the past schedule row. Caller may not hold {@link #SCHEDULE_LOCK}.
     *
     * <p>Under one continuous critical section:
     * <ol>
     *   <li>Confirm {@code pastPrefKey} metadata is still owned by {@code observedVersion}</li>
     *   <li>If not → {@code snapshot_stale} (no D+1 write)</li>
     *   <li>If D+1 metadata already exists → success without overwrite</li>
     *   <li>Otherwise install D+1 via {@link #scheduleOccurrenceLocked}</li>
     * </ol>
     */
    private ScheduleResult scheduleNextOccurrenceIfSnapshotOwnsPast(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount,
            String pastPrefKey,
            String observedVersion
    ) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(fromCalendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)
                || !AutoDeductionContract.isValidAmount(amount)) {
            return ScheduleResult.fail("invalid_args");
        }
        if (pastPrefKey == null || pastPrefKey.isEmpty()
                || observedVersion == null || observedVersion.isEmpty()) {
            // Without a durable ownership token the snapshot cannot authorize D+1.
            return ScheduleResult.fail("snapshot_stale");
        }

        String nextDate = nextCalendarDate(fromCalendarDate);
        if (nextDate == null) {
            return ScheduleResult.fail("invalid_next_date");
        }
        Long epoch = computeEpochMs(nextDate, timeHhmm);
        if (epoch == null) {
            return ScheduleResult.fail("invalid_next_datetime");
        }
        if (epoch <= System.currentTimeMillis()) {
            nextDate = nextCalendarDate(nextDate);
            if (nextDate == null) return ScheduleResult.fail("invalid_next_date");
            epoch = computeEpochMs(nextDate, timeHhmm);
            if (epoch == null) return ScheduleResult.fail("invalid_next_datetime");
        }

        if (!canScheduleExactAlarms()) {
            // D+1 may already exist — check under lock; otherwise cannot install.
            synchronized (SCHEDULE_LOCK) {
                if (!isMetadataOwnedByVersion(
                        getScheduleRaw(pastPrefKey), observedVersion)) {
                    return ScheduleResult.fail("snapshot_stale");
                }
                String nextKey = AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, nextDate);
                if (hasSchedule(nextKey)) {
                    return ScheduleResult.success(nextKey);
                }
            }
            return ScheduleResult.fail("exact_alarm_permission_denied");
        }

        final String resolvedNextDate = nextDate;
        final long triggerAt = epoch;
        final String nextKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, resolvedNextDate);
        final String nextPrefKey = nextKey;

        synchronized (SCHEDULE_LOCK) {
            // Snapshot must still own past D — otherwise amount/time are obsolete.
            String currentPast = getScheduleRaw(pastPrefKey);
            if (!isMetadataOwnedByVersion(currentPast, observedVersion)) {
                return ScheduleResult.fail("snapshot_stale");
            }
            // Issue #217: do not continue recurrence for an invalidated generation.
            long snapGen = 0L;
            try {
                if (currentPast != null) {
                    snapGen = getEffectiveRecurrenceGenerationLocked(
                            medicationId,
                            doseId,
                            new JSONObject(currentPast));
                }
            } catch (JSONException ignored) { /* treat as 0 */ }
            if (!isRecurrenceGenerationAuthorizedLocked(medicationId, doseId, snapGen)) {
                Log.i(TAG, "restore past: recurrence generation invalid — no successor for "
                        + medicationId + "/" + doseId);
                return ScheduleResult.fail("recurrence_authorization_invalid");
            }
            String treatmentEndDate = "";
            if (currentPast != null && !currentPast.isEmpty()) {
                try {
                    treatmentEndDate = new JSONObject(currentPast).optString(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
                } catch (JSONException e) {
                    return ScheduleResult.fail("snapshot_stale");
                }
            }
            if (!treatmentEndDate.isEmpty()) {
                if (!AutoDeductionContract.isValidCalendarDate(treatmentEndDate)) {
                    return ScheduleResult.fail("invalid_treatment_end_date");
                }
                if (resolvedNextDate.compareTo(treatmentEndDate) > 0) {
                    return new ScheduleResult(
                            true,
                            "treatment_ended",
                            nextKey);
                }
            }

            JSONObject payload = new JSONObject();
            try {
                payload.put("medicationId", medicationId);
                payload.put("doseId", doseId);
                payload.put("calendarDate", resolvedNextDate);
                payload.put("timeHhmm", timeHhmm);
                payload.put("amount", amount);
                payload.put("scheduledAtEpochMs", triggerAt);
                if (!treatmentEndDate.isEmpty()) {
                    payload.put(
                            AutoDeductionContract.EXTRA_TREATMENT_END_DATE,
                            treatmentEndDate);
                }
            } catch (JSONException e) {
                Log.e(TAG, "scheduleNextOccurrenceIfSnapshotOwnsPast payload failed", e);
                return ScheduleResult.fail("payload_failed");
            }

            // Never overwrite an existing successor with recovery snapshot params.
            if (hasSchedule(nextPrefKey)) {
                Log.i(TAG, "restore past: successor already present — not overwriting "
                        + nextPrefKey);
                return ScheduleResult.success(nextKey);
            }
            return scheduleOccurrenceLocked(
                    nextPrefKey, nextKey, payload, triggerAt, /*requiredVersion*/ null);
        }
    }

    /**
     * Restore future alarms from persisted schedule payloads (reboot).
     *
     * Snapshot under lock (prefKey + raw JSON + observed operationVersion).
     * For each future entry, ownership validation + AlarmManager install +
     * metadata rewrite run under one continuous SCHEDULE_LOCK critical section
     * so cancel cannot interleave and resurrect a canceled schedule.
     *
     * Past schedule entries: promote via fireOccurrenceIfNotCancelled, schedule
     * the next occurrence when the fire is durable (CREATED / ALREADY_EXISTS /
     * pending), then ownership-safe metadata removal. Metadata is removed only
     * when the current operationVersion still matches the snapshot observedVersion
     * and successor scheduling succeeded (or the occurrence was CANCELLED), so a
     * newer legitimate reschedule is never deleted and recurrence is not lost.
     */
    /**
     * Explicit result of native future-schedule restoration.
     * {@code ok=false} means the recovery boundary is incomplete — JS must not
     * run destructive desired-state cleanup based on a partial snapshot.
     */
    public static final class RestoreResult {
        public final boolean ok;
        public final int restored;
        public final int failed;
        public final String error;

        public RestoreResult(boolean ok, int restored, int failed, String error) {
            this.ok = ok;
            this.restored = restored;
            this.failed = failed;
            this.error = error;
        }

        public static RestoreResult success(int restored, int failed) {
            return new RestoreResult(true, restored, failed, null);
        }

        public static RestoreResult failure(int restored, int failed, String error) {
            return new RestoreResult(false, restored, failed, error);
        }
    }

    public RestoreResult restoreFutureSchedules() {
        if (!canScheduleExactAlarms()) {
            Log.w(TAG, "restoreFutureSchedules: exact alarm permission denied");
            // Still attempt past-schedule promotion to FIRED.
        }
        int restored = 0;
        int failed = 0;
        boolean boundaryOk = true;
        if (forceRestoreFutureFailureForTest) {
            return RestoreResult.failure(0, 0, "forced_restore_failure");
        }

        java.util.List<String[]> snapshot = new java.util.ArrayList<>();
        synchronized (SCHEDULE_LOCK) {
            Map<String, ?> all = getAllScheduleMetadata();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                String raw = (String) v;
                String observedVersion = "";
                try {
                    JSONObject tmp = new JSONObject(raw);
                    observedVersion = AutoDeductionSchedulingAdapter.extractOperationVersion(tmp);
                } catch (JSONException ignored) {
                }
                snapshot.add(new String[]{ e.getKey(), raw, observedVersion });
            }
        }

        for (String[] entry : snapshot) {
            String prefKey = entry[0];
            String raw = entry[1];
            String observedVersion = entry[2];
            try {
                JSONObject o = new JSONObject(raw);
                String medId = o.optString("medicationId", "");
                String doseId = o.optString("doseId", "");
                String date = o.optString("calendarDate", "");
                String time = o.optString("timeHhmm", "");
                double amount = o.optDouble("amount", Double.NaN);
                long epoch = o.optLong("scheduledAtEpochMs", 0L);
                String treatmentEndDate = o.optString(
                        AutoDeductionContract.EXTRA_TREATMENT_END_DATE, "");
                boolean validTreatmentEndDate =
                        treatmentEndDate.isEmpty()
                                || AutoDeductionContract.isValidCalendarDate(treatmentEndDate);
                ScheduleStorageIdentity keyIdentity = parseScheduleStorageKey(prefKey);
                boolean validPayload =
                        !medId.isEmpty()
                        && !doseId.isEmpty()
                        && AutoDeductionContract.isValidCalendarDate(date)
                        && AutoDeductionContract.isValidTimeHhmm(time)
                        && AutoDeductionContract.isValidAmount(amount)
                        && validTreatmentEndDate;
                boolean keyMatchesPayload =
                        keyIdentity != null
                        && keyIdentity.medicationId.equals(medId)
                        && keyIdentity.doseId.equals(doseId)
                        && keyIdentity.calendarDate.equals(date);
                if (!validPayload || !keyMatchesPayload) {
                    String reason = !validPayload
                            ? "malformed_fields"
                            : "identity_mismatch";
                    if (!quarantineMalformedScheduleMetadata(prefKey, raw, reason)) {
                        Log.e(TAG, "restore: malformed schedule quarantine failed for " + prefKey);
                        failed++;
                        boundaryOk = false;
                    }
                    // quarantine success OR fail-closed: do not treat unproven cleanup as ok
                    continue;
                }

                String occurrenceKey = AutoDeductionContract.occurrenceKey(medId, doseId, date);

                if (!treatmentEndDate.isEmpty()
                        && date.compareTo(treatmentEndDate) > 0) {
                    synchronized (SCHEDULE_LOCK) {
                        if (!isMetadataOwnedByVersion(
                                getScheduleRaw(prefKey), observedVersion)) {
                            continue;
                        }
                        AutoDeductionSchedulingAdapter.CancelResult cancel =
                                schedulingAdapter.cancelOccurrence(medId, doseId, date);
                        if (!cancel.isOk()) {
                            failed++;
                            boundaryOk = false;
                        }
                    }
                    continue;
                }

                if (epoch <= 0) {
                    Long computed = computeEpochMs(date, time);
                    if (computed == null) {
                        // Unrecoverable epoch — cleanup; ownership_lost is not failure.
                        if (!removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                            Log.i(TAG, "restore: epoch-null cleanup ownership_lost/gone: " + prefKey);
                        }
                        // Cannot prove recovery of a valid schedule — leave as resolved via drop.
                        continue;
                    }
                    epoch = computed;
                }

                // Issue #243: multi-day catch-up — every due occurrence from this
                // snapshot date forward is recovered as FIRED (no horizon); the first
                // not-yet-due date becomes the live AlarmManager schedule.
                if (epoch <= recoveryNowMs()) {
                    if (!new AutoDeductionStockStore(appContext()).isInitialized()) {
                        Log.i(TAG, "restore: past occurrence deferred until Native stock is initialized: "
                                + prefKey);
                        continue;
                    }
                    long snapGen;
                    synchronized (SCHEDULE_LOCK) {
                        snapGen = getEffectiveRecurrenceGenerationLocked(
                                medId, doseId, o);
                    }
                    CatchUpResult catchUp = catchUpMissedOccurrencesAndScheduleNext(
                            medId, doseId, date, time, amount, snapGen,
                            prefKey, observedVersion);
                    // restored counts future AlarmManager installs only (not FIRED rows).
                    if (catchUp.futureInstalled) {
                        restored++;
                    }
                    if (catchUp.incomplete) {
                        Log.e(TAG, "restore: catch-up incomplete for " + prefKey);
                        failed++;
                        boundaryOk = false;
                    }
                    continue;
                }

                // Future: effectively cancelled → never reinstall; drop stale metadata.
                // A newer schedule metadata supersedes a leftover tombstone so legitimate
                // reschedule is not suppressed.
                if (isOccurrenceCancelledKey(occurrenceKey)) {
                    Log.i(TAG, "restore skip (cancelled): " + medId + "/" + doseId + "/" + date);
                    // Prior cancellation is expected; ownership_lost on cleanup is not failure.
                    if (!removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                        Log.i(TAG, "restore future cancel cleanup skipped (ownership lost): "
                                + prefKey);
                    }
                    continue;
                }
                // Leftover tombstone under a superseding schedule: best-effort cleanup.
                if (hasCancellationTombstone(occurrenceKey)) {
                    synchronized (SCHEDULE_LOCK) {
                        clearCancellationTombstoneLocked(occurrenceKey);
                    }
                }

                if (!canScheduleExactAlarms()) {
                    // Future schedule requires AlarmManager — cannot complete recovery.
                    Log.w(TAG, "restore: exact alarm permission denied for future " + prefKey);
                    failed++;
                    boundaryOk = false;
                    continue;
                }

                // Rebuild epoch from calendarDate + timeHhmm in the *current* default
                // timezone so a TIMEZONE_CHANGED restore does not reinstall a stale epoch.
                Long recomputed = computeEpochMs(date, time);
                if (recomputed == null) {
                    if (!removeScheduleMetadataIfVersion(prefKey, observedVersion)) {
                        Log.i(TAG, "restore: recompute-null cleanup ownership_lost: " + prefKey);
                    }
                    continue;
                }
                if (recomputed <= recoveryNowMs()) {
                    // After TZ change this occurrence is now in the past: multi-day catch-up.
                    if (!new AutoDeductionStockStore(appContext()).isInitialized()) {
                        Log.i(TAG, "restore: TZ past occurrence deferred until Native stock is initialized: "
                                + prefKey);
                        continue;
                    }
                    long snapGenTz;
                    synchronized (SCHEDULE_LOCK) {
                        snapGenTz = getEffectiveRecurrenceGenerationLocked(
                                medId, doseId, o);
                    }
                    CatchUpResult catchUp = catchUpMissedOccurrencesAndScheduleNext(
                            medId, doseId, date, time, amount, snapGenTz,
                            prefKey, observedVersion);
                    if (catchUp.futureInstalled) {
                        restored++;
                    }
                    if (catchUp.incomplete) {
                        Log.e(TAG, "restore: TZ catch-up incomplete for " + prefKey);
                        failed++;
                        boundaryOk = false;
                    }
                    continue;
                }
                epoch = recomputed;

                // Future: atomic ownership check + schedule under one lock.
                // operationVersion is assigned inside scheduleOccurrenceLocked (under
                // SCHEDULE_LOCK) so ordering vs concurrent cancel is correct.
                String key = occurrenceKey;
                JSONObject payload = new JSONObject();
                try {
                    payload.put("medicationId", medId);
                    payload.put("doseId", doseId);
                    payload.put("calendarDate", date);
                    payload.put("timeHhmm", time);
                    payload.put("amount", amount);
                    payload.put("scheduledAtEpochMs", epoch);
                    if (!treatmentEndDate.isEmpty()) {
                        payload.put(
                                AutoDeductionContract.EXTRA_TREATMENT_END_DATE,
                                treatmentEndDate);
                    }
                } catch (JSONException e) {
                    Log.e(TAG, "restore payload build failed", e);
                    failed++;
                    boundaryOk = false;
                    continue;
                }
                synchronized (SCHEDULE_LOCK) {
                    // Issue #217: drop future schedules whose generation was invalidated.
                    long metaGen = getEffectiveRecurrenceGenerationLocked(
                            medId, doseId, o);
                    if (metaGen > 0L
                            && !isRecurrenceGenerationAuthorizedLocked(medId, doseId, metaGen)) {
                        Log.i(TAG, "restore skip (recurrence generation invalid): " + prefKey);
                        // Dropping invalidated generation is expected; ownership_lost ok.
                        removeScheduleMetadataIfVersionLocked(prefKey, observedVersion);
                        continue;
                    }
                    ScheduleResult r = scheduleOccurrenceLocked(
                            prefKey, key, payload, epoch, observedVersion);
                    if (r.ok) {
                        restored++;
                    } else if ("ownership_lost".equals(r.error)) {
                        // Canceled or replaced after snapshot — expected concurrent outcome.
                        Log.i(TAG, "restore skip (ownership lost): " + prefKey);
                    } else {
                        Log.w(TAG, "restore schedule failed for " + prefKey + ": " + r.error);
                        failed++;
                        boundaryOk = false;
                    }
                }
            } catch (JSONException ignored) {
                // Malformed snapshot payload: quarantine only if the exact snapshot is
                // still current; otherwise leave a newer replacement untouched.
                if (!quarantineMalformedScheduleMetadata(prefKey, raw, "invalid_json")) {
                    Log.e(TAG, "restore: invalid JSON schedule quarantine failed for " + prefKey);
                    failed++;
                    boundaryOk = false;
                }
            }
        }

        // Also recover independent fire-retry evidence (may exist without shared schedule rows).
        RestoreResult retryPass = recoverIndependentFireRetryEvidencePass();
        restored += retryPass.restored;
        failed += retryPass.failed;
        if (!retryPass.ok) {
            boundaryOk = false;
        }

        if (!boundaryOk || failed > 0) {
            return RestoreResult.failure(restored, failed,
                    failed > 0 ? "restore_boundary_incomplete" : "restore_boundary_incomplete");
        }
        return RestoreResult.success(restored, failed);
    }


    /** Parsed medicationId + doseId + calendarDate from an Auto occurrence storage key. */
    private static final class ScheduleStorageIdentity {
        final String medicationId;
        final String doseId;
        final String calendarDate;

        ScheduleStorageIdentity(String medicationId, String doseId, String calendarDate) {
            this.medicationId = medicationId;
            this.doseId = doseId;
            this.calendarDate = calendarDate;
        }
    }

    /**
     * Parse the canonical Auto occurrence identity encoded in the durable storage key.
     * Returns null when the key cannot identify exactly one occurrence.
     */
    private static ScheduleStorageIdentity parseScheduleStorageKey(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) {
            return null;
        }
        String encoded = storageKey;
        final char separator = '\u001f';
        int first = encoded.indexOf(separator);
        int second = first >= 0
                ? encoded.indexOf(separator, first + 1)
                : -1;
        if (first <= 0 || second <= first + 1 || second >= encoded.length() - 1) {
            return null;
        }
        if (encoded.indexOf(separator, second + 1) >= 0) {
            return null;
        }
        String medicationId = encoded.substring(0, first);
        String doseId = encoded.substring(first + 1, second);
        String calendarDate = encoded.substring(second + 1);
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return null;
        }
        return new ScheduleStorageIdentity(medicationId, doseId, calendarDate);
    }

    /**
     * Quarantine malformed schedule metadata without trusting its payload identity.
     *
     * <p>The storage key is the only identity source we use for cancellation. When
     * that key is canonical, cancel the matching PendingIntent first and then remove
     * the malformed durable row. If the key is not canonical, no alarm identity can
     * be reconstructed safely, so the row is left untouched and the caller must fail
     * closed rather than pretending the native listing is authoritative.
     *
     * <p>If {@code expectedRaw} no longer matches the current row, the snapshot became
     * stale; leave the newer row untouched and report success/no-op.
     */
    private boolean quarantineMalformedScheduleMetadata(
            String prefKey,
            String expectedRaw,
            String reason
    ) {
        synchronized (SCHEDULE_LOCK) {
            String currentRaw = getScheduleRaw(prefKey);
            if (currentRaw == null) return true;
            if (expectedRaw != null && !expectedRaw.equals(currentRaw)) return true;

            ScheduleStorageIdentity identity = parseScheduleStorageKey(prefKey);
            if (identity == null) return false;

            String occurrenceKey = AutoDeductionContract.occurrenceKey(
                    identity.medicationId,
                    identity.doseId,
                    identity.calendarDate);
            syncAlarmRuntimeTestControls();
            AutoDeductionSchedulingAdapter.CancelResult result =
                    schedulingAdapter.cancelOccurrence(
                            identity.medicationId,
                            identity.doseId,
                            identity.calendarDate);
            if (!result.isOk()) return false;

            Log.w(TAG, "quarantined malformed schedule metadata: " + prefKey
                    + " reason=" + reason);
            return true;
        }
    }

    /**
     * List durable schedule metadata entries (not AlarmManager state).
     * Used by JS to reconcile desired set against native after process restart
     * so stale schedules can be canceled even when trackedRef is empty.
     *
     * <p>Malformed rows are not silently skipped. Rows whose storage key still
     * identifies a real occurrence are quarantined (alarm canceled + metadata
     * removed). When the key itself is unsafe, this method throws so the JS bridge
     * reports a listing failure instead of treating the malformed row as absence.
     */
    public java.util.List<JSONObject> listScheduledOccurrences() {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        synchronized (SCHEDULE_LOCK) {
            Map<String, ?> all = getAllScheduleMetadata();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                String prefKey = e.getKey();
                String raw = (String) v;
                try {
                    JSONObject o = new JSONObject(raw);
                    String medId = o.optString("medicationId", "").trim();
                    String doseId = o.optString("doseId", "").trim();
                    String date = o.optString("calendarDate", "").trim();
                    String time = o.optString("timeHhmm", "").trim();
                    double amount = o.optDouble("amount", Double.NaN);

                    ScheduleStorageIdentity keyIdentity = parseScheduleStorageKey(prefKey);
                    boolean validPayload =
                            !medId.isEmpty()
                            && !doseId.isEmpty()
                            && AutoDeductionContract.isValidCalendarDate(date)
                            && AutoDeductionContract.isValidTimeHhmm(time)
                            && AutoDeductionContract.isValidAmount(amount);
                    boolean keyMatchesPayload =
                            keyIdentity != null
                            && keyIdentity.medicationId.equals(medId)
                            && keyIdentity.doseId.equals(doseId)
                            && keyIdentity.calendarDate.equals(date);

                    if (!validPayload || !keyMatchesPayload) {
                        String reason = !validPayload
                                ? "malformed_fields"
                                : "identity_mismatch";
                        if (!quarantineMalformedScheduleMetadata(prefKey, raw, reason)) {
                            throw new IllegalStateException(
                                    "malformed_schedule_metadata_cleanup_failed");
                        }
                        continue;
                    }
                    JSONObject retryEvidence =
                            getIndependentFireRetryEvidence(
                                    medId, doseId, date);
                    if (retryEvidence != null) {
                        int retryCount =
                                retryEvidence.optInt("retryCount", 0);
                        if (retryCount > 0) {
                            o.put("fireRetryCount", retryCount);
                        }
                    }
                    out.add(o);
                } catch (JSONException ex) {
                    if (!quarantineMalformedScheduleMetadata(
                            prefKey, raw, "invalid_json")) {
                        throw new IllegalStateException(
                                "malformed_schedule_metadata_cleanup_failed");
                    }
                }
            }
        }
        return out;
    }

    public boolean canScheduleExactAlarms() {
        return schedulingAdapter.canScheduleExactAlarms();
    }

    public static Long computeEpochMs(String calendarDate, String timeHhmm) {
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            return null;
        }
        Long resolved = AutoDeductionSchedulingAdapter.resolveLocalDateTimeEpochMs(
                calendarDate,
                timeHhmm,
                true);
        return resolved == null || resolved.longValue() < 0L
                ? null
                : resolved;
    }

    public static String nextCalendarDate(String calendarDate) {
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)) return null;
        try {
            int y = Integer.parseInt(calendarDate.substring(0, 4));
            int mo = Integer.parseInt(calendarDate.substring(5, 7));
            int d = Integer.parseInt(calendarDate.substring(8, 10));
            Calendar cal = Calendar.getInstance(TimeZone.getDefault(), Locale.getDefault());
            cal.clear();
            cal.set(Calendar.YEAR, y);
            cal.set(Calendar.MONTH, mo - 1);
            cal.set(Calendar.DAY_OF_MONTH, d);
            cal.add(Calendar.DAY_OF_MONTH, 1);
            return String.format(
                    Locale.US,
                    "%04d-%02d-%02d",
                    cal.get(Calendar.YEAR),
                    cal.get(Calendar.MONTH) + 1,
                    cal.get(Calendar.DAY_OF_MONTH)
            );
        } catch (Exception e) {
            return null;
        }
    }
    /**
     * Atomic occurrence state snapshot under {@link #SCHEDULE_LOCK} for Manual Take
     * amount authority (Phase 4). Linearizes with fireOccurrenceIfNotCancelled and
     * cancelOccurrence on the same lock.
     *
     * <ol>
     *   <li>Promote pending-fire records</li>
     *   <li>Unreconciled FIRED → FIRED + native event amount. Malformed FIRED
     *       payloads (invalid identity/calendar/amount) are terminalized by
     *       the EventStore as REJECTED and never surface as FIRED here.</li>
     *   <li>Effective cancellation via ordering tokens ({@link #isOccurrenceCancelledKey})
     *       → CANCELLED. Beats stale schedule metadata when a tombstone exists and
     *       metadata removal failed, unless a strictly newer schedule ordering token
     *       supersedes the cancellation.</li>
     *   <li>Durable schedule metadata → SCHEDULED + schedule amount</li>
     *   <li>Otherwise → ABSENT</li>
     * </ol>
     * Order: FIRED → effective CANCELLED → SCHEDULED → ABSENT.
     * Does not read JS doseSchedule.
     */
    public static final class OccurrenceSnapshot {
        public enum Status { FIRED, SCHEDULED, CANCELLED, ABSENT }

        public final boolean ok;
        public final Status status;
        /** Present for FIRED and SCHEDULED when amount is valid; null otherwise. */
        public final Double amount;
        /** Non-null only when the native lookup failed before a safe snapshot was established. */
        public final String error;

        public OccurrenceSnapshot(Status status, Double amount) {
            this(true, status, amount, null);
        }

        private OccurrenceSnapshot(boolean ok, Status status, Double amount, String error) {
            this.ok = ok;
            this.status = status;
            this.amount = amount;
            this.error = error;
        }

        public static OccurrenceSnapshot failure(String error) {
            return new OccurrenceSnapshot(
                    false,
                    Status.ABSENT,
                    null,
                    error != null && !error.isEmpty() ? error : "snapshot_failed");
        }
    }

    public OccurrenceSnapshot getOccurrenceSnapshot(
            String medicationId, String doseId, String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return new OccurrenceSnapshot(OccurrenceSnapshot.Status.ABSENT, null);
        }
        final String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        synchronized (SCHEDULE_LOCK) {
            AutoDeductionEventStore store = new AutoDeductionEventStore(appContext);
            // Promote pending under EventStore.LOCK (nested after SCHEDULE_LOCK).
            AutoDeductionEventStore.EventLookupResult firedLookup =
                    store.getFiredUnreconciledEvent(medicationId, doseId, calendarDate);
            if (!firedLookup.ok) {
                // Fail-closed: a FIRED row that could not be durably terminalized
                // is NOT equivalent to ABSENT/SCHEDULED. Manual Take must not
                // fall back to the JS schedule amount in this situation.
                return OccurrenceSnapshot.failure(firedLookup.error);
            }
            JSONObject fired = firedLookup.event;
            if (fired != null) {
                double amt = fired.optDouble("amount", Double.NaN);
                if (AutoDeductionContract.isValidAmount(amt)) {
                    return new OccurrenceSnapshot(OccurrenceSnapshot.Status.FIRED, amt);
                }
                // Defensive invariant guard. EventStore currently rejects malformed
                // FIRED rows before returning them, so this should be unreachable.
                return OccurrenceSnapshot.failure("invalid_fired_amount");
            }
            // Effective cancellation (ordering-token aware) must beat stale schedule
            // metadata when a tombstone exists but metadata removal failed.
            if (isOccurrenceCancelledKey(key)) {
                return new OccurrenceSnapshot(OccurrenceSnapshot.Status.CANCELLED, null);
            }
            final String prefKey = key;
            String metaRaw = getScheduleRaw(prefKey);
            if (metaRaw != null && !metaRaw.isEmpty()) {
                try {
                    JSONObject meta = new JSONObject(metaRaw);
                    double amt = meta.optDouble("amount", Double.NaN);
                    if (AutoDeductionContract.isValidAmount(amt)) {
                        return new OccurrenceSnapshot(
                                OccurrenceSnapshot.Status.SCHEDULED, amt);
                    }
                    return new OccurrenceSnapshot(OccurrenceSnapshot.Status.SCHEDULED, null);
                } catch (JSONException e) {
                    Log.w(TAG, "getOccurrenceSnapshot schedule parse failed for " + key, e);
                    return new OccurrenceSnapshot(OccurrenceSnapshot.Status.SCHEDULED, null);
                }
            }
            return new OccurrenceSnapshot(OccurrenceSnapshot.Status.ABSENT, null);
        }
    }


}