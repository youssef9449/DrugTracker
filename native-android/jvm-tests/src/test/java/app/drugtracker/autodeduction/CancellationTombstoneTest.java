package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.CANCEL_PREFIX;
import static app.drugtracker.autodeduction.Phase2TestSupport.SCH_PREFIX;
import static app.drugtracker.autodeduction.Phase2TestSupport.appContext;
import static app.drugtracker.autodeduction.Phase2TestSupport.cancelKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.cancelPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
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
 * Real {@link AutoDeductionScheduler} cancellation / effective-cancellation behavior
 * against durable SharedPreferences (Robolectric).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CancellationTombstoneTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    @Test
    public void noTombstoneNoMetadata_isActive() {
        AutoDeductionScheduler s = newScheduler();
        assertFalse(s.isOccurrenceCancelled("med", "dose", "2026-09-14"));
        assertFalse(s.isOccurrenceCancelledKey(
                AutoDeductionContract.occurrenceKey("med", "dose", "2026-09-14")));
    }

    @Test
    public void cancelOccurrence_writesTombstoneRemovesMetadata() {
        String date = futureCalendarDate(3);
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.ScheduleResult scheduled = s.scheduleOccurrence(
                "med", "dose", date, "10:00", 1.0, futureEpochMs(date, "10:00"));
        assertTrue(scheduled.ok);

        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        assertTrue(schedulePrefs().contains(schKey(key)));

        AutoDeductionScheduler.CancelResult cancel = s.cancelOccurrence("med", "dose", date);
        assertTrue(cancel.isOk());
        assertFalse(schedulePrefs().contains(schKey(key)));
        assertTrue(cancelPrefs().contains(cancelKey(key)));
        assertTrue(s.isOccurrenceCancelled("med", "dose", date));
        assertTrue(s.hasCancellationTombstone(key));
    }

    @Test
    public void cancelAbsent_stillDurableTombstone_effectivelyCancelled() {
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.CancelResult cancel =
                s.cancelOccurrence("med", "dose", "2030-01-15");
        assertTrue(cancel.isOk());
        assertTrue(s.isOccurrenceCancelled("med", "dose", "2030-01-15"));
    }

    @Test
    public void rescheduleAfterCancel_scheduleNewerThanCancel_becomesActive() {
        String date = futureCalendarDate(4);
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "09:00", 1.0, futureEpochMs(date, "09:00")).ok);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());
        assertTrue(s.isOccurrenceCancelled("med", "dose", date));

        // Legitimate reschedule installs newer operationVersion and clears/supersedes tombstone.
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "11:00", 2.0, futureEpochMs(date, "11:00")).ok);
        assertFalse(s.isOccurrenceCancelled("med", "dose", date));
    }

    @Test
    public void seededScheduleNewerThanCancel_active() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("m", "d", "2026-09-20");
        cancelPrefs().edit().putString(cancelKey(key), "1000-1-cancel").commit();
        JSONObject meta = new JSONObject();
        meta.put("operationVersion", "1000-2-sched");
        meta.put("amount", 1.0);
        schedulePrefs().edit().putString(schKey(key), meta.toString()).commit();

        AutoDeductionScheduler s = newScheduler();
        assertFalse(s.isOccurrenceCancelledKey(key));
    }

    @Test
    public void seededCancelNewerThanSchedule_cancelled() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("m", "d", "2026-09-21");
        cancelPrefs().edit().putString(cancelKey(key), "2000-1-cancel").commit();
        JSONObject meta = new JSONObject();
        meta.put("operationVersion", "1000-5-sched");
        schedulePrefs().edit().putString(schKey(key), meta.toString()).commit();

        assertTrue(newScheduler().isOccurrenceCancelledKey(key));
    }

    @Test
    public void sameMillisecond_seqOrdersCancelVsSchedule() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("m", "d", "2026-09-22");
        // cancel seq 2, schedule seq 1 → cancelled
        cancelPrefs().edit().putString(cancelKey(key), "5000-2-c").commit();
        JSONObject older = new JSONObject();
        older.put("operationVersion", "5000-1-s");
        schedulePrefs().edit().putString(schKey(key), older.toString()).commit();
        assertTrue(newScheduler().isOccurrenceCancelledKey(key));

        // schedule seq 3 supersedes cancel seq 2 → active
        JSONObject newer = new JSONObject();
        newer.put("operationVersion", "5000-3-s");
        schedulePrefs().edit().putString(schKey(key), newer.toString()).commit();
        assertFalse(newScheduler().isOccurrenceCancelledKey(key));
    }

    @Test
    public void operationVersionIsUsedForOrderingAndLegacyIsRejected() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("m", "d", "2026-09-25");
        cancelPrefs().edit().putString(cancelKey(key), "5000-2-c").commit();
        JSONObject meta = new JSONObject();
        meta.put("operationVersion", "5000-3-s");
        schedulePrefs().edit().putString(schKey(key), meta.toString()).commit();
        assertFalse(newScheduler().isOccurrenceCancelledKey(key));
    }

    @Test
    public void malformedOrdering_withTombstone_failSafeCancelled() throws Exception {
        String key = AutoDeductionContract.occurrenceKey("m", "d", "2026-09-24");
        cancelPrefs().edit().putString(cancelKey(key), "not-a-token").commit();
        JSONObject meta = new JSONObject();
        meta.put("scheduleVersion", "1000-1-u");
        schedulePrefs().edit().putString(schKey(key), meta.toString()).commit();
        assertTrue(newScheduler().isOccurrenceCancelledKey(key));

        cancelPrefs().edit().putString(cancelKey(key), "1000-1-u").commit();
        schedulePrefs().edit().putString(schKey(key), "{bad").commit();
        assertTrue(newScheduler().isOccurrenceCancelledKey(key));
    }
}