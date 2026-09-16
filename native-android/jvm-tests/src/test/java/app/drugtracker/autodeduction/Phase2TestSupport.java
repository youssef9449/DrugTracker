package app.drugtracker.autodeduction;

import android.app.AlarmManager;
import android.content.Context;
import android.content.SharedPreferences;

import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;

import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Shared helpers for Phase 2 JVM tests. Uses Robolectric application context
 * and the real SharedPreferences names from {@link AutoDeductionContract}.
 */
final class Phase2TestSupport {

    private Phase2TestSupport() {}

    static Context appContext() {
        return RuntimeEnvironment.getApplication();
    }

    static void clearAllDurableState() {
        Context ctx = appContext();
        // Grant SCHEDULE_EXACT_ALARM in the Robolectric test environment so
        // scheduleOccurrence/scheduleNextOccurrenceIfAbsent work under
        // @Config(sdk = 33). Production canScheduleExactAlarms() is unchanged.
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            Shadows.shadowOf(am).setCanScheduleExactAlarms(true);
        }
        clearPrefs(ctx, AutoDeductionContract.PREFS_SCHEDULES);
        clearPrefs(ctx, AutoDeductionContract.PREFS_CANCELLED);
        clearPrefs(ctx, AutoDeductionContract.PREFS_EVENTS);
        clearPrefs(ctx, AutoDeductionContract.PREFS_PENDING);
        clearPrefs(ctx, AutoDeductionContract.PREFS_ORDERING);
        clearPrefs(ctx, AutoDeductionContract.PREFS_RECURRENCE_AUTH);
    }

    private static void clearPrefs(Context ctx, String name) {
        ctx.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
    }

    static SharedPreferences schedulePrefs() {
        return appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_SCHEDULES, Context.MODE_PRIVATE);
    }

    static SharedPreferences cancelPrefs() {
        return appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_CANCELLED, Context.MODE_PRIVATE);
    }

    static SharedPreferences eventPrefs() {
        return appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_EVENTS, Context.MODE_PRIVATE);
    }

    static SharedPreferences pendingPrefs() {
        return appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_PENDING, Context.MODE_PRIVATE);
    }

    /** Durable schedule key prefix used by the scheduler (stable contract). */
    static final String SCH_PREFIX = "sch:";
    static final String CANCEL_PREFIX = "cancel:";
    static final String EVT_PREFIX = "evt:";

    static String schKey(String occurrenceKey) {
        return SCH_PREFIX + occurrenceKey;
    }

    static String cancelKey(String occurrenceKey) {
        return CANCEL_PREFIX + occurrenceKey;
    }

    static String evtKey(String occurrenceKey) {
        return EVT_PREFIX + occurrenceKey;
    }

    /**
     * Future local calendar date (YYYY-MM-DD) at least {@code daysAhead} days from now.
     */
    static String futureCalendarDate(int daysAhead) {
        Calendar cal = Calendar.getInstance(TimeZone.getDefault(), Locale.US);
        cal.add(Calendar.DAY_OF_MONTH, daysAhead);
        return String.format(
                Locale.US,
                "%04d-%02d-%02d",
                cal.get(Calendar.YEAR),
                cal.get(Calendar.MONTH) + 1,
                cal.get(Calendar.DAY_OF_MONTH));
    }

    static long futureEpochMs(String calendarDate, String timeHhmm) {
        Long epoch = AutoDeductionScheduler.computeEpochMs(calendarDate, timeHhmm);
        if (epoch == null) {
            throw new IllegalArgumentException("bad datetime " + calendarDate + " " + timeHhmm);
        }
        // Ensure strictly in the future for scheduleOccurrence.
        long now = System.currentTimeMillis();
        if (epoch <= now) {
            return now + 60_000L;
        }
        return epoch;
    }

    static AutoDeductionScheduler newScheduler() {
        return new AutoDeductionScheduler(appContext());
    }

    static AutoDeductionEventStore newEventStore() {
        return new AutoDeductionEventStore(appContext());
    }
}
