package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newEventStore;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.cancelPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.cancelKey;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Real getOccurrenceSnapshot() matrix: FIRED → effective CANCELLED → SCHEDULED → ABSENT.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OccurrenceSnapshotTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void scheduleOnly_returnsScheduledWithAmount() {
        String date = futureCalendarDate(2);
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.ScheduleResult r =
                s.scheduleOccurrence("med", "dose", date, "09:00", 2.5, futureEpochMs(date, "09:00"));
        assertTrue(r.ok);

        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", date);
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.SCHEDULED, snap.status);
        assertEquals(2.5, snap.amount, 0.0001);
    }

    @Test
    public void cancelWithMetadataRemoved_returnsCancelled() {
        String date = futureCalendarDate(3);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence("med", "dose", date, "10:00", 1.0, futureEpochMs(date, "10:00")).ok);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());

        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", date);
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.CANCELLED, snap.status);
        assertNull(snap.amount);
    }

    @Test
    public void tombstonePlusStaleScheduleMetadata_returnsCancelled() throws Exception {
        String date = futureCalendarDate(4);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence("med", "dose", date, "11:00", 3.0, futureEpochMs(date, "11:00")).ok);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());

        // Re-insert stale schedule metadata after cancel (simulates failed metadata removal).
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        JSONObject meta = new JSONObject();
        meta.put("amount", 3.0);
        meta.put("timeHhmm", "11:00");
        meta.put("scheduleVersion", "1-0");
        schedulePrefs().edit().putString(schKey(key), meta.toString()).commit();

        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", date);
        assertEquals(
                "effective cancellation must beat stale schedule metadata",
                AutoDeductionScheduler.OccurrenceSnapshot.Status.CANCELLED,
                snap.status);
    }

    @Test
    public void newerScheduleSupersedesOlderCancellation_returnsScheduled() throws Exception {
        String date = futureCalendarDate(5);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence("med", "dose", date, "08:00", 1.0, futureEpochMs(date, "08:00")).ok);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());

        // Newer schedule after cancel.
        assertTrue(s.scheduleOccurrence("med", "dose", date, "08:00", 4.0, futureEpochMs(date, "08:00")).ok);

        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", date);
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.SCHEDULED, snap.status);
        assertEquals(4.0, snap.amount, 0.0001);
    }

    @Test
    public void firedWinsOverCancellation() {
        String date = "2026-09-10";
        AutoDeductionEventStore store = newEventStore();
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                store.insertFiredIfAbsent("med", "dose", date, 1_000L, 2.0).status);

        AutoDeductionScheduler s = newScheduler();
        // Tombstone present
        cancelPrefs().edit().putString(cancelKey(AutoDeductionContract.occurrenceKey("med", "dose", date)), "1-0").commit();

        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", date);
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.FIRED, snap.status);
        assertEquals(2.0, snap.amount, 0.0001);
    }

    @Test
    public void invalidFiredAmount_returnsFiredNull() {
        String date = "2026-09-11";
        AutoDeductionEventStore store = newEventStore();
        // Insert with invalid amount via direct prefs if insert rejects — use store path with 0
        AutoDeductionEventStore.InsertFiredResult r =
                store.insertFiredIfAbsent("med", "dose", date, 1_000L, 0.0);
        // May fail validation on insert; if so write raw FIRED row
        if (r.status != AutoDeductionEventStore.InsertFiredResult.Status.CREATED) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("medicationId", "med");
                obj.put("doseId", "dose");
                obj.put("calendarDate", date);
                obj.put("amount", 0.0);
                obj.put("status", AutoDeductionContract.STATUS_FIRED);
                obj.put("scheduledAtEpochMs", 1000L);
                obj.put("createdAtEpochMs", 1000L);
                String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
                Phase2TestSupport.eventPrefs().edit()
                        .putString(Phase2TestSupport.evtKey(key), obj.toString())
                        .commit();
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        }

        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", date);
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.FIRED, snap.status);
        assertNull(snap.amount);
    }

    @Test
    public void absentWhenNothing() {
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.OccurrenceSnapshot snap =
                s.getOccurrenceSnapshot("med", "dose", "2099-01-01");
        assertEquals(AutoDeductionScheduler.OccurrenceSnapshot.Status.ABSENT, snap.status);
    }
}
