package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Regression coverage for pre-token exact alarms that may already be queued when
 * the app is upgraded to the tokenized scheduler.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class LegacyDeliveryCompatibilityTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void legacyDeliveryWithLegacyMetadata_isAccepted() throws Exception {
        String date = futureCalendarDate(2);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);

        JSONObject legacy = new JSONObject();
        legacy.put("medicationId", "med");
        legacy.put("doseId", "dose");
        legacy.put("calendarDate", date);
        legacy.put("timeHhmm", "10:00");
        legacy.put("amount", 1.5);
        legacy.put("scheduledAtEpochMs", 1_000L);
        schedulePrefs().edit().putString(schKey(key), legacy.toString()).commit();

        AutoDeductionScheduler.FireResult result =
                Phase2TestSupport.newScheduler().fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 1_000L, 1.5, null, 0L);

        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, result.status);
        assertTrue(eventPrefs().contains(evtKey(key)));
    }

    @Test
    public void legacyDeliveryAgainstVersionedMetadata_isRejected() throws Exception {
        String date = futureCalendarDate(3);
        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();

        assertTrue(scheduler.scheduleOccurrence(
                "med", "dose", date, "11:00", 2.0,
                AutoDeductionScheduler.computeEpochMs(date, "11:00")).ok);

        AutoDeductionScheduler.FireResult result =
                scheduler.fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 2_000L, 2.0, null, 0L);

        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, result.status);
        assertFalse(eventPrefs().contains(
                evtKey(AutoDeductionContract.occurrenceKey("med", "dose", date))));
    }

    @Test
    public void legacyDeliveryWhenActiveGenerationAlreadyExists_isRejected() throws Exception {
        String date = futureCalendarDate(4);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);

        JSONObject legacy = new JSONObject();
        legacy.put("medicationId", "med");
        legacy.put("doseId", "dose");
        legacy.put("calendarDate", date);
        legacy.put("timeHhmm", "12:00");
        legacy.put("amount", 1.0);
        legacy.put("scheduledAtEpochMs", 1_000L);
        schedulePrefs().edit().putString(schKey(key), legacy.toString()).commit();

        // Simulates a legacy queued alarm surviving after the recurrence chain
        // has already been advanced/invalidated by the tokenized scheduler.
        Phase2TestSupport.appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0)
                .edit()
                .putLong(
                        AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                                + AutoDeductionContract.scheduleIdentityKey("med", "dose"),
                        1L)
                .commit();

        AutoDeductionScheduler.FireResult result =
                Phase2TestSupport.newScheduler().fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 1_000L, 1.0, null, 0L);

        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, result.status);
        assertFalse(eventPrefs().contains(evtKey(key)));
    }
}
