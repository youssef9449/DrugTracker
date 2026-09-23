package app.drugtracker.autodeduction;

import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Pure Auto-Deduction calendar/time helpers.
 *
 * <p>This utility owns only wall-clock date resolution. Scheduler orchestration,
 * recurrence authorization, and AlarmManager mechanics remain elsewhere.</p>
 */
final class AutoDeductionDateTime {

    private AutoDeductionDateTime() {}

    static Long computeEpochMs(String calendarDate, String timeHhmm) {
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

    static boolean isOlderThanLocalDays(String calendarDate, int days) {
        if (!AutoDeductionContract.isValidCalendarDate(calendarDate) || days < 0) {
            return false;
        }
        try {
            int y = Integer.parseInt(calendarDate.substring(0, 4));
            int mo = Integer.parseInt(calendarDate.substring(5, 7));
            int d = Integer.parseInt(calendarDate.substring(8, 10));
            Calendar target = Calendar.getInstance(
                    TimeZone.getDefault(), Locale.getDefault());
            target.clear();
            target.set(Calendar.YEAR, y);
            target.set(Calendar.MONTH, mo - 1);
            target.set(Calendar.DAY_OF_MONTH, d);

            Calendar cutoff = Calendar.getInstance(
                    TimeZone.getDefault(), Locale.getDefault());
            cutoff.set(Calendar.HOUR_OF_DAY, 0);
            cutoff.set(Calendar.MINUTE, 0);
            cutoff.set(Calendar.SECOND, 0);
            cutoff.set(Calendar.MILLISECOND, 0);
            cutoff.add(Calendar.DAY_OF_MONTH, -days);
            return target.before(cutoff);
        } catch (RuntimeException e) {
            return false;
        }
    }

    static String nextCalendarDate(String calendarDate) {
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
