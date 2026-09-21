package app.drugtracker.alarmruntime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Pure contract tests for shared exact-alarm identity. */
public class ExactAlarmContractTest {

    @Test
    public void buildIdentityUri_containsFeatureAndFullIdentity() {
        String uri = ExactAlarmContract.buildIdentityUri(
                "content",
                "app.drugtracker.alarm",
                "alarm",
                "auto-deduction",
                "med id",
                "dose/1",
                "2026-09-30").toString();

        assertEquals(
                "content://app.drugtracker.alarm/alarm/auto-deduction/med%20id/dose%2F1/2026-09-30",
                uri);
        assertTrue(ExactAlarmContract.isValidIdentityUri(uri));
        assertTrue(ExactAlarmContract.isValidIdentityUri(
                "content://app.drugtracker.autodeduction/occurrence/med/dose/2026-09-30"));
    }

    @Test
    public void resolveLocalDateTimeEpochMs_usesCalendarDateAndWallClock() {
        java.util.Calendar expected = java.util.Calendar.getInstance();
        expected.clear();
        expected.setLenient(false);
        expected.set(2026, 8, 30, 8, 5, 0);
        expected.set(java.util.Calendar.MILLISECOND, 0);

        assertEquals(
                expected.getTimeInMillis(),
                ExactAlarmContract.resolveLocalDateTimeEpochMs(
                        "2026-09-30",
                        "08:05",
                        false));
        assertEquals(
                expected.getTimeInMillis(),
                ExactAlarmContract.resolveLocalDateTimeEpochMs(
                        "2026-09-30",
                        "8:05",
                        false));
        assertEquals(
                -1L,
                ExactAlarmContract.resolveLocalDateTimeEpochMs(
                        "2026-02-30",
                        "08:05",
                        false));
        assertTrue(
                ExactAlarmContract.resolveLocalDateTimeEpochMs(
                        "2026-02-30",
                        "08:05",
                        true) > 0L);
    }

    @Test
    public void identityValidation_rejectsEmptyAndNonContentUri() {
        assertFalse(ExactAlarmContract.isValidIdentityUri(null));
        assertFalse(ExactAlarmContract.isValidIdentityUri(""));
        assertFalse(ExactAlarmContract.isValidIdentityUri("https://example.com/alarm"));
        assertFalse(ExactAlarmContract.isValidIdentityUri("content:///missing-authority"));
    }
}
