package app.drugtracker.autodeduction;
import android.net.Uri;
import app.drugtracker.alarmruntime.ExactAlarmContract;
/**
 * Shared constants and canonical occurrence-key helpers for exact-time
 * automatic dose deduction.
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
    /** In-process event bridge from the exact-alarm receiver to the Capacitor plugin. */
    public static final String ACTION_AUTO_DEDUCTION_FIRED =
            "app.drugtracker.action.AUTO_DEDUCTION_FIRED";
    public static final String EXTRA_MEDICATION_ID = "medicationId";
    public static final String EXTRA_DOSE_ID = "doseId";
    public static final String EXTRA_CALENDAR_DATE = "calendarDate";
    public static final String EXTRA_SCHEDULED_AT_EPOCH_MS = "scheduledAtEpochMs";
    public static final String EXTRA_AMOUNT = "amount";
    public static final String EXTRA_TIME_HHMM = "timeHhmm";
    public static final String EXTRA_TREATMENT_END_DATE = "treatmentEndDate";
    /**
     * Recurrence authorization generation stamped into the PendingIntent when the
     * occurrence was scheduled. Receiver must pass this to successor creation so
     * disable/cancel (which bumps the active generation) can refuse D+1.
     * Distinct from the per-occurrence generic operationVersion ownership token.
     */
    public static final String EXTRA_RECURRENCE_GENERATION = "recurrenceGeneration";
    /** Generic shared-runtime ownership token carried by new alarm PendingIntents. */
    public static final String EXTRA_OPERATION_VERSION =
            ExactAlarmContract.EXTRA_OPERATION_VERSION;
    /**
     * Bounded fire-persistence retry counter carried on a retry delivery (0 on
     * the original alarm). See {@link #FIRE_RETRY_DELAY_MS} /
     * {@link #MAX_FIRE_RETRIES} and
     * {@code AutoDeductionScheduler#scheduleFireRetry}.
     */
    public static final String EXTRA_FIRE_RETRY_COUNT = "fireRetryCount";
    /** Delay before a fire-persistence retry alarm re-delivers the same occurrence. */
    public static final long FIRE_RETRY_DELAY_MS = 60_000L;
    /** Maximum number of fire-persistence retry alarms per occurrence (bounded). */
    public static final int MAX_FIRE_RETRIES = 3;
    public static final String PREFS_EVENTS = "drugtracker_auto_deduction_events_v1";
    public static final String PREFS_SCHEDULES = "drugtracker_auto_deduction_schedules_v1";
    /** Independent prefs for pending-fire recovery when primary FIRED commit fails. */
    public static final String PREFS_PENDING = "drugtracker_auto_deduction_pending_v1";
    /**
     * Independent durable fire-failure / retry evidence, keyed by occurrence identity.
     * Survives shared schedule metadata removal (config mutation, disable, delete) so a
     * failed FIRED persistence can still be retried without depending on the alarm store.
     */
    public static final String PREFS_FIRE_RETRY = "drugtracker_auto_deduction_fire_retry_v1";
    /**
     * Durable cancellation tombstones keyed by occurrence identity.
     * Survives process death so restore and AutoDeductionReceiver cannot promote a
     * cancelled occurrence to FIRED (stale schedule metadata or stale alarm delivery).
     * A later schedule with newer operationVersion supersedes the tombstone.
     */
    public static final String PREFS_CANCELLED = "drugtracker_auto_deduction_cancelled_v1";
    /**
     * Durable monotonic ordering sequence for generic operationVersion / cancellation tokens.
     * Survives process death so (millis, seq) comparisons remain reconstructible
     * after reboot. The shared runtime contract owns the ordering-key name.
     */
    public static final String PREFS_ORDERING = "drugtracker_auto_deduction_ordering_v1";
    /**
     * Medication+dose schedule recurrence authorization.
     * Keyed by {@link #scheduleIdentityKey(String, String)}; value is a monotonic
     * long generation. Disable/cancel bumps the generation under SCHEDULE_LOCK so
     * post-fire successor creation for a stale generation cannot install D+1.
     * Independent of per-occurrence operationVersion ownership tokens.
     */
    public static final String PREFS_RECURRENCE_AUTH =
            "drugtracker_auto_deduction_recurrence_auth_v1";
    /** Prefs key prefix for active recurrence generation (medicationId + doseId). */
    public static final String RECURRENCE_AUTH_KEY_PREFIX = "rgen:";
    /**
     * Durable schedule-chain identity (medication + dose slot), NOT including
     * calendarDate. Used only for recurrence authorization generation.
     */
    public static String scheduleIdentityKey(String medicationId, String doseId) {
        if (medicationId == null) medicationId = "";
        if (doseId == null) doseId = "";
        return medicationId + SEP + doseId;
    }
    public static final String STATUS_FIRED = "FIRED";
    public static final String STATUS_RECONCILED = "RECONCILED";
    /** Terminal: irreparably malformed FIRED record (invalid identity/date/amount). */
    public static final String STATUS_REJECTED = "REJECTED";
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
     * Must match the identity used by JS reconciliation.
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
        return ExactAlarmContract.buildIdentityUri(
                URI_SCHEME,
                URI_AUTHORITY,
                URI_PATH_PREFIX,
                medicationId,
                doseId,
                calendarDate);
    }
    public static boolean isValidAmount(double amount) {
        return !Double.isNaN(amount) && !Double.isInfinite(amount) && amount > 0;
    }
    /**
     * Strict YYYY-MM-DD validation. Rejects structurally valid but impossible dates
     * (e.g. 2026-02-31, 2026-13-01) without relying on Calendar lenient normalization.
     * Leap-year February 29 is accepted only for leap years.
     */
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
        int year;
        int month;
        int day;
        try {
            year = Integer.parseInt(date.substring(0, 4));
            month = Integer.parseInt(date.substring(5, 7));
            day = Integer.parseInt(date.substring(8, 10));
        } catch (NumberFormatException e) {
            return false;
        }
        if (month < 1 || month > 12) return false;
        if (day < 1) return false;
        int maxDay;
        switch (month) {
            case 1: case 3: case 5: case 7: case 8: case 10: case 12:
                maxDay = 31;
                break;
            case 4: case 6: case 9: case 11:
                maxDay = 30;
                break;
            case 2:
                maxDay = isGregorianLeapYear(year) ? 29 : 28;
                break;
            default:
                return false;
        }
        return day <= maxDay;
    }
    /** Gregorian leap-year rule (proleptic). */
    static boolean isGregorianLeapYear(int year) {
        if (year % 4 != 0) return false;
        if (year % 100 != 0) return true;
        return year % 400 == 0;
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