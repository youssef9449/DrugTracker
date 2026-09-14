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

/**
 * One-shot exact-time auto-deduction scheduler (AlarmManager).
 *
 * PendingIntent identity:
 *   - ACTION_AUTO_DEDUCTION
 *   - data URI = occurrenceUri(med, dose, date)  [full identity]
 *   - fixed request code PENDING_INTENT_REQUEST_CODE (namespace only)
 * Uniqueness does NOT depend on a 32-bit hash of the key.
 *
 * Schedule durability ordering:
 *   1. validate
 *   2. persist schedule payload with commit()  (reboot recovery metadata)
 *   3. install exact alarm
 *   4. on install failure → remove schedule payload
 *
 * Crash recovery:
 *   - metadata persisted, alarm not installed → restoreFutureSchedules reinstalls
 *   - alarm installed, process dies → metadata already durable; boot restores same identity
 *   - install fails after persist → payload removed so restore does not loop on a dead schedule
 *
 * Does not use polling, WorkManager periodic, or foreground services.
 */
public final class AutoDeductionScheduler {

    private static final String TAG = "AutoDeductionScheduler";
    private static final String SCHEDULE_KEY_PREFIX = "sch:";

    /** Process-wide lock for schedule metadata check+write. */
    private static final Object SCHEDULE_LOCK = new Object();

    private final Context appContext;
    private final SharedPreferences schedulePrefs;

    public AutoDeductionScheduler(Context context) {
        this.appContext = context.getApplicationContext();
        this.schedulePrefs = appContext.getSharedPreferences(
                AutoDeductionContract.PREFS_SCHEDULES, Context.MODE_PRIVATE);
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
     * Build the deterministic Intent used for both schedule and cancel.
     * Identity = action + data URI (full occurrence) + component.
     */
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
     * Schedule a single occurrence. Idempotent: same occurrence identity
     * replaces the prior alarm (FLAG_UPDATE_CURRENT + same data URI).
     *
     * Ordering: durable schedule metadata first, then AlarmManager install.
     */
    public ScheduleResult scheduleOccurrence(
            String medicationId,
            String doseId,
            String calendarDate,
            String timeHhmm,
            double amount,
            long scheduledAtEpochMs
    ) {
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

        // ── Phase A: durable schedule metadata BEFORE alarm install ──
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

        synchronized (SCHEDULE_LOCK) {
            boolean metaWritten = schedulePrefs.edit()
                    .putString(prefKey, payload.toString())
                    .commit();
            if (!metaWritten) {
                Log.e(TAG, "schedule metadata commit failed for key=" + key);
                return ScheduleResult.fail("schedule_metadata_write_failed");
            }
        }

        // ── Phase B: install exact alarm ──
        Intent intent = buildOccurrenceIntent(
                medicationId, doseId, calendarDate, triggerAt, amount, timeHhmm);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);

        AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            removeScheduleMetadata(prefKey);
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
            removeScheduleMetadata(prefKey);
            return ScheduleResult.fail("exact_alarm_permission_denied");
        } catch (Exception e) {
            Log.e(TAG, "schedule failed", e);
            removeScheduleMetadata(prefKey);
            return ScheduleResult.fail("schedule_failed");
        }

        // Metadata already durable. If process dies here the alarm is
        // installed and boot restore will recreate the same PendingIntent
        // identity from the committed payload.
        return ScheduleResult.success(key);
    }

    private void removeScheduleMetadata(String prefKey) {
        synchronized (SCHEDULE_LOCK) {
            schedulePrefs.edit().remove(prefKey).commit();
        }
    }

    /**
     * Cancel using the same Intent identity as schedule (action + data URI).
     */
    public boolean cancelOccurrence(String medicationId, String doseId, String calendarDate) {
        if (medicationId == null || doseId == null || calendarDate == null) return false;
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        String prefKey = SCHEDULE_KEY_PREFIX + key;

        // Identity-matching Intent (extras optional for cancel; data URI is required).
        Intent intent = buildOccurrenceIntent(medicationId, doseId, calendarDate, 0L, 0d, null);
        PendingIntent pi = buildPendingIntent(intent, PendingIntent.FLAG_UPDATE_CURRENT);
        AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (am != null && pi != null) {
            am.cancel(pi);
            pi.cancel();
        }

        removeScheduleMetadata(prefKey);
        return true;
    }

    /**
     * After a fire, schedule the next local-calendar occurrence for the
     * same med/dose (same HH:mm on the following calendar day).
     * Does not use previousTrigger + 24h arithmetic.
     */
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
     * Skips past triggers. Does not replay old events.
     * Uses the same scheduleOccurrence path (metadata already present →
     * commit overwrites same key; alarm reinstalled with same identity).
     */
    public int restoreFutureSchedules() {
        if (!canScheduleExactAlarms()) {
            Log.w(TAG, "restoreFutureSchedules: exact alarm permission denied");
            return 0;
        }
        int restored = 0;
        Map<String, ?> all;
        synchronized (SCHEDULE_LOCK) {
            all = schedulePrefs.getAll();
        }
        for (Map.Entry<String, ?> e : all.entrySet()) {
            if (!e.getKey().startsWith(SCHEDULE_KEY_PREFIX)) continue;
            Object v = e.getValue();
            if (!(v instanceof String)) continue;
            try {
                JSONObject o = new JSONObject((String) v);
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
                    // Malformed — drop so restore does not loop forever.
                    removeScheduleMetadata(e.getKey());
                    continue;
                }
                if (epoch <= 0) {
                    Long computed = computeEpochMs(date, time);
                    if (computed == null) {
                        removeScheduleMetadata(e.getKey());
                        continue;
                    }
                    epoch = computed;
                }
                if (epoch <= System.currentTimeMillis()) {
                    // Past: drop schedule entry; event may already be in ledger.
                    removeScheduleMetadata(e.getKey());
                    continue;
                }
                ScheduleResult r = scheduleOccurrence(medId, doseId, date, time, amount, epoch);
                if (r.ok) restored++;
            } catch (JSONException ignored) {
                removeScheduleMetadata(e.getKey());
            }
        }
        return restored;
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
