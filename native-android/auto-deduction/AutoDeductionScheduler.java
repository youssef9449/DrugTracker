package app.drugtracker.autodeduction;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;

/**
 * One-shot exact-time auto-deduction scheduler (AlarmManager).
 *
 * PendingIntent identity:
 *   - ACTION_AUTO_DEDUCTION
 *   - data URI = occurrenceUri(med, dose, date)  [full identity]
 *   - fixed request code PENDING_INTENT_REQUEST_CODE (namespace only)
 *
 * Scheduler transaction serialization (SCHEDULE_LOCK):
 *   For each occurrence, one process-wide critical section covers:
 *     1. durable metadata commit (with scheduleVersion)
 *     2. AlarmManager setExact / setExactAndAllowWhileIdle
 *     3. ownership-safe failure rollback
 *   cancelOccurrence uses the same lock for alarm cancel + metadata remove.
 *   This prevents interleaving that could leave metadata=B while alarm=A.
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
 * scheduleVersion remains an ownership guard for rollback (belt-and-suspenders
 * against concurrent metadata replace). It is NOT a medication-level disable epoch.
 *
 * Recurrence authorization (Issue #217):
 *   PREFS_RECURRENCE_AUTH holds a monotonic generation per (medicationId, doseId).
 *   scheduleOccurrence stamps the active generation into metadata + Intent.
 *   invalidateRecurrenceAuthorization bumps the generation under SCHEDULE_LOCK and
 *   cancels all future scheduled occurrences for that dose slot so post-fire
 *   scheduleNextOccurrenceIfAbsent cannot create D+1 after disable, and restore
 *   cannot resurrect a pre-disable successor.
 * with the lock, and for any future path that invokes rollback).
 *
 * Does not use polling, WorkManager periodic, or foreground services.
 */
public final class AutoDeductionScheduler {

    private static final String TAG = "AutoDeductionScheduler";
    private static final String SCHEDULE_KEY_PREFIX = "sch:";
    /** Prefs key prefix for durable cancellation tombstones (occurrence identity). */
    private static final String CANCEL_KEY_PREFIX = "cancel:";
    /** JSON field: attempt generation token (not part of occurrence identity). */
    public static final String FIELD_SCHEDULE_VERSION = "scheduleVersion";
    /** JSON/Intent field: medication+dose recurrence authorization generation. */
    public static final String FIELD_RECURRENCE_GENERATION = "recurrenceGeneration";

    /** Process-wide lock: metadata + AlarmManager install/cancel + rollback. */
    private static final Object SCHEDULE_LOCK = new Object();

    private final Context appContext;
    private final SharedPreferences schedulePrefs;
    private final SharedPreferences cancelPrefs;
    /** Durable last-allocated ordering sequence (survives process death). */
    private final SharedPreferences orderingPrefs;
    /** Active recurrence generation per (medicationId, doseId) — Issue #217. */
    private final SharedPreferences recurrenceAuthPrefs;

