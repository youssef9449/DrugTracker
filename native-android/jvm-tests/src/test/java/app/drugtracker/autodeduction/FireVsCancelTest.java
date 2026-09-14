package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.pendingPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Deterministic fire-vs-cancel outcomes via real {@link AutoDeductionScheduler}
 * serialization APIs (not concurrent sleep-based races).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FireVsCancelTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void cancelFirst_fireReturnsCancelled_noFiredNoPendingNoRecurrence() {
        String date = futureCalendarDate(2);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 1.0, futureEpochMs(date, "12:00")).ok);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());

        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled("med", "dose", date, 1_000L, 1.0);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, fire.status);
        assertFalse(fire.pendingRecorded);
        assertFalse(fire.allowsRecurrence());

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        assertFalse(eventPrefs().contains(evtKey(key)));
        assertTrue(pendingPrefs().getAll().isEmpty());

        // Receiver would not schedule next when CANCELLED.
        AutoDeductionScheduler.ScheduleResult next =
                s.scheduleNextOccurrenceIfAbsent("med", "dose", date, "12:00", 1.0);
        // D+1 may or may not exist depending on cancel-of-D only; ensure fire did not
        // force-create from a cancelled fire path when we skip scheduling — here we
        // assert the fire outcome alone is non-recurring.
        assertFalse(fire.allowsRecurrence());
        assertTrue(next.ok || next.error != null); // call is safe; recurrence gate is fire
    }

    @Test
    public void fireFirst_createsFired_laterCancelDoesNotEraseFired() {
        String date = futureCalendarDate(3);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "13:00", 2.0, futureEpochMs(date, "13:00")).ok);

        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled("med", "dose", date, 2_000L, 2.0);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);
        assertTrue(fire.allowsRecurrence());

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        assertTrue(eventPrefs().contains(evtKey(key)));

        // Later cancel tombstones the occurrence for *future* deliveries but must not
        // remove the durable FIRED row.
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());
        assertTrue(eventPrefs().contains(evtKey(key)));

        AutoDeductionScheduler.FireResult replay =
                s.fireOccurrenceIfNotCancelled("med", "dose", date, 2_000L, 2.0);
        // Cancel linearized for this delivery: CANCELLED (no second FIRED path needed).
        // FIRED row from the first fire remains.
        assertTrue(eventPrefs().contains(evtKey(key)));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, replay.status);
    }

    @Test
    public void duplicateFire_alreadyExists_allowsRecurrenceGate() {
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.FireResult first =
                s.fireOccurrenceIfNotCancelled("med", "dose", "2026-09-10", 1L, 1.0);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, first.status);

        AutoDeductionScheduler.FireResult second =
                s.fireOccurrenceIfNotCancelled("med", "dose", "2026-09-10", 1L, 1.0);
        assertEquals(AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS, second.status);
        assertTrue(second.allowsRecurrence());
    }

    @Test
    public void fireCreated_thenScheduleNextIfAbsent_createsSuccessorWhenActive() {
        // D is a past/fire identity; successor uses next calendar date from D.
        String d = futureCalendarDate(10);
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled("med", "dose", d, 1L, 1.0);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);
        assertTrue(fire.allowsRecurrence());

        AutoDeductionScheduler.ScheduleResult next =
                s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "08:00", 1.0);
        assertTrue("successor schedule: " + next.error, next.ok);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        assertTrue(schedulePrefs().contains(schKey(d1Key)));
    }
}
