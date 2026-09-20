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
                "auto-deduction", "med id", "dose/1", "2026-09-30").toString();

        assertEquals(
                "content://app.drugtracker.alarm/alarm/auto-deduction/med%20id/dose%2F1/2026-09-30",
                uri);
        assertTrue(ExactAlarmContract.isValidIdentityUri(uri));
    }

    @Test
    public void identityValidation_rejectsEmptyAndNonContentUri() {
        assertFalse(ExactAlarmContract.isValidIdentityUri(null));
        assertFalse(ExactAlarmContract.isValidIdentityUri(""));
        assertFalse(ExactAlarmContract.isValidIdentityUri("https://example.com/alarm"));
        assertFalse(ExactAlarmContract.isValidIdentityUri("content:///missing-authority"));
    }
}
