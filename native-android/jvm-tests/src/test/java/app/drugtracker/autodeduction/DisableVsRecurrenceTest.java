package app.drugtracker.autodeduction;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Issue #217 — disable/cancel vs post-fire recurrence scheduling. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class DisableVsRecurrenceTest {

    private AutoDeductionScheduler scheduler;

    @Before
    public void setUp() {
        Phase2TestSupport.clearAllDurableState();
        scheduler = new AutoDeductionScheduler(Phase2TestSupport.appContext());
    }

    private static String futureDate(int days) {
        return Phase2TestSupport.futureCalendarDate(days);
    }

    private long readGen(String med, String dose) {
        SharedPreferences p = Phase2TestSupport.appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0);
        return p.getLong(
                AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                        + AutoDeductionContract.scheduleIdentityKey(med, dose),
                0L);
    }

    private boolean hasSchedule(String med, String dose, String date) {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        return Phase2TestSupport.schedulePrefs().contains(Phase2TestSupport.schKey(key));
    }

    private long genFromScheduleMeta(String med, String dose, String date) throws Exception {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        String raw = Phase2TestSupport.schedulePrefs().getString(
                Phase2TestSupport.schKey(key), null);
        if (raw == null) return -1L;
        return new JSONObject(raw).optLong("recurrenceGeneration", 0L);
    }

    @Test
    public void caseA_fireThenDisableThenRecurrence_doesNotCreateSuccessor() throws Exception {
        String med = "med-a";
        String dose = "d1";
        String d = futureDate(2);
        String time = "10:00";
        double amount = 1.0;

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, amount, 0L).ok);
        long gen = genFromScheduleMeta(med, dose, d);
        assertTrue(gen > 0L);

        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(med, dose, d, System.currentTimeMillis(), amount);
        assertTrue(fr.allowsRecurrence());

        scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertTrue(readGen(med, dose) > gen);

        AutoDeductionScheduler.ScheduleResult next =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, amount, gen);
        assertFalse(next.ok);
        assertEquals("recurrence_authorization_invalid", next.error);
    }

    @Test
    public void caseB_successorThenDisable_cancelsAndRestoreDoesNotResurrect() throws Exception {
        String med = "med-b";
        String dose = "d1";
        String d = futureDate(2);
        String time = "11:00";
        double amount = 2.0;

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, amount, 0L).ok);
        long gen = genFromScheduleMeta(med, dose, d);

        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(med, dose, d, System.currentTimeMillis(), amount);
        assertTrue(fr.allowsRecurrence());

        AutoDeductionScheduler.ScheduleResult next =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, amount, gen);
        assertTrue(next.ok);

        String d1Date = null;
        for (String k : Phase2TestSupport.schedulePrefs().getAll().keySet()) {
            if (!k.startsWith(Phase2TestSupport.SCH_PREFIX)) continue;
            JSONObject o = new JSONObject(
                    Phase2TestSupport.schedulePrefs().getString(k, "{}"));
            if (med.equals(o.optString("medicationId"))
                    && dose.equals(o.optString("doseId"))
                    && !d.equals(o.optString("calendarDate"))) {
                d1Date = o.optString("calendarDate");
            }
        }
        assertTrue(d1Date != null && !d1Date.isEmpty());
        assertTrue(hasSchedule(med, dose, d1Date));

        scheduler.invalidateRecurrenceAuthorization(med, dose);
        assertFalse(hasSchedule(med, dose, d1Date));

        scheduler.restoreFutureSchedules();
        assertFalse(hasSchedule(med, dose, d1Date));
    }

    @Test
    public void caseC_disableBeforeRecurrence_noSuccessor() throws Exception {
        String med = "med-c";
        String dose = "d1";
        String d = futureDate(3);
        String time = "09:00";

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, time, 1.0, 0L).ok);
        long gen = genFromScheduleMeta(med, dose, d);

        scheduler.invalidateRecurrenceAuthorization(med, dose);

        AutoDeductionScheduler.ScheduleResult next =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d, time, 1.0, gen);
        assertFalse(next.ok);
        assertEquals("recurrence_authorization_invalid", next.error);
    }

    @Test
    public void caseD_occurrenceCancel_stillBlocksFire() {
        String med = "med-d";
        String dose = "d1";
        String d = futureDate(2);

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, "08:00", 1.0, 0L).ok);
        assertTrue(scheduler.cancelOccurrence(med, dose, d).isOk());

        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(med, dose, d, System.currentTimeMillis(), 1.0);
        assertTrue(fr.isCancelled());
    }

    @Test
    public void caseE_staleGeneration_cannotCreateSuccessor() throws Exception {
        String med = "med-e";
        String dose = "d1";
        String d = futureDate(2);

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, "12:00", 1.0, 0L).ok);
        long oldGen = genFromScheduleMeta(med, dose, d);

        scheduler.invalidateRecurrenceAuthorization(med, dose);
        String d2 = futureDate(3);
        assertTrue(scheduler.scheduleOccurrence(med, dose, d2, "12:00", 1.0, 0L).ok);
        long newGen = genFromScheduleMeta(med, dose, d2);
        assertTrue(newGen > oldGen);

        AutoDeductionScheduler.ScheduleResult stale =
                scheduler.scheduleNextOccurrenceIfAbsent(med, dose, d2, "12:00", 1.0, oldGen);
        assertFalse(stale.ok);
        assertEquals("recurrence_authorization_invalid", stale.error);
    }

    @Test
    public void caseF_cancelWins_noFired() {
        String med = "med-f";
        String dose = "d1";
        String d = futureDate(2);

        assertTrue(scheduler.scheduleOccurrence(med, dose, d, "13:00", 1.0, 0L).ok);
        assertTrue(scheduler.cancelOccurrence(med, dose, d).isOk());
        AutoDeductionScheduler.FireResult fr =
                scheduler.fireOccurrenceIfNotCancelled(med, dose, d, System.currentTimeMillis(), 1.0);
        assertTrue(fr.isCancelled());
        assertFalse(fr.allowsRecurrence());
    }
}
