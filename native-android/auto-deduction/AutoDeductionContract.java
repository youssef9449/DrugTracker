package app.drugtracker.autodeduction;

/**
 * Shared constants and canonical occurrence-key helpers for exact-time
 * automatic dose deduction (Phase 2).
 *
 * Occurrence identity (hard requirement):
 *   medicationId + doseId + calendarDate (YYYY-MM-DD)
 *
 * Canonical storage / PendingIntent key is deterministic, stable, and
 * collision-resistant given repository ID constraints (UUID-prefixed ids
 * and LEGACY_DOSE_ID = "legacy"; neither contains the unit separator).
 */
public final class AutoDeductionContract {

    private AutoDeductionContract() {}

    public static final String ACTION_AUTO_DEDUCTION =
            "app.drugtracker.action.AUTO_DEDUCTION";

    public static final String EXTRA_MEDICATION_ID = "medicationId";
    public static final String EXTRA_DOSE_ID = "doseId";
    public static final String EXTRA_CALENDAR_DATE = "calendarDate";
    public static final String EXTRA_SCHEDULED_AT_EPOCH_MS = "scheduledAtEpochMs";
    public static final String EXTRA_AMOUNT = "amount";
    public static final String EXTRA_TIME_HHMM = "timeHhmm";

    public static final String PREFS_EVENTS = "drugtracker_auto_deduction_events_v1";
    public static final String PREFS_SCHEDULES = "drugtracker_auto_deduction_schedules_v1";

    public static final String STATUS_FIRED = "FIRED";
    public static final String STATUS_RECONCILED = "RECONCILED";

    private static final char SEP = '\u001f';

    public static String occurrenceKey(String medicationId, String doseId, String calendarDate) {
        if (medicationId == null) medicationId = "";
        if (doseId == null) doseId = "";
        if (calendarDate == null) calendarDate = "";
        return medicationId + SEP + doseId + SEP + calendarDate;
    }

    public static int pendingIntentRequestCode(String occurrenceKey) {
        int h = occurrenceKey.hashCode();
        int code = (h ^ 0xAD00DED) & 0x7fffffff;
        return code == 0 ? 0xAD00DED : code;
    }

    public static boolean isValidAmount(double amount) {
        return !Double.isNaN(amount) && !Double.isInfinite(amount) && amount > 0;
    }

    public static boolean isValidCalendarDate(String date) {
        if (date == null || date.length() != 10) return false;
        for (int i = 0; i < 10; i++) {
            char c = date.charAt(i);
            if (i == 4 || i == 7) {
                if (c != '-') return false;
            } else if (c < '0' || c > '9') {
                return false;
            }
        }
        return true;
    }

    public static boolean isValidTimeHhmm(String time) {
        if (time == null) return false;
        if (time.length() < 4 || time.length() > 5) return false;
        int colon = time.indexOf(':');
        if (colon < 1) return false;
        try {
            int h = Integer.parseInt(time.substring(0, colon));
            int m = Integer.parseInt(time.substring(colon + 1));
            return h >= 0 && h <= 23 && m >= 0 && m <= 59;
        } catch (NumberFormatException e) {
            return false;
        }
    }
}
