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

import org.json.JSONObject;
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
    /**
     * A durable pending-fire fallback is still a new FIRED outcome and must wake
     * event-driven JS reconciliation immediately. A duplicate FIRED row must not
     * emit a second wake-up because its original durable transition already did.
     */
    @Test
    public void pendingFireFailure_wakesJavascript_butDuplicateDoesNot() {
        AutoDeductionScheduler.FireResult pendingFailure =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, true);
        AutoDeductionScheduler.FireResult duplicate =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS, false);
        AutoDeductionScheduler.FireResult noPendingFailure =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, false);
        AutoDeductionScheduler.FireResult cancelled =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.CANCELLED, false);

        assertTrue(AutoDeductionReceiver.shouldNotifyJavascript(pendingFailure));
        assertFalse(AutoDeductionReceiver.shouldNotifyJavascript(duplicate));
        assertFalse(AutoDeductionReceiver.shouldNotifyJavascript(noPendingFailure));
        assertFalse(AutoDeductionReceiver.shouldNotifyJavascript(cancelled));
        assertFalse(AutoDeductionReceiver.shouldNotifyJavascript(null));
    }

    @Test
    public void cancelFirst_fireReturnsCancelled_noFiredNoPendingNoRecurrence() {
        String date = futureCalendarDate(2);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 1.0, futureEpochMs(date, "12:00")).ok);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());

        // After cancel, no active metadata — any delivery tokens are rejected (Issue #240).
        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 1_000L, 1.0, "stale-v", 1L);

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
    public void fireFirst_createsFired_laterCancelDoesNotEraseFired() throws Exception {
        String date = futureCalendarDate(3);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "13:00", 2.0, futureEpochMs(date, "13:00")).ok);

        String[] vg = activeVersionAndGen("med", "dose", date);
        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 2_000L, 2.0, vg[0], Long.parseLong(vg[1]));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);
        assertTrue(fire.allowsRecurrence());
        assertTrue(receiverWouldScheduleNext(fire));

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        assertTrue(eventPrefs().contains(evtKey(key)));

        // Later cancel tombstones the occurrence for *future* deliveries but must not
        // remove the durable FIRED row.
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());
        assertTrue("FIRED remains after later cancel", eventPrefs().contains(evtKey(key)));

        // Replay with the pre-cancel delivery tokens — cancelled / no metadata → no second FIRED.
        AutoDeductionScheduler.FireResult replay =
                s.fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 2_000L, 2.0, vg[0], Long.parseLong(vg[1]));
        assertTrue(eventPrefs().contains(evtKey(key)));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, replay.status);
        assertFalse(replay.allowsRecurrence());
        assertFalse(receiverWouldScheduleNext(replay));
    }

    @Test
    public void duplicateFire_alreadyExists_allowsRecurrenceGate() throws Exception {
        String date = futureCalendarDate(5);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "14:00", 1.0, futureEpochMs(date, "14:00")).ok);
        String[] vg = activeVersionAndGen("med", "dose", date);

        AutoDeductionScheduler.FireResult first =
                s.fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 1L, 1.0, vg[0], Long.parseLong(vg[1]));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, first.status);

        AutoDeductionScheduler.FireResult second =
                s.fireOccurrenceIfNotCancelled(
                        "med", "dose", date, 1L, 1.0, vg[0], Long.parseLong(vg[1]));
        assertEquals(AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS, second.status);
        assertTrue(second.allowsRecurrence());
        assertTrue(receiverWouldScheduleNext(second));
    }

    @Test
    public void fireCreated_thenScheduleNextIfAbsent_createsSuccessorWhenActive()
            throws Exception {
        String d = futureCalendarDate(10);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", d, "09:00", 1.0, futureEpochMs(d, "09:00")).ok);
        String[] vg = activeVersionAndGen("med", "dose", d);
        AutoDeductionScheduler.FireResult fire =
                s.fireOccurrenceIfNotCancelled(
                        "med", "dose", d, 1L, 1.0, vg[0], Long.parseLong(vg[1]));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);
        assertTrue(fire.allowsRecurrence());
        assertTrue(receiverWouldScheduleNext(fire));

        // Only after a recurrence-allowing fire result would the receiver invoke this API.
        AutoDeductionScheduler.ScheduleResult next =
                s.scheduleNextOccurrenceIfAbsent("med", "dose", d, "08:00", 1.0,
                        Long.parseLong(vg[1]));
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

    /** Read durable ownership tokens stamped into schedule metadata after schedule. */
    private static String[] activeVersionAndGen(String med, String dose, String date)
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        String raw = schedulePrefs().getString(schKey(key), null);
        assertTrue("expected schedule metadata for " + key, raw != null && !raw.isEmpty());
        JSONObject o = new JSONObject(raw);
        String v = o.optString("scheduleVersion", "");
        long g = o.optLong("recurrenceGeneration", 0L);
        assertTrue("scheduleVersion present", v != null && !v.isEmpty());
        assertTrue("recurrenceGeneration present", g > 0L);
        return new String[] { v, Long.toString(g) };
    }

    private static AutoDeductionScheduler.FireResult fireWithActiveOwnership(
            AutoDeductionScheduler s,
            String med,
            String dose,
            String date,
            long scheduledAt,
            double amount
    ) throws Exception {
        String[] vg = activeVersionAndGen(med, dose, date);
        return s.fireOccurrenceIfNotCancelled(
                med, dose, date, scheduledAt, amount, vg[0], Long.parseLong(vg[1]));
    }

    private static boolean receiverWouldScheduleNext(AutoDeductionScheduler.FireResult fire) {
        return fire.allowsRecurrence();
    }
}
