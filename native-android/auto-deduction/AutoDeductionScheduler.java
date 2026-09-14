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
import java.util.concurrent.atomic.AtomicLong;

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
 * scheduleVersion remains an ownership guard for rollback (belt-and-suspenders
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

    /** Process-wide lock: metadata + AlarmManager install/cancel + rollback. */
    private static final Object SCHEDULE_LOCK = new Object();

    /**
     * Monotonic sequence mixed into version tokens.
     * Version token = millis + "-" + seq + "-" + UUID so two attempts never share
     * a token even under same-millisecond concurrent generation.
     */
    private static final AtomicLong VERSION_SEQ = new AtomicLong(0);

    private final Context appContext;
    private final SharedPreferences schedulePrefs;
    private final SharedPreferences cancelPrefs;

    public AutoDeductionScheduler(Context context) {
        this.appContext = context.getApplicationContext();
        this.schedulePrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_SCHEDULES, Context.MODE_PRIVATE);
        this.cancelPrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_CANCELLED, Context.MODE_PRIVATE);
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
     * Unique attempt token for one metadata write.
     * Not part of occurrence identity (med/dose/date).
     */
    static String newScheduleVersion() {
        return System.currentTimeMillis()
                + "-"
                + VERSION_SEQ.incrementAndGet()
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


    private Intent buildOccurrenceIntent(
            String medicationId,
            String doseId,
            String calendarDate,
            long triggerAt,
            double amount,
            String timeHhmm
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
        String myVersion = newScheduleVersion();

        JSONObject payload = new JSONObject();
        try {
            payload.put("medicationId", medicationId);
            payload.put("doseId", doseId);
            payload.put("calendarDate", calendarDate);
            payload.put("timeHhmm", timeHhmm);
            payload.put("amount", amount);
            payload.put("scheduledAtEpochMs", triggerAt);
            payload.put(FIELD_SCHEDULE_VERSION, myVersion);
        } catch (JSONException e) {
            Log.e(TAG, "schedule payload build failed", e);
            return ScheduleResult.fail("payload_build_failed");
        }

        Intent intent = buildOccurrenceIntent(
                medicationId, doseId, calendarDate, triggerAt, amount, timeHhmm);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        synchronized (SCHEDULE_LOCK) {
            return scheduleOccurrenceLocked(
                    prefKey, key, myVersion, payload, triggerAt, pi, /*requiredVersion*/ null);
        }
    }

    /**
     * Core scheduling transaction. Caller MUST hold {@link #SCHEDULE_LOCK}.
     *
     * @param requiredVersion if non-null, abort unless current metadata is still
     *                        owned by this version (restore ownership guard).
     *                        null means unconditional schedule (normal path).
     */
    private ScheduleResult scheduleOccurrenceLocked(
            String prefKey,
            String key,
            String myVersion,
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

        boolean metaWritten = schedulePrefs.edit()
                .putString(prefKey, payload.toString())
                .commit();
        if (!metaWritten) {
            Log.e(TAG, "schedule metadata commit failed for key=" + key);
            return ScheduleResult.fail("schedule_metadata_write_failed");
        }

        // New active schedule supersedes any prior cancellation tombstone.
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

        Intent intent = buildOccurrenceIntent(medicationId, doseId, calendarDate, 0L, 0d, null);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        synchronized (SCHEDULE_LOCK) {
            boolean hadMetadata = schedulePrefs.contains(prefKey);
            boolean alreadyCancelled = cancelPrefs.contains(cancelKey);

            // Durable cancellation intent before AlarmManager.cancel / metadata remove.
            if (!alreadyCancelled) {
                boolean tombstoneWritten = cancelPrefs.edit()
                        .putString(cancelKey, String.valueOf(System.currentTimeMillis()))
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

    /** True if a durable cancellation tombstone exists for this occurrence. */
    boolean hasCancellationTombstone(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return false;
        synchronized (SCHEDULE_LOCK) {
            return cancelPrefs.contains(CANCEL_KEY_PREFIX + occurrenceKey);
        }
    }

    /**
     * Clear cancellation tombstone when a new legitimate schedule is installed
     * for the same occurrence identity (re-enable / reschedule after cancel).
     * Caller must hold SCHEDULE_LOCK.
     */
    private void clearCancellationTombstoneLocked(String occurrenceKey) {
        if (occurrenceKey == null || occurrenceKey.isEmpty()) return;
        cancelPrefs.edit().remove(CANCEL_KEY_PREFIX + occurrenceKey).commit();
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
     * Restore future alarms from persisted schedule payloads (reboot).
     *
     * Snapshot under lock (prefKey + raw JSON + observed scheduleVersion).
     * For each future entry, ownership validation + AlarmManager install +
     * metadata rewrite run under one continuous SCHEDULE_LOCK critical section
     * so cancel cannot interleave and resurrect a canceled schedule.
     *
     * Past schedule entries: promote to FIRED (idempotent insert) then remove
     * metadata — recovers occurrences whose alarm fired but primary FIRED
     * commit failed (schedule metadata still present).
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

        AutoDeductionEventStore eventStore = new AutoDeductionEventStore(appContext);

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
                    removeScheduleMetadata(prefKey);
                    continue;
                }

                String occurrenceKey = AutoDeductionContract.occurrenceKey(medId, doseId, date);
                // Cancelled occurrence: never promote to FIRED; drop stale schedule metadata.
                // Tombstone remains until a later legitimate scheduleOccurrence clears it.
                if (hasCancellationTombstone(occurrenceKey)) {
                    Log.i(TAG, "restore skip (cancelled): " + medId + "/" + doseId + "/" + date);
                    removeScheduleMetadata(prefKey);
                    continue;
                }

                if (epoch <= 0) {
                    Long computed = computeEpochMs(date, time);
                    if (computed == null) {
                        removeScheduleMetadata(prefKey);
                        continue;
                    }
                    epoch = computed;
                }

                // Past occurrence: promote to FIRED (recovers failed primary insert).
                // Only drop schedule metadata when a durable recovery source exists:
                //   CREATED / ALREADY_EXISTS → main FIRED ledger
                //   FAILED + pendingRecorded → pending-fire record
                // If both main and pending writes failed, KEEP schedule metadata
                // as the last recovery source for a later restore attempt.
                if (epoch <= System.currentTimeMillis()) {
                    AutoDeductionEventStore.InsertFiredResult ir =
                            eventStore.insertFiredIfAbsent(medId, doseId, date, epoch, amount);
                    if (shouldRemovePastScheduleMetadata(ir)) {
                        if (ir.isCreated() || ir.isAlreadyExists()) {
                            Log.i(TAG, "restore past: promoted/ensured FIRED for "
                                    + medId + "/" + doseId + "/" + date);
                        } else {
                            Log.i(TAG, "restore past: pending-fire recorded for "
                                    + medId + "/" + doseId + "/" + date
                                    + "; dropping schedule metadata");
                        }
                        removeScheduleMetadata(prefKey);
                    } else {
                        Log.e(TAG, "restore past: FIRED and pending both failed for "
                                + medId + "/" + doseId + "/" + date
                                + " — preserving schedule metadata as recovery source");
                        // Do NOT removeScheduleMetadata — last durable source.
                    }
                    continue;
                }

                if (!canScheduleExactAlarms()) {
                    continue;
                }

                // Rebuild epoch from calendarDate + timeHhmm in the *current* default
                // timezone so a TIMEZONE_CHANGED restore does not reinstall a stale epoch.
                Long recomputed = computeEpochMs(date, time);
                if (recomputed == null) {
                    removeScheduleMetadata(prefKey);
                    continue;
                }
                if (recomputed <= System.currentTimeMillis()) {
                    // After TZ change this occurrence is now in the past: promote path.
                    AutoDeductionEventStore.InsertFiredResult ir =
                            eventStore.insertFiredIfAbsent(
                                    medId, doseId, date, recomputed, amount);
                    if (shouldRemovePastScheduleMetadata(ir)) {
                        removeScheduleMetadata(prefKey);
                    }
                    continue;
                }
                epoch = recomputed;

                // Future: atomic ownership check + schedule under one lock.
                String key = occurrenceKey;
                String myVersion = newScheduleVersion();
                JSONObject payload = new JSONObject();
                try {
                    payload.put("medicationId", medId);
                    payload.put("doseId", doseId);
                    payload.put("calendarDate", date);
                    payload.put("timeHhmm", time);
                    payload.put("amount", amount);
                    payload.put("scheduledAtEpochMs", epoch);
                    payload.put(FIELD_SCHEDULE_VERSION, myVersion);
                } catch (JSONException e) {
                    Log.e(TAG, "restore payload build failed", e);
                    continue;
                }
                Intent intent = buildOccurrenceIntent(medId, doseId, date, epoch, amount, time);
                PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

                synchronized (SCHEDULE_LOCK) {
                    ScheduleResult r = scheduleOccurrenceLocked(
                            prefKey, key, myVersion, payload, epoch, pi, observedVersion);
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
                removeScheduleMetadata(prefKey);
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
