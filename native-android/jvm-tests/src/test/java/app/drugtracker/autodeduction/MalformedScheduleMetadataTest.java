package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schedulePrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schKey;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Regression coverage for malformed durable schedule metadata.
 *
 * <p>Malformed rows with a canonical storage key are quarantined safely
 * (matching alarm canceled + metadata removed). Unsafe storage keys fail closed
 * instead of being silently treated as an empty native schedule set.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MalformedScheduleMetadataTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void malformedPayloadWithCanonicalKey_isQuarantinedAndNotListed() throws Exception {
        String date = futureCalendarDate(2);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);

        JSONObject malformed = new JSONObject();
        malformed.put("medicationId", "med");
        malformed.put("doseId", "dose");
        malformed.put("calendarDate", date);
        malformed.put("timeHhmm", "09:00");
        malformed.put("amount", 0.0);
        malformed.put("scheduledAtEpochMs", 1_000L);
        schedulePrefs().edit().putString(schKey(key), malformed.toString()).commit();

        assertTrue("precondition: malformed row exists",
                schedulePrefs().contains(schKey(key)));

        assertTrue(
                "valid key must be parseable and quarantinable",
                AutoDeductionTestSupport.newScheduler().listScheduledOccurrences().isEmpty());

        assertFalse(
                "malformed metadata must not remain as stale durable schedule",
                schedulePrefs().contains(schKey(key)));
    }

    @Test
    public void identityMismatchWithCanonicalKey_isQuarantined() throws Exception {
        String date = futureCalendarDate(3);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);

        JSONObject malformed = new JSONObject();
        malformed.put("medicationId", "other-med");
        malformed.put("doseId", "dose");
        malformed.put("calendarDate", date);
        malformed.put("timeHhmm", "10:00");
        malformed.put("amount", 1.0);
        malformed.put("scheduledAtEpochMs", 1_000L);
        schedulePrefs().edit().putString(schKey(key), malformed.toString()).commit();

        assertTrue(AutoDeductionTestSupport.newScheduler()
                .listScheduledOccurrences().isEmpty());
        assertFalse(schedulePrefs().contains(schKey(key)));
    }

    @Test
    public void unsafeStorageKey_failsClosedInsteadOfSilentlySkipping() {
        schedulePrefs().edit()
                .putString("sch:unsafe", "{bad-json")
                .commit();

        try {
            AutoDeductionTestSupport.newScheduler().listScheduledOccurrences();
            fail("expected malformed schedule listing failure");
        } catch (IllegalStateException expected) {
            assertEquals(
                    "malformed_schedule_metadata_cleanup_failed",
                    expected.getMessage());
        }

        assertTrue(
                "unsafe row must remain for explicit recovery rather than being discarded blindly",
                schedulePrefs().contains("sch:unsafe"));
    }
}
