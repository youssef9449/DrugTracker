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
 * Uses setExactAndAllowWhileIdle. PendingIntent identity is deterministic.
 */
public final class AutoDeductionScheduler {

    private static final String TAG = "AutoDeductionScheduler";
    private static final String SCHEDULE_KEY_PREFIX = "sch:";

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
        int requestCode = AutoDeductionContract.pendingIntentRequestCode(key);

        Intent intent = new Intent(appContext, AutoDeductionReceiver.class);
        intent.setAction(AutoDeductionContract.ACTION_AUTO_DEDUCTION);
        intent.putExtra(AutoDeductionContract.EXTRA_MEDICATION_ID, medicationId);
        intent.putExtra(AutoDeductionContract.EXTRA_DOSE_ID, doseId);
        intent.putExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE, calendarDate);
        intent.putExtra(AutoDeductionContract.EXTRA_SCHEDULED_AT_EPOCH_MS, triggerAt);
        intent.putExtra(AutoDeductionContract.EXTRA_AMOUNT, amount);
        intent.putExtra(AutoDeductionContract.EXTRA_TIME_HHMM, timeHhmm);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(appContext, requestCode, intent, flags);

        AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
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
            return ScheduleResult.fail("exact_alarm_permission_denied");
        } catch (Exception e) {
            Log.e(TAG, "schedule failed", e);
            return ScheduleResult.fail("schedule_failed");
        }

        try {
            JSONObject payload = new JSONObject();
            payload.put("medicationId", medicationId);
            payload.put("doseId", doseId);
            payload.put("calendarDate", calendarDate);
            payload.put("timeHhmm", timeHhmm);
            payload.put("amount", amount);
            payload.put("scheduledAtEpochMs", triggerAt);
            schedulePrefs.edit().putString(SCHEDULE_KEY_PREFIX + key, payload.toString()).apply();
        } catch (JSONException e) {
            Log.w(TAG, "schedule payload persist failed", e);
        }

        return ScheduleResult.success(key);
    }

    public boolean cancelOccurrence(String medicationId, String doseId, String calendarDate) {
        if (medicationId == null || doseId == null || calendarDate == null) return false;
        String key = AutoDeductionContract.occurrenceKey(medicationId, doseId, calendarDate);
        int requestCode = AutoDeductionContract.pendingIntentRequestCode(key);

        Intent intent = new Intent(appContext, AutoDeductionReceiver.class);
        intent.setAction(AutoDeductionContract.ACTION_AUTO_DEDUCTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(appContext, requestCode, intent, flags);
        AlarmManager am = (AlarmManager) appContext.getSystemService(Context.ALARM_SERVICE);
        if (am != null && pi != null) {
            am.cancel(pi);
            pi.cancel();
        }

        schedulePrefs.edit().remove(SCHEDULE_KEY_PREFIX + key).apply();
        return true;
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

    public int restoreFutureSchedules() {
        if (!canScheduleExactAlarms()) {
            Log.w(TAG, "restoreFutureSchedules: exact alarm permission denied");
            return 0;
        }
        int restored = 0;
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
                String time = o.optString("timeHhmm", "");
                double amount = o.optDouble("amount", Double.NaN);
                long epoch = o.optLong("scheduledAtEpochMs", 0L);
                if (medId.isEmpty() || doseId.isEmpty()
                        || !AutoDeductionContract.isValidCalendarDate(date)
                        || !AutoDeductionContract.isValidTimeHhmm(time)
                        || !AutoDeductionContract.isValidAmount(amount)) {
                    continue;
                }
                if (epoch <= 0) {
                    Long computed = computeEpochMs(date, time);
                    if (computed == null) continue;
                    epoch = computed;
                }
                if (epoch <= System.currentTimeMillis()) {
                    schedulePrefs.edit().remove(e.getKey()).apply();
                    continue;
                }
                ScheduleResult r = scheduleOccurrence(medId, doseId, date, time, amount, epoch);
                if (r.ok) restored++;
            } catch (JSONException ignored) {
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
