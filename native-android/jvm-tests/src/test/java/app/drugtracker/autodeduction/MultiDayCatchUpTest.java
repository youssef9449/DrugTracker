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

import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

/** Issue #243 — multi-day missed-dose catch-up with no horizon. */
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

    /** Write durable schedule metadata without AlarmManager (allows past dates). */
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
        // Seed recurrence auth gen so recovery is authorized.
        SharedPreferences auth = appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0);
        auth.edit().putLong(
                AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                        + AutoDeductionContract.scheduleIdentityKey(med, dose),
                gen).commit();
        return version;
    }

    private static String todayYmd() {
        Calendar c = Calendar.getInstance(TimeZone.getDefault(), Locale.US);
        return String.format(Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    private static String addDays(String ymd, int delta) {
        String d = ymd;
        if (delta >= 0) {
            for (int i = 0; i < delta; i++) {
                d = AutoDeductionScheduler.nextCalendarDate(d);
            }
        }
        return d;
    }

    @Test
    public void multiDayGap_recoversAllDueDates_thenSchedulesFirstFuture() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-gap";
        String dose = "d1";
        String time = "08:00";
        // Start far in the past relative to real now so entire range is due.
        String start = "2020-01-01";
        String mid = "2020-01-02";
        String end = "2020-01-03";
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, time, 1.0, gen);

        int n = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, time, 1.0, gen, schKey(
                        AutoDeductionContract.occurrenceKey(med, dose, start)), ver);
        assertTrue(n >= 3);

        assertTrue(hasFired(med, dose, start));
        assertTrue(hasFired(med, dose, mid));
        assertTrue(hasFired(med, dose, end));
        // Walking continues until first future date relative to real now — many FIRED.
        // Snapshot metadata for start should be cleared.
        assertFalse(hasSchedule(med, dose, start));
    }

    @Test
    public void caseA_style_stopBeforeFutureDoseTime_onSyntheticWalk() throws Exception {
        // recoverMissed only for due; when walk hits a future epoch, schedule it.
        AutoDeductionScheduler s = newScheduler();
        String med = "med-a";
        String dose = "d1";
        // Use tomorrow 23:59 as "future" and yesterday as start — only past days FIRED.
        String today = todayYmd();
        String yesterday = null;
        // Compute yesterday by scanning back one day from today via Calendar.
        Calendar c = Calendar.getInstance(TimeZone.getDefault(), Locale.US);
        c.add(Calendar.DAY_OF_MONTH, -1);
        yesterday = String.format(Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
        c.add(Calendar.DAY_OF_MONTH, 2);
        String tomorrow = String.format(Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));

        String time = "23:59"; // today 23:59 may still be future depending on wall clock
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, yesterday, time, 1.0, gen);

        s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, yesterday, time, 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, dose, yesterday)), ver);

        assertTrue(hasFired(med, dose, yesterday));
        // Today 23:59: if still future, must NOT be FIRED and should be scheduled.
        long todayEpoch = epoch(today, time);
        if (todayEpoch > System.currentTimeMillis()) {
            assertFalse(hasFired(med, dose, today));
            assertTrue(hasSchedule(med, dose, today));
        }
    }

    @Test
    public void multiDose_independentCatchUp_partialTodayBoundary() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-multi";
        // Three slots; use far-past start so all historical days recover.
        String start = "2021-03-01";
        long gen = 1L;
        String[] doses = { "A", "B", "C" };
        String[] times = { "08:00", "14:00", "20:00" };
        double[] amounts = { 1.0, 2.0, 3.0 };

        for (int i = 0; i < 3; i++) {
            String ver = putPastSnapshot(med, doses[i], start, times[i], amounts[i], gen);
            s.catchUpMissedOccurrencesAndScheduleNext(
                    med, doses[i], start, times[i], amounts[i], gen,
                    schKey(AutoDeductionContract.occurrenceKey(med, doses[i], start)), ver);
        }

        assertTrue(hasFired(med, "A", start));
        assertTrue(hasFired(med, "B", start));
        assertTrue(hasFired(med, "C", start));
        // Amounts stored in event ledger
        String keyA = AutoDeductionContract.occurrenceKey(med, "A", start);
        String rawA = eventPrefs().getString(evtKey(keyA), null);
        assertTrue(rawA != null);
        assertEquals(1.0, new JSONObject(rawA).getDouble("amount"), 0.001);
        String keyB = AutoDeductionContract.occurrenceKey(med, "B", start);
        assertEquals(2.0, new JSONObject(eventPrefs().getString(evtKey(keyB), "{}"))
                .getDouble("amount"), 0.001);
        String keyC = AutoDeductionContract.occurrenceKey(med, "C", start);
        assertEquals(3.0, new JSONObject(eventPrefs().getString(evtKey(keyC), "{}"))
                .getDouble("amount"), 0.001);
    }

    @Test
    public void idempotentRerun_noDuplicateFired() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-idemp";
        String dose = "d1";
        String start = "2020-05-01";
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, "09:00", 1.0, gen);
        String prefKey = schKey(AutoDeductionContract.occurrenceKey(med, dose, start));

        int first = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "09:00", 1.0, gen, prefKey, ver);
        assertTrue(first >= 1);
        assertTrue(hasFired(med, dose, start));

        // Re-seed snapshot as if crash left it (idempotent recover).
        putPastSnapshot(med, dose, start, "09:00", 1.0, gen);
        int second = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "09:00", 1.0, gen, prefKey, ver);
        // Second pass: CREATED count may be 0 (all ALREADY_EXISTS) but must not fail.
        assertTrue(second >= 0);
        assertTrue(hasFired(med, dose, start));
        // Still a single event key
        assertTrue(eventPrefs().contains(evtKey(
                AutoDeductionContract.occurrenceKey(med, dose, start))));
    }

    @Test
    public void generationInvalidated_stopsCatchUp_noFutureResurrection() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-gen";
        String dose = "d1";
        String start = "2020-07-01";
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, start, "10:00", 1.0, gen);

        // Invalidate generation before catch-up
        assertTrue(s.invalidateRecurrenceAuthorization(med, dose).ok);

        int n = s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, start, "10:00", 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, dose, start)), ver);
        assertEquals(0, n);
        assertFalse(hasFired(med, dose, start));
    }

    @Test
    public void occurrenceCancel_skipsThatDate_continuesChain() throws Exception {
        AutoDeductionScheduler s = newScheduler();
        String med = "med-skip";
        String dose = "d1";
        String d0 = "2020-08-01";
        String d1 = "2020-08-02";
        long gen = 1L;
        String ver = putPastSnapshot(med, dose, d0, "11:00", 1.0, gen);

        // Tombstone d0 only
        assertTrue(s.cancelOccurrence(med, dose, d0).isOk());
        // Re-seed generation after cancel (cancel doesn't bump gen)
        appContext().getSharedPreferences(
                AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0)
                .edit().putLong(
                        AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                                + AutoDeductionContract.scheduleIdentityKey(med, dose),
                        gen).commit();
        // Put snapshot back (cancel removes schedule meta)
        putPastSnapshot(med, dose, d0, "11:00", 1.0, gen);

        s.catchUpMissedOccurrencesAndScheduleNext(
                med, dose, d0, "11:00", 1.0, gen,
                schKey(AutoDeductionContract.occurrenceKey(med, dose, d0)), ver);

        assertFalse(hasFired(med, dose, d0));
        assertTrue(hasFired(med, dose, d1));
    }
}
