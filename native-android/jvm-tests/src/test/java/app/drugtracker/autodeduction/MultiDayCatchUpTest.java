package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.appContext;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
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

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Issue #243 — multi-day missed-dose catch-up (deterministic). */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class MultiDayCatchUpTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    private static long epoch(String date, String time) {
        Long e = AutoDeductionScheduler.computeEpochMs(date, time);
        assertTrue(e != null);
        return e;
    }

    private static boolean hasFired(String med, String dose, String date) {
        return eventPrefs().contains(
                evtKey(AutoDeductionContract.occurrenceKey(med, dose, date)));
    }

    private static boolean hasSchedule(String med, String dose, String date) {
        return schedulePrefs().contains(
                schKey(AutoDeductionContract.occurrenceKey(med, dose, date)));
    }

    private static void seedGen(String med, String dose, long gen) {
        SharedPreferences auth = appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0);
        auth.edit().putLong(
                AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                        + AutoDeductionContract.scheduleIdentityKey(med, dose),
                gen).commit();
    }

    private static String putPastSnapshot(
            String med, String dose, String date, String time, double amount, long gen
    ) throws Exception {
        String key = AutoDeductionContract.occurrenceKey(med, dose, date);
        String prefKey = schKey(key);
        String version = "test-v-" + date + "-" + dose;
        JSONObject o = new JSONObject();
        o.put("medicationId", med);
        o.put("doseId", dose);
        o.put("calendarDate", date);
        o.put("timeHhmm", time);
        o.put("amount", amount);
        o.put("scheduledAtEpochMs", epoch(date, time));
        o.put("scheduleVersion", version);
        o.put("recurrenceGeneration", gen);
        schedulePrefs().edit().putString(prefKey, o.toString()).commit();
        seedGen(med, dose, gen);
        return version;
    }

    @Test
    public void multiDayGap_recoversAllDue_thenOnlyFirstFuture() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-gap";
        String dose = "d1";
        String time = "08:00";
        // Logical now = 2026-09-30 12:00
        long now = epoch("2026-09-30", "12:00");
        s.recoveryNowOverrideForTest = now;

        String start = "2026-09-01";
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, time, 1.0, gen);

        AutoDeductionScheduler.CatchUpResult r = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, time, 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, dose, start)), ver);

        // 09-01 .. 09-30 inclusive at 08:00 are due at 12:00 → 30 FIRED
        assertEquals(30, r.firedCreated);
        assertTrue(r.futureInstalled);
        assertTrue(hasFired(med, dose, "2026-09-01"));
        assertTrue(hasFired(med, dose, "2026-09-15"));
        assertTrue(hasFired(med, dose, "2026-09-30"));
        // Next future = 2026-10-01 08:00
        assertTrue(hasSchedule(med, dose, "2026-10-01"));
        assertFalse(hasFired(med, dose, "2026-10-01"));
        assertFalse(hasSchedule(med, dose, "2026-10-02"));
        assertFalse(hasSchedule(med, dose, start));
    }

    @Test
    public void currentDayBoundary_beforeAndExactMinute() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-day";
        long gen = 1L;

        // Recovery at 12:00: 08:00 FIRED, 14:00 future only
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String ver8 = putPastSnapshot(med, "A", "2026-09-30", "08:00", 1.0, gen);
        s.catchUpMissedOccurrencesAndScheduleNext(
                med, "A", "2026-09-30", "08:00", 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, "A", "2026-09-30")), ver8);
        assertTrue(hasFired(med, "A", "2026-09-30"));
        assertTrue(hasSchedule(med, "A", "2026-10-01"));

        clearAllDurableState();
        s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        seedGen(med, "B", gen);
        String ver14 = putPastSnapshot(med, "B", "2026-09-30", "14:00", 2.0, gen);
        s.catchUpMissedOccurrencesAndScheduleNext(
                med, "B", "2026-09-30", "14:00", 2.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, "B", "2026-09-30")), ver14);
        assertFalse(hasFired(med, "B", "2026-09-30"));
        assertTrue(hasSchedule(med, "B", "2026-09-30"));

        // Exact minute 14:00 → due / FIRED
        clearAllDurableState();
        s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "14:00");
        seedGen(med, "B", gen);
        ver14 = putPastSnapshot(med, "B", "2026-09-30", "14:00", 2.0, gen);
        s.catchUpMissedOccurrencesAndScheduleNext(
                med, "B", "2026-09-30", "14:00", 2.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, "B", "2026-09-30")), ver14);
        assertTrue(hasFired(med, "B", "2026-09-30"));
        assertTrue(hasSchedule(med, "B", "2026-10-01"));
    }

    @Test
    public void multiDose_at1500_AandB_fired_C_future() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "15:00");
        String med = "med-multi";
        long gen = 1L;
        String day = "2026-09-30";
        String[] doses = {"A", "B", "C"};
        String[] times = {"08:00", "14:00", "20:00"};
        double[] amounts = {1.0, 2.0, 3.0};

        for (int i = 0; i < 3; i++) {
            String ver = putPastSnapshot(med, doses[i], day, times[i], amounts[i], gen);
            s.catchUpMissedOccurrencesAndScheduleNext(
                    med, doses[i], day, times[i], amounts[i], gen,
                    schKey(AutoDeductionContract.occurrenceKey(med, doses[i], day)), ver);
        }

        assertTrue(hasFired(med, "A", day));
        assertTrue(hasFired(med, "B", day));
        assertFalse(hasFired(med, "C", day));
        assertTrue(hasSchedule(med, "C", day));

        assertEquals(1.0, new JSONObject(eventPrefs().getString(
                evtKey(AutoDeductionContract.occurrenceKey(med, "A", day)), "{}"))
                .getDouble("amount"), 0.001);
        assertEquals(2.0, new JSONObject(eventPrefs().getString(
                evtKey(AutoDeductionContract.occurrenceKey(med, "B", day)), "{}"))
                .getDouble("amount"), 0.001);

        JSONObject cMeta = new JSONObject(schedulePrefs().getString(
                schKey(AutoDeductionContract.occurrenceKey(med, "C", day)), "{}"));
        assertEquals("C", cMeta.getString("doseId"));
        assertEquals(3.0, cMeta.getDouble("amount"), 0.001);
        assertEquals("20:00", cMeta.getString("timeHhmm"));
        assertEquals(day, cMeta.getString("calendarDate"));
    }

    @Test
    public void idempotentRerun_singleFiredPerDate() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String med = "med-idemp";
        String dose = "d1";
        String start = "2026-09-28";
        long gen = 1L;
        String prefKey = schKey(AutoDeductionContract.occurrenceKey(med, dose, start));
        String ver = putPastSnapshot(med, dose, start, "08:00", 1.0, gen);

        AutoDeductionScheduler.CatchUpResult first = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "08:00", 1.0, gen, prefKey, ver);
        assertEquals(3, first.firedCreated); // 28, 29, 30
        assertTrue(first.futureInstalled);
        assertTrue(hasFired(med, dose, "2026-09-28"));
        assertTrue(hasSchedule(med, dose, "2026-10-01"));

        putPastSnapshot(med, dose, start, "08:00", 1.0, gen);
        AutoDeductionScheduler.CatchUpResult second = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "08:00", 1.0, gen, prefKey, ver);
        assertEquals(0, second.firedCreated); // all ALREADY_EXISTS
        assertTrue(hasFired(med, dose, "2026-09-28"));
        assertTrue(hasSchedule(med, dose, "2026-10-01"));
    }

    @Test
    public void expectedGenZero_activePositive_noFired() {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String med = "med-z";
        String dose = "d1";
        // Active generation already invalidated / promoted
        seedGen(med, dose, 2L);
        AutoDeductionScheduler.FireResult fr = s.recoverMissedOccurrence(
                med, dose, "2026-09-29", epoch("2026-09-29", "08:00"), 1.0, 0L);
        assertEquals(AutoDeductionScheduler.FireResult.Status.CANCELLED, fr.status);
        assertFalse(hasFired(med, dose, "2026-09-29"));
    }

    @Test
    public void generationRace_invalidateBeforeSuccessorInstall_noG2Successor()
            throws Exception {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String med = "med-race";
        String dose = "d1";
        String start = "2026-09-30"; // only today 08:00 due → next is 10-01
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, "08:00", 1.0, gen);

        CountDownLatch beforeInstall = new CountDownLatch(1);
        CountDownLatch resumeInstall = new CountDownLatch(1);
        s.recoveryBeforeSuccessorInstallLatchForTest = beforeInstall;
        s.recoveryResumeSuccessorInstallLatchForTest = resumeInstall;

        AtomicReference<Integer> created = new AtomicReference<>(-1);
        Thread recovery = new Thread(() -> {
            created.set(s.catchUpMissedOccurrencesAndScheduleNext(
                    med, dose, start, "08:00", 1.0, gen,
                    schKey(AutoDeductionContract.occurrenceKey(med, dose, start)), ver)
                    .firedCreated);
        });
        recovery.start();

        assertTrue(beforeInstall.await(3, TimeUnit.SECONDS));
        // Invalidate G1 → G2 while recovery is between outer probe and locked install
        assertTrue(s.invalidateRecurrenceAuthorization(med, dose).ok);
        resumeInstall.countDown();
        recovery.join(5000);

        assertTrue(hasFired(med, dose, start)); // due day still recovered under G1
        // Must not install future under G2 as continuation of G1 recovery
        assertFalse(hasSchedule(med, dose, "2026-10-01"));
    }

    @Test
    public void recoveryInstallsUnderG1_thenInvalidate_existingSemantics() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String med = "med-ok";
        String dose = "d1";
        String start = "2026-09-30";
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, "08:00", 1.0, gen);

        AutoDeductionScheduler.CatchUpResult n = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "08:00", 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, dose, start)), ver);
        assertEquals(1, n.firedCreated);
        assertTrue(n.futureInstalled);
        assertTrue(hasSchedule(med, dose, "2026-10-01"));
        JSONObject successor = new JSONObject(schedulePrefs().getString(
                schKey(AutoDeductionContract.occurrenceKey(med, dose, "2026-10-01")), "{}"));
        assertTrue(successor.has("operationVersion"));
        assertFalse(successor.has("recurrenceGeneration"));
        SharedPreferences auth = appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0);
        assertEquals(
                1L,
                auth.getLong(
                        AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                                + AutoDeductionContract.scheduleIdentityKey(med, dose),
                        0L));

        assertTrue(s.invalidateRecurrenceAuthorization(med, dose).ok);
        // Existing invalidate cancels futures for the dose
        assertFalse(hasSchedule(med, dose, "2026-10-01"));
    }

    @Test
    public void cancelledFutureSuccessor_notResurrectedByCatchUp() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String med = "med-canc-fut";
        String dose = "d1";
        String start = "2026-09-30"; // due at 08:00; first future = 2026-10-01
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, "08:00", 1.0, gen);

        // Cancel the future successor before recovery installs it.
        assertTrue(s.cancelOccurrence(med, dose, "2026-10-01").isOk());
        assertTrue(s.isOccurrenceCancelled(med, dose, "2026-10-01"));

        AutoDeductionScheduler.CatchUpResult r = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "08:00", 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, dose, start)), ver);

        assertEquals(1, r.firedCreated);
        assertFalse(r.futureInstalled);
        assertTrue(hasFired(med, dose, start));
        assertFalse(hasSchedule(med, dose, "2026-10-01"));
        assertTrue(s.isOccurrenceCancelled(med, dose, "2026-10-01"));
    }

    @Test
    public void restoreFutureSchedules_countsFutureAlarmsNotFiredRows() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        s.recoveryNowOverrideForTest = epoch("2026-09-30", "12:00");
        String med = "med-count";
        String dose = "d1";
        String start = "2026-09-28";
        long gen = 1L;
        putPastSnapshot(med, dose, start, "08:00", 1.0, gen);

        AutoDeductionScheduler.RestoreResult rr = s.restoreFutureSchedules();
        int restored = rr.restored;
        org.junit.Assert.assertTrue(rr.ok);
        // 3 FIRED (28-30) but only 1 future alarm (2026-10-01)
        assertEquals(1, restored);
        assertTrue(hasFired(med, dose, "2026-09-28"));
        assertTrue(hasFired(med, dose, "2026-09-30"));
        assertTrue(hasSchedule(med, dose, "2026-10-01"));
    }
}