    public AutoDeductionScheduler(Context context) {
        this.appContext = context.getApplicationContext();
        this.schedulePrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_SCHEDULES, Context.MODE_PRIVATE);
        this.cancelPrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_CANCELLED, Context.MODE_PRIVATE);
        this.orderingPrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_ORDERING, Context.MODE_PRIVATE);
        this.recurrenceAuthPrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, Context.MODE_PRIVATE);
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
     *
     * <ul>
     *   <li>If {@code expectedGeneration > 0}: must equal the durable active generation.</li>
     *   <li>If {@code expectedGeneration <= 0} (legacy delivery without stamp): authorized
     *       only when active generation is 0 (never invalidated). After any invalidate,
     *       active &gt; 0 and legacy receivers cannot create successors.</li>
     * </ul>
     */
    private boolean isRecurrenceGenerationAuthorizedLocked(
            String medicationId,
            String doseId,
            long expectedGeneration
    ) {
        long active = getRecurrenceGenerationLocked(medicationId, doseId);
        if (expectedGeneration > 0L) {
            return active == expectedGeneration;
        }
        // Legacy: only allow if never invalidated (active still 0) — first schedules
        // set active to 1 inside scheduleOccurrenceLocked, so a fire from a schedule
        // created after this code is deployed will always carry expectedGeneration > 0.
        return active <= 0L;
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
    public void invalidateRecurrenceAuthorization(String medicationId, String doseId) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()) {
            return;
        }
        synchronized (SCHEDULE_LOCK) {
            String authKey = recurrenceAuthKey(medicationId, doseId);
            long prev = recurrenceAuthPrefs.getLong(authKey, 0L);
            long next = prev <= 0L ? 1L : prev + 1L;
            if (!recurrenceAuthPrefs.edit().putLong(authKey, next).commit()) {
                Log.e(TAG, "invalidateRecurrenceAuthorization: generation commit failed for "
                        + medicationId + "/" + doseId);
                // Still attempt to cancel futures — best-effort under same lock.
            } else {
                Log.i(TAG, "invalidateRecurrenceAuthorization: generation "
                        + prev + " -> " + next + " for " + medicationId + "/" + doseId);
            }
            cancelAllSchedulesForDoseLocked(medicationId, doseId);
        }
    }

    /**
     * Cancel AlarmManager + remove schedule metadata for every occurrence of
     * this medication+dose. Caller must hold {@link #SCHEDULE_LOCK}.
     * Also writes occurrence cancellation tombstones so fire cannot promote them.
     */
    private void cancelAllSchedulesForDoseLocked(String medicationId, String doseId) {
        // Iterate a snapshot of all schedule keys and match medicationId + doseId.
        java.util.Map<String, ?> all = schedulePrefs.getAll();
        if (all == null || all.isEmpty()) {
            return;
        }
        for (java.util.Map.Entry<String, ?> e : all.entrySet()) {
            String prefKey = e.getKey();
            if (prefKey == null || !prefKey.startsWith(SCHEDULE_KEY_PREFIX)) {
                continue;
            }
            Object val = e.getValue();
            if (!(val instanceof String)) {
                continue;
            }
            String raw = (String) val;
            try {
                org.json.JSONObject o = new org.json.JSONObject(raw);
                if (!medicationId.equals(o.optString("medicationId", ""))
                        || !doseId.equals(o.optString("doseId", ""))) {
                    continue;
                }
                String calendarDate = o.optString("calendarDate", "");
                if (!AutoDeductionContract.isValidCalendarDate(calendarDate)) {
                    // Malformed — drop metadata only.
                    schedulePrefs.edit().remove(prefKey).commit();
                    continue;
                }
                // Tombstone + alarm cancel + metadata remove (same as cancelOccurrence core).
                String occKey = AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, calendarDate);
                String cancelKey = CANCEL_KEY_PREFIX + occKey;
                final String cancelToken = allocateOrderingTokenLocked();
                if (cancelToken != null) {
                    cancelPrefs.edit().putString(cancelKey, cancelToken).commit();
                }
                Intent intent = buildOccurrenceIntent(
                        medicationId, doseId, calendarDate, 0L, 0d, null, 0L);
                PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);
                AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
                if (am != null && pi != null) {
                    am.cancel(pi);
                    pi.cancel();
                }
                schedulePrefs.edit().remove(prefKey).commit();
                Log.i(TAG, "cancelAllSchedulesForDoseLocked: cancelled " + occKey);
            } catch (org.json.JSONException ex) {
                schedulePrefs.edit().remove(prefKey).commit();
            }
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
    public FireResult fireOccurrenceIfNotCancelled(
            String medicationId,
            String doseId,
            String calendarDate,
            long scheduledAtEpochMs,
            double amount
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
            AutoDeductionEventStore store = new AutoDeductionEventStore(appContext);
            AutoDeductionEventStore.InsertFiredResult ir = store.insertFiredIfAbsent(
                    medicationId, doseId, calendarDate, scheduledAtEpochMs, amount);
            FireResult result = FireResult.fromInsert(ir);
            Log.i(TAG, "fire linearization: " + result.status
                    + " pendingRecorded=" + result.pendingRecorded + " for " + key);
            return result;
        }
    }

    /**
     * Allocate a durable ordering token for one schedule or cancel operation.
     * Format: "{millis}-{seq}-{uuid}". Not part of occurrence identity (med/dose/date).
     * <p>
     * Caller MUST hold {@link #SCHEDULE_LOCK}. Sequence is read-increment-commit from
     * durable SharedPreferences so ordering survives process death. Skipped values
     * after a crash are acceptable; reusing an older durable seq is not.
     *
     * @return token, or {@code null} if the durable counter commit failed (caller
     *         must fail the operation — do not fall back to volatile memory).
     */
    private String allocateOrderingTokenLocked() {
        long last = orderingPrefs.getLong(AutoDeductionContract.KEY_ORDERING_SEQ, 0L);
        long next = last + 1L;
        boolean committed = orderingPrefs.edit()
                .putLong(AutoDeductionContract.KEY_ORDERING_SEQ, next)
                .commit();
        if (!committed) {
            Log.e(TAG, "allocateOrderingTokenLocked: durable sequence commit failed");
            return null;
        }
        return System.currentTimeMillis()
                + "-"
                + next
                + "-"
                + UUID.randomUUID().toString();
    }

    /**
     * Pure ownership check used by conditional rollback.
     * Package-visible for focused verification.
     */
    static boolean isMetadataOwnedByVersion(String currentJson, String expectedVersion) {
        if (expectedVersion == null || expectedVersion.isEmpty()) {
            return false;
        }
        if (currentJson == null || currentJson.isEmpty()) {
            return false;
        }
        try {
            JSONObject o = new JSONObject(currentJson);
            String current = o.optString(FIELD_SCHEDULE_VERSION, "");
            return expectedVersion.equals(current);
        } catch (JSONException e) {
            return false;
        }
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


    private Intent buildOccurrenceIntent(
            String medicationId,
            String doseId,
            String calendarDate,
            long triggerAt,
            double amount,
            String timeHhmm,
            long recurrenceGeneration
    ) {
        Intent intent = new Intent(appContext, AutoDeductionReceiver.class);
        intent.setAction(AutoDeductionContract.ACTION_AUTO_DEDUCTION);
        intent.setData(AutoDeductionContract.occurrenceUri(medicationId, doseId, calendarDate));
        intent.putExtra(AutoDeductionContract.EXTRA_MEDICATION_ID, medicationId);
        intent.putExtra(AutoDeductionContract.EXTRA_DOSE_ID, doseId);
        intent.putExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE, calendarDate);
        intent.putExtra(AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, triggerAt);
        intent.putExtra(AutoDeductionContract.EXTRA_AMOUNT, amount);
        if (timeHhmm != null) {
            intent.putExtra(AutoDeductionContract.EXTRA_TIME_HHMM, timeHhmm);
        }
        if (recurrenceGeneration > 0L) {
            intent.putExtra(
                    AutoDeductionContract.EXTRA_RECURRENCE_GENERATION, recurrenceGeneration);
        }
        return intent;
    }

    private PendingIntent buildPendingIntent(Intent intent, int flags) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(
                appContext,
                AutoDeductionContract.PENDING_INTENT_REQUEST_CODE,
                intent,
                flags
        );
    }

    /**
     * Schedule a single occurrence.
     *
     * Validation runs outside the lock. The scheduling transaction
     * (metadata commit + AlarmManager install + failure rollback) runs
     * inside one synchronized(SCHEDULE_LOCK) critical section so concurrent
     * attempts cannot interleave AlarmManager installs.
     */
    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs
    ) {
        // ── Validation outside lock ──
        if (medicationId == null || medicationId.isEmpty()) {
            return ScheduleResult.fail("missing_medicationId");
        }
        if (doseId == null || doseId.isEmpty()) {
            return ScheduleResult.fail("missing_doseId");
        }
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return ScheduleResult.fail("invalid_calendarDate");
        }
        if (!AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            return ScheduleResult.fail("invalid_time");
        }
        if (!AutoDeductionContract.isValidAmount(amount)) {
            return ScheduleResult.fail("invalid_amount");
        }

        long triggerAt = scheduledAtEpochMs;
        if (triggerAt <= 0) {
            Long computed = computeEpochMs(calendarDate, timeHhmm);
            if (computed == null) {
                return ScheduleResult.fail("invalid_datetime");
            }
            triggerAt = computed;
        }

        if (triggerAt <= System.currentTimeMillis() - 2000L) {
            return ScheduleResult.fail("trigger_in_past");
        }

        if (!canScheduleExactAlarms()) {
            return ScheduleResult.fail("exact_alarm_permission_denied");
        }

        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = SCHEDULE_KEY_PREFIX + key;

        // Payload without scheduleVersion — authoritative version is assigned inside
        // SCHEDULE_LOCK so ordering vs cancellation tombstones matches lock order.
        JSONObject payload = new JSONObject();
        try {
            payload.put("medicationId", medicationId);
            payload.put("doseId", doseId);
            payload.put("calendarDate", calendarDate);
            payload.put("timeHhmm", timeHhmm);
            payload.put("amount", amount);
            payload.put("scheduledAtEpochMs", triggerAt);
        } catch (JSONException e) {
            Log.e(TAG, "schedule payload build failed", e);
            return ScheduleResult.fail("payload_build_failed");
        }

        Intent intent = buildOccurrenceIntent(
                medicationId, doseId, calendarDate, triggerAt, amount, timeHhmm, 0L);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        synchronized (SCHEDULE_LOCK) {
            return scheduleOccurrenceLocked(
                    prefKey, key, payload, triggerAt, pi, /*requiredVersion*/ null);
        }
    }

    /**
     * Core scheduling transaction. Caller MUST hold {@link #SCHEDULE_LOCK}.
     *
     * scheduleVersion is generated here (inside the lock) so its (millis, seq)
     * ordering token reflects serialized operation order versus concurrent
     * cancelOccurrence tombstones — not the wall-clock time at which a thread
     * waited for the lock. Same-millisecond operations are distinguished by seq.
     *
     * @param requiredVersion if non-null, abort unless current metadata is still
     *                        owned by this version (restore ownership guard).
     *                        null means unconditional schedule (normal path).
     */
    private ScheduleResult scheduleOccurrenceLocked(
            String prefKey,
            String key,
            JSONObject payload,
            long triggerAt,
            PendingIntent pi,
            String requiredVersion
    ) {
        if (requiredVersion != null) {
            String current = schedulePrefs.getString(prefKey, null);
            if (!isMetadataOwnedByVersion(current, requiredVersion)) {
                Log.i(TAG, "scheduleOccurrenceLocked: skip — ownership lost for " + prefKey);
                return ScheduleResult.fail("ownership_lost");
            }
        }

        // Recurrence authorization generation (Issue #217) — under SCHEDULE_LOCK so
        // concurrent invalidateRecurrenceAuthorization cannot race a stamp with a bump.
        final String medIdForGen = payload.optString("medicationId", "");
        final String doseIdForGen = payload.optString("doseId", "");
        final long recurrenceGen = ensureRecurrenceGenerationLocked(medIdForGen, doseIdForGen);
        if (recurrenceGen <= 0L) {
            return ScheduleResult.fail("recurrence_generation_write_failed");
        }

        // Authoritative durable ordering/version for this scheduling attempt — only
        // after acquiring SCHEDULE_LOCK (same serialization boundary as cancel).
        final String myVersion = allocateOrderingTokenLocked();
        if (myVersion == null) {
            return ScheduleResult.fail("ordering_sequence_write_failed");
        }
        try {
            payload.put(FIELD_SCHEDULE_VERSION, myVersion);
            payload.put(FIELD_RECURRENCE_GENERATION, recurrenceGen);
        } catch (JSONException e) {
            Log.e(TAG, "schedule version attach failed", e);
            return ScheduleResult.fail("payload_build_failed");
        }

        // Rebuild PendingIntent with stamped generation so the receiver can refuse
        // successor creation after a concurrent disable bumps the active generation.
        final String calDate = payload.optString("calendarDate", "");
        final String timeHhmm = payload.optString("timeHhmm", null);
        final double amount = payload.optDouble("amount", Double.NaN);
        Intent genIntent = buildOccurrenceIntent(
                medIdForGen, doseIdForGen, calDate, triggerAt, amount, timeHhmm, recurrenceGen);
        pi = buildPendingIntent(genIntent, PendingIntent.FLAG_UPDATE_CURRENT);

        boolean metaWritten = schedulePrefs.edit()
                .putString(prefKey, payload.toString())
                .commit();
        if (!metaWritten) {
            Log.e(TAG, "schedule metadata commit failed for key=" + key);
            return ScheduleResult.fail("schedule_metadata_write_failed");
        }

        // New schedule metadata (with lock-ordered scheduleVersion token) supersedes
        // any prior cancellation tombstone. Clear is best-effort: if the remove commit
        // fails, isOccurrenceCancelledKey still treats a strictly newer schedule
        // ordering token as active so restore/receiver do not suppress the new schedule.
        clearCancellationTombstoneLocked(key);

        AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            removeScheduleMetadataIfVersionLocked(prefKey, myVersion);
            return ScheduleResult.fail("alarm_manager_unavailable");
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pi);
            }
        } catch (SecurityException se) {
            Log.w(TAG, "setExactAndAllowWhileIdle denied", se);
            removeScheduleMetadataIfVersionLocked(prefKey, myVersion);
            return ScheduleResult.fail("exact_alarm_permission_denied");
        } catch (Exception e) {
            Log.e(TAG, "schedule failed", e);
            removeScheduleMetadataIfVersionLocked(prefKey, myVersion);
            return ScheduleResult.fail("schedule_failed");
        }

        return ScheduleResult.success(key);
    }

    /**
     * Conditional rollback — caller MUST already hold {@link #SCHEDULE_LOCK}.
     */
    private boolean removeScheduleMetadataIfVersionLocked(String prefKey, String expectedVersion) {
        String current = schedulePrefs.getString(prefKey, null);
        if (!isMetadataOwnedByVersion(current, expectedVersion)) {
            Log.i(TAG, "skip stale rollback for " + prefKey
                    + " (current metadata not owned by this attempt)");
            return false;
        }
        return schedulePrefs.edit().remove(prefKey).commit();
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
    private void removeScheduleMetadataLocked(String prefKey) {
        schedulePrefs.edit().remove(prefKey).commit();
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
    public CancelResult cancelOccurrence(String medicationId, String doseId, String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return CancelResult.fail("invalid_args");
        }
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = SCHEDULE_KEY_PREFIX + key;
        String cancelKey = CANCEL_KEY_PREFIX + key;

        Intent intent = buildOccurrenceIntent(medicationId, doseId, calendarDate, 0L, 0d, null, 0L);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        synchronized (SCHEDULE_LOCK) {
            boolean hadMetadata = schedulePrefs.contains(prefKey);
            boolean alreadyCancelled = cancelPrefs.contains(cancelKey);

            // Durable cancellation intent before AlarmManager.cancel / metadata remove.
            // Ordering token (same format as scheduleVersion) is allocated under
            // SCHEDULE_LOCK from a durable sequence so same-millisecond ops and
            // post-restart ops remain strictly ordered and reconstructible.
            if (!alreadyCancelled) {
                final String cancelToken = allocateOrderingTokenLocked();
                if (cancelToken == null) {
                    return CancelResult.fail("ordering_sequence_write_failed");
                }
                boolean tombstoneWritten = cancelPrefs.edit()
                        .putString(cancelKey, cancelToken)
                        .commit();
                if (!tombstoneWritten) {
                    Log.e(TAG, "cancelOccurrence: cancellation tombstone commit failed for " + key);
                    return CancelResult.fail("cancellation_tombstone_write_failed");
                }
            }

            AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
            if (am == null) {
                Log.e(TAG, "cancelOccurrence: AlarmManager unavailable for " + key);
                return CancelResult.fail("alarm_manager_unavailable");
            }
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }

            if (!hadMetadata) {
                return alreadyCancelled ? CancelResult.alreadyAbsent() : CancelResult.success();
            }

            boolean removed = schedulePrefs.edit().remove(prefKey).commit();
            if (!removed) {
                Log.e(TAG, "cancelOccurrence: metadata remove commit failed for " + key
                        + " (cancellation tombstone remains — restore will not promote to FIRED)");
                return CancelResult.fail("schedule_metadata_remove_failed");
            }
            return CancelResult.success();
        }
    }

    /** True if a durable cancellation tombstone entry exists (raw presence). */
    boolean hasCancellationTombstone(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (SCHEDULE_LOCK) {
            return cancelPrefs.contains(CANCEL_KEY_PREFIX + occurrenceKey);
        }
    }

    /**
     * Whether the occurrence is effectively cancelled for fire handling and restore.
     * <p>
     * Rules (deterministic from durable state only):
     * <ul>
     *   <li>No tombstone → not cancelled</li>
     *   <li>Tombstone present, no schedule metadata → cancelled</li>
     *   <li>Both present → compare durable ordering tokens (millis then seq from
     *       scheduleVersion / cancel tombstone). A strictly newer schedule
     *       supersedes the tombstone (active); a strictly newer cancel remains
     *       cancelled. Same-millisecond ops and post-restart ops are ordered
     *       by the durable sequence allocated under SCHEDULE_LOCK.</li>
     * </ul>
     * This allows a legitimate reschedule to win even if tombstone removal failed
     * after the new schedule metadata commit, while still blocking cancel-then-
     * failed-metadata-remove from promoting stale schedule metadata to FIRED.
     */
    public boolean isOccurrenceCancelled(
            String medicationId, String doseId, String calendarDate) {
        if (medicationId == null || medicationId.isEmpty()
                || doseId == null || doseId.isEmpty()
                || !AutoDeductionContract.isValidCalendarDate(calendarDate)) {
            return false;
        }
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        return isOccurrenceCancelledKey(key);
    }

    /**
     * Package-visible key-based check used by restore and tests.
     */
    boolean isOccurrenceCancelledKey(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (SCHEDULE_LOCK) {
            String cancelKey = CANCEL_KEY_PREFIX + occurrenceKey;
            String cancelRaw = cancelPrefs.getString(cancelKey, null);
            if (cancelRaw == null) {
                return false;
            }
            String prefKey = SCHEDULE_KEY_PREFIX + occurrenceKey;
            String scheduleRaw = schedulePrefs.getString(prefKey, null);
            if (scheduleRaw == null || scheduleRaw.isEmpty()) {
                return true;
            }
            long[] cancelOrd = parseOrderingToken(cancelRaw);
            long[] scheduleOrd = parseScheduleVersionOrdering(scheduleRaw);
            // Strict total order: (millis, seq). Schedule newer than cancel → active.
            if (scheduleOrd[0] >= 0L && cancelOrd[0] >= 0L
                    && isOrderingNewer(scheduleOrd[0], scheduleOrd[1], cancelOrd[0], cancelOrd[1])) {
                return false;
            }
            // Ambiguous or cancel-after-schedule: treat as cancelled.
            return true;
        }
    }

    /**
     * Parse a durable ordering token "{millis}-{seq}-..." or legacy pure millis.
     * Returns long[2] = {millis, seq}; millis=-1 if unparseable. Legacy pure-millis
     * tokens use seq=0 so they remain comparable with versioned tokens.
     */
    private static long[] parseOrderingToken(String raw) {
        long[] out = new long[] { -1L, 0L };
        if (raw == null || raw.isEmpty()) return out;
        String s = raw.trim();
        try {
            int firstDash = s.indexOf('-');
            if (firstDash <= 0) {
                // Legacy pure-millis tombstone.
                out[0] = Long.parseLong(s);
                out[1] = 0L;
                return out;
            }
            out[0] = Long.parseLong(s.substring(0, firstDash).trim());
            int secondDash = s.indexOf('-', firstDash + 1);
            String seqPart = secondDash > firstDash
                    ? s.substring(firstDash + 1, secondDash)
                    : s.substring(firstDash + 1);
            out[1] = Long.parseLong(seqPart.trim());
            return out;
        } catch (NumberFormatException e) {
            out[0] = -1L;
            out[1] = 0L;
            return out;
        }
    }

    /**
     * Extract (millis, seq) from schedule JSON scheduleVersion field.
     * Returns {-1, 0} if missing/unparseable.
     */
    private static long[] parseScheduleVersionOrdering(String scheduleRaw) {
        if (scheduleRaw == null || scheduleRaw.isEmpty()) {
            return new long[] { -1L, 0L };
        }
        try {
            JSONObject o = new JSONObject(scheduleRaw);
            String version = o.optString(FIELD_SCHEDULE_VERSION, "");
            if (version.isEmpty()) return new long[] { -1L, 0L };
            return parseOrderingToken(version);
        } catch (Exception e) {
            return new long[] { -1L, 0L };
        }
    }

    /**
     * True if (aMillis, aSeq) is strictly newer than (bMillis, bSeq).
     * Primary key: millis; secondary: durable seq allocated under SCHEDULE_LOCK.
     */
    private static boolean isOrderingNewer(long aMillis, long aSeq, long bMillis, long bSeq) {
        if (aMillis != bMillis) {
            return aMillis > bMillis;
        }
        return aSeq > bSeq;
    }

    /**
     * Leading millis segment of scheduleVersion in schedule JSON payload.
     * scheduleVersion format: "{millis}-{seq}-{uuid}". Returns -1 if missing.
     * Retained for compatibility with any external/test callers that only need millis.
     */
    private static long parseScheduleVersionEpochMs(String scheduleRaw) {
        long[] ord = parseScheduleVersionOrdering(scheduleRaw);
        return ord[0];
    }

    /** Parse cancel tombstone ordering millis (legacy pure millis or versioned). -1 if unparseable. */
    private static long parseCancelEpochMs(String cancelRaw) {
        long[] ord = parseOrderingToken(cancelRaw);
        return ord[0];
    }

    /**
     * Clear cancellation tombstone when a new legitimate schedule is installed
     * for the same occurrence identity (re-enable / reschedule after cancel).
     * Caller must hold SCHEDULE_LOCK.
     * Returns whether the remove commit reported success (best-effort; restore
     * and fire paths use {@link #isOccurrenceCancelledKey} when clear fails).
     */
    private boolean clearCancellationTombstoneLocked(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return true;
        String cancelKey = CANCEL_KEY_PREFIX + occurrenceKey;
        if (!cancelPrefs.contains(cancelKey)) {
            return true;
        }
        boolean ok = cancelPrefs.edit().remove(cancelKey).commit();
        if (!ok) {
            Log.w(TAG, "clearCancellationTombstone commit failed for " + occurrenceKey
                    + " — schedule metadata remains authoritative via version ordering");
        }
        return ok;
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
    public ScheduleResult scheduleNextOccurrenceIfAbsent(
            String medicationId,
            String doseId,
            String fromCalendarDate,
            String timeHhmm,
            double amount
    ) {
        return scheduleNextOccurrenceIfAbsent(
                medicationId, doseId, fromCalendarDate, timeHhmm, amount, /*expectedGen*/ 0L);
    }

    /**
     * @param expectedRecurrenceGeneration generation stamped on the firing occurrence's
     *        Intent (Issue #217). When {@code > 0}, successor creation is refused unless
     *        the active durable generation still matches — i.e. disable/cancel has not
     *        invalidated this recurrence chain. When {@code 0} (legacy), still refuses if
     *        active generation was invalidated (active {@code > 0} is always required to
     *        create a new successor after an invalidate has run at least once... 
     *        actually: if expected is 0, compare only when active > 0 and we require match
     *        of metadata path). Prefer always passing the Intent generation.
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
        final String nextPrefKey = SCHEDULE_KEY_PREFIX + nextKey;

        if (!canScheduleExactAlarms()) {
            synchronized (SCHEDULE_LOCK) {
                if (schedulePrefs.contains(nextPrefKey)) {
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

        Intent intent = buildOccurrenceIntent(
                medicationId, doseId, resolvedNextDate, triggerAt, amount, timeHhmm, 0L);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        synchronized (SCHEDULE_LOCK) {
            // Issue #217: refuse successor if disable/cancel invalidated this chain.
            if (!isRecurrenceGenerationAuthorizedLocked(
                    medicationId, doseId, expectedRecurrenceGeneration)) {
                Log.i(TAG, "scheduleNextOccurrenceIfAbsent: recurrence generation invalid — "
                        + "not creating successor for " + medicationId + "/" + doseId
                        + " expectedGen=" + expectedRecurrenceGeneration);
                return ScheduleResult.fail("recurrence_authorization_invalid");
            }
            if (schedulePrefs.contains(nextPrefKey)) {
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
                    nextPrefKey, nextKey, payload, triggerAt, pi, /*requiredVersion*/ null);
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
                        schedulePrefs.getString(pastPrefKey, null), observedVersion)) {
                    return ScheduleResult.fail("snapshot_stale");
                }
                String nextKey = AutoDeductionContract.occurrenceKey(
                        medicationId, doseId, nextDate);
                if (schedulePrefs.contains(SCHEDULE_KEY_PREFIX + nextKey)) {
                    return ScheduleResult.success(nextKey);
                }
            }
            return ScheduleResult.fail("exact_alarm_permission_denied");
        }

        final String resolvedNextDate = nextDate;
        final long triggerAt = epoch;
        final String nextKey = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, resolvedNextDate);
        final String nextPrefKey = SCHEDULE_KEY_PREFIX + nextKey;

        JSONObject payload = new JSONObject();
        try {
            payload.put("medicationId", medicationId);
            payload.put("doseId", doseId);
            payload.put("calendarDate", resolvedNextDate);
            payload.put("timeHhmm", timeHhmm);
            payload.put("amount", amount);
            payload.put("scheduledAtEpochMs", triggerAt);
        } catch (org.json.JSONException e) {
            Log.e(TAG, "scheduleNextOccurrenceIfSnapshotOwnsPast payload failed", e);
            return ScheduleResult.fail("payload_failed");
        }

        Intent intent = buildOccurrenceIntent(
                medicationId, doseId, resolvedNextDate, triggerAt, amount, timeHhmm, 0L);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        synchronized (SCHEDULE_LOCK) {
            // Snapshot must still own past D — otherwise amount/time are obsolete.
            String currentPast = schedulePrefs.getString(pastPrefKey, null);
            if (!isMetadataOwnedByVersion(currentPast, observedVersion)) {
                return ScheduleResult.fail("snapshot_stale");
            }
            // Issue #217: do not continue recurrence for an invalidated generation.
            long snapGen = 0L;
            try {
                if (currentPast != null) {
                    snapGen = new JSONObject(currentPast).optLong(FIELD_RECURRENCE_GENERATION, 0L);
                }
            } catch (JSONException ignored) { /* treat as 0 */ }
            if (!isRecurrenceGenerationAuthorizedLocked(medicationId, doseId, snapGen)) {
                Log.i(TAG, "restore past: recurrence generation invalid — no successor for "
                        + medicationId + "/" + doseId);
                return ScheduleResult.fail("recurrence_authorization_invalid");
            }
            // Never overwrite an existing successor with recovery snapshot params.
            if (schedulePrefs.contains(nextPrefKey)) {
                Log.i(TAG, "restore past: successor already present — not overwriting "
                        + nextPrefKey);
                return ScheduleResult.success(nextKey);
            }
            return scheduleOccurrenceLocked(
                    nextPrefKey, nextKey, payload, triggerAt, pi, /*requiredVersion*/ null);
        }
    }

    /**
     * Restore future alarms from persisted schedule payloads (reboot).
     *
     * Snapshot under lock (prefKey + raw JSON + observed scheduleVersion).
     * For each future entry, ownership validation + AlarmManager install +
     * metadata rewrite run under one continuous SCHEDULE_LOCK critical section
     * so cancel cannot interleave and resurrect a canceled schedule.
     *
     * Past schedule entries: promote via fireOccurrenceIfNotCancelled, schedule
     * the next occurrence when the fire is durable (CREATED / ALREADY_EXISTS /
     * pending), then ownership-safe metadata removal. Metadata is removed only
     * when the current scheduleVersion still matches the snapshot observedVersion
     * and successor scheduling succeeded (or the occurrence was CANCELLED), so a
     * newer legitimate reschedule is never deleted and recurrence is not lost.
     */
    public int restoreFutureSchedules() {
        if (!canScheduleExactAlarms()) {
            Log.w(TAG, "restoreFutureSchedules: exact alarm permission denied");
            // Still attempt past-schedule promotion to FIRED.
        }
        int restored = 0;

        java.util.List<String[]> snapshot = new java.util.ArrayList<>();
        synchronized (SCHEDULE_LOCK) {
            Map<String, ?> all = schedulePrefs.getAll();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                if (!e.getKey().startsWith(SCHEDULE_KEY_PREFIX)) continue;
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                String raw = (String) v;
                String observedVersion = "";
                try {
                    JSONObject tmp = new JSONObject(raw);
                    observedVersion = tmp.optString(FIELD_SCHEDULE_VERSION, "");
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
                if (medId.isEmpty() || doseId.isEmpty()
                        || !AutoDeductionContract.isValidCalendarDate(date)
                        || !AutoDeductionContract.isValidTimeHhmm(time)
                        || !AutoDeductionContract.isValidAmount(amount)) {
                    // Only drop the snapshot-owned row (never a newer replacement).
                    removeScheduleMetadataIfVersion(prefKey, observedVersion);
                    continue;
                }

                String occurrenceKey = AutoDeductionContract.occurrenceKey(medId, doseId, date);

                if (epoch <= 0) {
                    Long computed = computeEpochMs(date, time);
                    if (computed == null) {
                        removeScheduleMetadataIfVersion(prefKey, observedVersion);
                        continue;
                    }
                    epoch = computed;
                }

                // Past occurrence: serialized fire transition (cancel-check + FIRED/pending).
                // Only drop schedule metadata when a durable recovery source exists or
                // cancel linearized first (stale schedule must not remain).
                // If both main and pending writes failed, KEEP schedule metadata
                // as the last recovery source for a later restore attempt.
                if (epoch <= System.currentTimeMillis()) {
                    FireResult fr = fireOccurrenceIfNotCancelled(
                            medId, doseId, date, epoch, amount);
                    if (fr.isCancelled()) {
                        Log.i(TAG, "restore skip (cancelled): " + medId + "/" + doseId + "/" + date);
                    } else if (fr.allowsRecurrence()) {
                        Log.i(TAG, "restore past: durable fire for "
                                + medId + "/" + doseId + "/" + date
                                + " status=" + fr.status
                                + " pendingRecorded=" + fr.pendingRecorded);
                    }
                    continueRecurrenceAfterPastRecovery(
                            medId, doseId, date, time, amount, fr, prefKey, observedVersion);
                    continue;
                }

                // Future: effectively cancelled → never reinstall; drop stale metadata.
                // A newer schedule metadata supersedes a leftover tombstone so legitimate
                // reschedule is not suppressed.
                if (isOccurrenceCancelledKey(occurrenceKey)) {
                    Log.i(TAG, "restore skip (cancelled): " + medId + "/" + doseId + "/" + date);
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
                    continue;
                }

                // Rebuild epoch from calendarDate + timeHhmm in the *current* default
                // timezone so a TIMEZONE_CHANGED restore does not reinstall a stale epoch.
                Long recomputed = computeEpochMs(date, time);
                if (recomputed == null) {
                    removeScheduleMetadataIfVersion(prefKey, observedVersion);
                    continue;
                }
                if (recomputed <= System.currentTimeMillis()) {
                    // After TZ change this occurrence is now in the past: serialized
                    // promote + recurrence continuation.
                    FireResult fr = fireOccurrenceIfNotCancelled(
                            medId, doseId, date, recomputed, amount);
                    continueRecurrenceAfterPastRecovery(
                            medId, doseId, date, time, amount, fr, prefKey, observedVersion);
                    continue;
                }
                epoch = recomputed;

                // Future: atomic ownership check + schedule under one lock.
                // scheduleVersion is assigned inside scheduleOccurrenceLocked (under
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
                } catch (JSONException e) {
                    Log.e(TAG, "restore payload build failed", e);
                    continue;
                }
                Intent intent = buildOccurrenceIntent(medId, doseId, date, epoch, amount, time, 0L);
                PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

                synchronized (SCHEDULE_LOCK) {
                    // Issue #217: drop future schedules whose generation was invalidated.
                    long metaGen = o.optLong(FIELD_RECURRENCE_GENERATION, 0L);
                    if (metaGen > 0L
                            && !isRecurrenceGenerationAuthorizedLocked(medId, doseId, metaGen)) {
                        Log.i(TAG, "restore skip (recurrence generation invalid): " + prefKey);
                        removeScheduleMetadataIfVersionLocked(prefKey, observedVersion);
                        continue;
                    }
                    ScheduleResult r = scheduleOccurrenceLocked(
                            prefKey, key, payload, epoch, pi, observedVersion);
                    if (r.ok) {
                        restored++;
                    } else if ("ownership_lost".equals(r.error)) {
                        // Canceled or replaced after snapshot — correct skip.
                        Log.i(TAG, "restore skip (ownership lost): " + prefKey);
                    } else {
                        Log.w(TAG, "restore schedule failed for " + prefKey + ": " + r.error);
                    }
                }
            } catch (JSONException ignored) {
                // Malformed snapshot payload: drop only if still the observed version.
                removeScheduleMetadataIfVersion(prefKey, observedVersion);
            }
        }
        return restored;
    }


    /**
     * List durable schedule metadata entries (not AlarmManager state).
     * Used by JS to reconcile desired set against native after process restart
     * so stale schedules can be canceled even when trackedRef is empty.
     */
    public java.util.List<JSONObject> listScheduledOccurrences() {
        java.util.List<JSONObject> out = new java.util.ArrayList<>();
        synchronized (SCHEDULE_LOCK) {
            Map<String, ?> all = schedulePrefs.getAll();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                if (!e.getKey().startsWith(SCHEDULE_KEY_PREFIX)) continue;
                Object v = e.getValue();
                if (!(v instanceof String)) continue;
                try {
                    JSONObject o = new JSONObject((String) v);
                    String medId = o.optString("medicationId", "");
                    String doseId = o.optString("doseId", "");
                    String date = o.optString("calendarDate", "");
                    if (medId.isEmpty() || doseId.isEmpty()
                            || !AutoDeductionContract.isValidCalendarDate(date)) {
                        continue;
                    }
                    out.add(o);
                } catch (JSONException ignored) {
                }
            }
        }
        return out;
    }

    public boolean canScheduleExactAlarms() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    public static Long computeEpochMs(String calendarDate, String timeHhmm) {
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate)
                || !AutoDeductionContract.isValidTimeHhmm(timeHhmm)) {
            return null;
        }
        try {
            int y = Integer.parseInt(calendarDate.substring(0, 4));
            int mo = Integer.parseInt(calendarDate.substring(5, 7));
            int d = Integer.parseInt(calendarDate.substring(8, 10));
            int colon = timeHhmm.indexOf(':');
            int h = Integer.parseInt(timeHhmm.substring(0, colon));
            int mi = Integer.parseInt(timeHhmm.substring(colon + 1));
            Calendar cal = Calendar.getInstance(TimeZone.getDefault(), Locale.getDefault());
            cal.clear();
            cal.set(Calendar.YEAR, y);
            cal.set(Calendar.MONTH, mo - 1);
            cal.set(Calendar.DAY_OF_MONTH, d);
            cal.set(Calendar.HOUR_OF_DAY, h);
            cal.set(Calendar.MINUTE, mi);
            cal.set(Calendar.SECOND, 0);
            cal.set(Calendar.MILLISECOND, 0);
            return cal.getTimeInMillis();
        } catch (Exception e) {
            return null;
        }
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
}
