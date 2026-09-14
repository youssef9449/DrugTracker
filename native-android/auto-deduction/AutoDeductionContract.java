package app.drugtracker.autodeduction;

import android.net.Uri;

/**
 * Shared constants and canonical occurrence-key helpers for exact-time
 * automatic dose deduction (Phase 2).
 *
 * Occurrence identity (hard requirement):
 *   medicationId + doseId + calendarDate (YYYY-MM-DD)
 *
 * Canonical storage key and PendingIntent data URI are both derived from
 * the full occurrence identity — never from a 32-bit hash alone.
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
    /** Independent prefs for pending-fire recovery when primary FIRED commit fails. */
    public static final String PREFS_PENDING = "drugtracker_auto_deduction_pending_v1";

    public static final String STATUS_FIRED = "FIRED";
    public static final String STATUS_RECONCILED = "RECONCILED";

    /**
     * Shared request-code namespace for auto-deduction PendingIntents.
     * NOT a unique identity: uniqueness comes from Intent action + data URI
     * (see {@link #occurrenceUri}). Kept constant so cancel/schedule always
     * match on the same request-code + data pair.
     */
    public static final int PENDING_INTENT_REQUEST_CODE = 0xAD00DED;

    /** Content-authority style path for auto-deduction occurrence URIs. */
    private static final String URI_SCHEME = "content";
    private static final String URI_AUTHORITY = "app.drugtracker.autodeduction";
    private static final String URI_PATH_PREFIX = "occurrence";

    private static final char SEP = '\u001f';

    /**
     * Deterministic canonical key for one automatic occurrence.
     * Must match the identity used by JS reconciliation (Phase 3).
     */
    public static String occurrenceKey(String medicationId, String doseId, String calendarDate) {
        if (medicationId == null) medicationId = "";
        if (doseId == null) doseId = "";
        if (calendarDate == null) calendarDate = "";
        return medicationId + SEP + doseId + SEP + calendarDate;
    }

    /**
     * Deterministic Intent data URI for PendingIntent matching.
     * Full occurrence identity participates — two different
     * (med, dose, date) triples never share the same URI.
     *
     * Format: content://app.drugtracker.autodeduction/occurrence/{med}/{dose}/{date}
     * Components are Uri-encoded so special characters cannot collapse identities.
     */
    public static Uri occurrenceUri(String medicationId, String doseId, String calendarDate) {
        if (medicationId == null) medicationId = "";
        if (doseId == null) doseId = "";
        if (calendarDate == null) calendarDate = "";
        return new Uri.Builder()
                .scheme(URI_SCHEME)
                .authority(URI_AUTHORITY)
                .appendPath(URI_PATH_PREFIX)
                .appendPath(medicationId)
                .appendPath(doseId)
                .appendPath(calendarDate)
                .build();
    }

    /**
     * @deprecated Prefer {@link #PENDING_INTENT_REQUEST_CODE} with
     * {@link #occurrenceUri}. Kept only for reference; must not be used
     * as the sole PendingIntent identity.
     */
    @Deprecated
    public static int pendingIntentRequestCode(String occurrenceKey) {
        // Stable helper only — Intent data URI is the uniqueness source.
        return PENDING_INTENT_REQUEST_CODE;
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
