package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.cancelKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.cancelPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.readAuthGeneration;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Native regression for PR #220: {@link AutoDeductionScheduler#scheduleNextOccurrenceIfAbsent}.
 * Must not resurrect a cancelled D+1 from a stale/duplicate D delivery.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class ScheduleNextIfAbsentTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void absentActiveSuccessor_isCreated() throws Exception {
        // Choose D such that D+1 is still a future calendar date for scheduling.
        String d = futureCalendarDate(5);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        assertNotNull(d1);

        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d, "08:00", 1.5, futureEpochMs(d, "08:00")).ok);
        AutoDeductionScheduler.ScheduleResult r =
                s.scheduleNextOccurrenceIfAbsent(
                        "med", "dose", d, "08:00", 1.5,
                        readAuthGeneration("med", "dose"));
        assertTrue("expected create ok, got " + r.error, r.ok);

        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        assertTrue(schedulePrefs().contains(schKey(d1Key)));
        String raw = schedulePrefs().getString(schKey(d1Key), null);
        assertNotNull(raw);
        JSONObject o = new JSONObject(raw);
        assertEquals(1.5, o.getDouble("amount"), 0.001);
        assertEquals("08:00", o.getString("timeHhmm"));
    }

    @Test
    public void treatmentEndDate_preventsSuccessorAfterCourseEnds() throws Exception {
        String d = futureCalendarDate(5);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        assertNotNull(d1);

        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med",
                "dose",
                d,
                "09:00",
                1.0,
                futureEpochMs(d, "09:00"),
                d).ok);

        AutoDeductionScheduler.ScheduleResult r =
                s.scheduleNextOccurrenceIfAbsent(
                        "med",
                        "dose",
                        d,
                        "09:00",
                        1.0,
                        readAuthGeneration("med", "dose"));

        assertTrue(r.ok);
        assertEquals("treatment_ended", r.error);

        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        assertFalse("course end must not create D+1",
                schedulePrefs().contains(schKey(d1Key)));
    }

    @Test
    public void existingSuccessor_notOverwrittenByStalePayload() throws Exception {
        String d = futureCalendarDate(6);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        assertNotNull(d1);

        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d, "01:00", 9.9, futureEpochMs(d, "01:00")).ok);
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d1, "09:30", 3.0, futureEpochMs(d1, "09:30")).ok);

        // D+1 is already present with a newer payload — a stale duplicate D
        // delivery must not rewrite it.
        AutoDeductionScheduler.ScheduleResult r =
                s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "01:00", 9.9,
                        readAuthGeneration("med", "dose"));
        assertTrue(r.ok);

        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        JSONObject o = new JSONObject(schedulePrefs().getString(schKey(d1Key), "{}"));
        assertEquals(3.0, o.getDouble("amount"), 0.001);
        assertEquals("09:30", o.getString("timeHhmm"));
    }

    @Test
    public void cancelledSuccessor_notResurrectedByStaleDuplicateD() throws Exception {
        String d = futureCalendarDate(7);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        assertNotNull(d1);

        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d, "10:00", 2.0, futureEpochMs(d, "10:00")).ok);
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d1, "10:00", 2.0, futureEpochMs(d1, "10:00")).ok);

        assertTrue(s.cancelOccurrence("med", "dose", d1).isOk());

        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        assertFalse("metadata must be removed on cancel", schedulePrefs().contains(schKey(d1Key)));
        assertTrue("tombstone must remain", cancelPrefs().contains(cancelKey(d1Key)));
        assertTrue(s.isOccurrenceCancelled("med", "dose", d1));

        // Stale/duplicate D fire path: scheduleNextOccurrenceIfAbsent must no-op.
        AutoDeductionScheduler.ScheduleResult r =
                s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "10:00", 2.0,
                        readAuthGeneration("med", "dose"));
        assertTrue("cancelled successor is success no-op, err=" + r.error, r.ok);

        assertFalse("D+1 must not be recreated", schedulePrefs().contains(schKey(d1Key)));
        assertTrue("tombstone must remain effective", cancelPrefs().contains(cancelKey(d1Key)));
        assertTrue(s.isOccurrenceCancelled("med", "dose", d1));
    }

    @Test
    public void multiDose_staleOneDoseDoesNotAffectOtherDoseSuccessor() throws Exception {
        String d = futureCalendarDate(8);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        assertNotNull(d1);

        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "am", d, "08:00", 1.0, futureEpochMs(d, "08:00")).ok);
        assertTrue(s.scheduleOccurrence(
                "med", "pm", d, "20:00", 1.0, futureEpochMs(d, "20:00")).ok);
        assertTrue(s.scheduleOccurrence(
                "med", "am", d1, "08:00", 1.0, futureEpochMs(d1, "08:00")).ok);
        assertTrue(s.scheduleOccurrence(
                "med", "pm", d1, "20:00", 1.0, futureEpochMs(d1, "20:00")).ok);

        assertTrue(s.cancelOccurrence("med", "am", d1).isOk());

        // Stale delivery for AM dose must not recreate AM D+1; PM stays scheduled.
        assertTrue(s.scheduleNextOccurrenceIfAbsent("med", "am", d, "08:00", 1.0,
                readAuthGeneration("med", "am")).ok);

        String amKey = AutoDeductionContract.occurrenceKey("med", "am", d1);
        String pmKey = AutoDeductionContract.occurrenceKey("med", "pm", d1);
        assertFalse(schedulePrefs().contains(schKey(amKey)));
        assertTrue(schedulePrefs().contains(schKey(pmKey)));
        assertTrue(s.isOccurrenceCancelled("med", "am", d1));
        assertFalse(s.isOccurrenceCancelled("med", "pm", d1));
    }

    @Test
    public void repeatedDuplicateDeliveries_doNotDuplicateSuccessor() throws Exception {
        String d = futureCalendarDate(9);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        assertNotNull(d1);

        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d, "07:00", 1.0, futureEpochMs(d, "07:00")).ok);
        long generation = readAuthGeneration("med", "dose");
        assertTrue(generation > 0L);
        assertTrue(s.scheduleNextOccurrenceIfAbsent(
                "med", "dose", d, "07:00", 1.0, generation).ok);
        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        String firstRaw = schedulePrefs().getString(schKey(d1Key), null);
        assertNotNull(firstRaw);

        assertTrue(s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "07:00", 99.0,
                readAuthGeneration("med", "dose")).ok);
        assertTrue(s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "03:00", 0.5,
                readAuthGeneration("med", "dose")).ok);

        assertEquals(firstRaw, schedulePrefs().getString(schKey(d1Key), null));
    }
}
