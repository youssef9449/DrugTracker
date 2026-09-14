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
 * serialization APIs.
 *
 * <p>True multi-threaded {@code SCHEDULE_LOCK} interleavings are not tested here:
 * there are no production test barriers, and {@code Thread.sleep}-based races would
 * be flaky. These tests cover the durable linearization outcomes that public APIs
 * expose after cancel-first or fire-first ordering.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FireVsCancelTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    /**
     * Cancel linearizes first: a subsequent fire must not create FIRED/pending and
     * must not open the receiver recurrence gate.
     *
     * <p>{@link AutoDeductionReceiver} only calls {@code scheduleNextOccurrenceIfAbsent}
     * when the fire result allows recurrence ({@code CREATED}, {@code ALREADY_EXISTS},
     * or {@code FAILED} with pending). {@link AutoDeductionScheduler.FireResult#allowsRecurrence()}
     * is that public gate — do not call the generic scheduler after CANCELLED as if it
     * were the recurrence decision.
     */
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
        assertFalse(
                "CANCELLED fire must not open receiver recurrence gate",
                fire.allowsRecurrence());

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        assertFalse("no FIRED row for cancelled fire", eventPrefs().contains(evtKey(key)));
        assertTrue("no pending-fire rows", pendingPrefs().getAll().isEmpty());

        // Receiver recurrence rule (documented + implemented): schedule next only when
        // allowsRecurrence() is true. CANCELLED is outside that set.
        assertFalse(receiverWouldScheduleNext(fire));
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
        assertTrue(receiverWouldScheduleNext(fire));

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        assertTrue(eventPrefs().contains(evtKey(key)));

        // Later cancel tombstones the occurrence for *future* deliveries but must not
        // remove the durable FIRED row.
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());
        assertTrue("FIRED remains after later cancel", eventPrefs().contains(evtKey(key)));

        AutoDeductionScheduler.FireResult replay =
                s.fireOccurrenceIfNotCancelled("med", "dose", date, 2_000L, 2.0);
        assertTrue(eventPrefs().contains(evtKey(key)));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, replay.status);
        assertFalse(replay.allowsRecurrence());
        assertFalse(receiverWouldScheduleNext(replay));
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
        assertTrue(receiverWouldScheduleNext(second));
    }

    @Test
    public void fireCreated_thenScheduleNextIfAbsent_createsSuccessorWhenActive() {
        String d = futureCalendarDate(10);
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled("med", "dose", d, 1L, 1.0);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);
        assertTrue(fire.allowsRecurrence());
        assertTrue(receiverWouldScheduleNext(fire));

        // Only after a recurrence-allowing fire result would the receiver invoke this API.
        AutoDeductionScheduler.ScheduleResult next =
                s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "08:00", 1.0);
        assertTrue("successor schedule: " + next.error, next.ok);
        String d1 = AutoDeductionScheduler.nextCalendarDate(d);
        String d1Key = AutoDeductionContract.occurrenceKey("med", "dose", d1);
        assertTrue(schedulePrefs().contains(schKey(d1Key)));
    }

    /**
     * Mirrors {@link AutoDeductionReceiver}'s switch on fire status: recurrence
     * scheduling runs only for CREATED / ALREADY_EXISTS / FAILED+pending — i.e.
     * exactly when {@link AutoDeductionScheduler.FireResult#allowsRecurrence()} is true.
     * This is the public recurrence decision contract; the receiver's private helper
     * is not invoked from tests.
     */
    private static boolean receiverWouldScheduleNext(AutoDeductionScheduler.FireResult fire) {
        return fire.allowsRecurrence();
    }
}
