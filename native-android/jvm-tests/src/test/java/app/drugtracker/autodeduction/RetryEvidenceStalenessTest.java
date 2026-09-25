package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.appContext;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.evtKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.eventPrefs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schKey;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class RetryEvidenceStalenessTest extends AutoReliabilityFixture {

    @Test
    public void staleRetryEvidence_afterScheduleReplacement_cannotMutateStock()
            throws Exception {
        String med = "med-retry-stale-replacement";
        String dose = "dose-retry-stale-replacement";
        String date = localDateOffset(-1);
        String time = "08:00";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, date, time, 2.0, "retry-old-version", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        synchronized (AutoDeductionScheduler.class) {
            assertTrue(scheduler.recordIndependentFireRetryEvidenceLocked(
                    med, dose, date, epoch(date, time), 2.0, time, "",
                    generation, "retry-old-version", 1));
        }

        // Replace the live schedule without changing the recurrence generation.
        // The retry evidence must still be rejected because its operationVersion
        // belongs to the obsolete schedule definition.
        putSchedule(med, dose, date, time, 3.0, "retry-new-version", generation);

        AutoDeductionScheduler.FireResult result =
                scheduler.recoverFireFromIndependentEvidence(med, dose, date);

        assertEquals(
                "stale retry evidence must not recover an obsolete occurrence",
                AutoDeductionScheduler.FireResult.Status.CANCELLED,
                result.status);
        assertFalse(eventPrefs().contains(evtKey(occurrenceKey(med, dose, date))));
        assertEquals(100.0, stock.readAll().stocks.get(med), 0.001);
        assertNull(
                "obsolete retry evidence should be retired after ownership loss",
                scheduler.getIndependentFireRetryEvidence(med, dose, date));
    }

    @Test
    public void staleRetryEvidence_afterRecurrenceDisable_cannotMutateStock()
            throws Exception {
        String med = "med-retry-stale-disable";
        String dose = "dose-retry-stale-disable";
        String date = localDateOffset(-1);
        String time = "09:00";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, date, time, 2.0, "retry-disable-version", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        synchronized (AutoDeductionScheduler.class) {
            assertTrue(scheduler.recordIndependentFireRetryEvidenceLocked(
                    med, dose, date, epoch(date, time), 2.0, time, "",
                    generation, "retry-disable-version", 1));
        }

        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);

        AutoDeductionScheduler.FireResult result =
                scheduler.recoverFireFromIndependentEvidence(med, dose, date);

        assertEquals(
                "retry evidence from a disabled generation must not recover an occurrence",
                AutoDeductionScheduler.FireResult.Status.CANCELLED,
                result.status);
        assertFalse(eventPrefs().contains(evtKey(occurrenceKey(med, dose, date))));
        assertEquals(100.0, stock.readAll().stocks.get(med), 0.001);
        assertNull(
                "disabled retry evidence should be retired after ownership loss",
                scheduler.getIndependentFireRetryEvidence(med, dose, date));
    }

    @Test
    public void compensationWithNewerGeneration_cannotResurrectOldOccurrence()
            throws Exception {
        String med = "med-409-stale";
        String dose = "dose-409-stale";
        String date = localDateOffset(-2);
        String key = occurrenceKey(med, dose, date);
        seedGeneration(med, dose, 2L);

        appContext()
                .getSharedPreferences(
                        AutoDeductionContract.PREFS_CANCELLED, 0)
                .edit()
                .putString("cancel:" + key, "newer")
                .commit();

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 50.0))).ok);

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        AutoDeductionScheduler.FireResult result =
                scheduler.recoverMissedOccurrenceForCompensation(
                        med, dose, date, epoch(date, "08:00"), 3.0, 1L, "", "08:00");

        assertEquals(
                AutoDeductionScheduler.FireResult.Status.CANCELLED,
                result.status);
        assertFalse(eventPrefs().contains(evtKey(key)));
        assertEquals(50.0, stock.readAll().stocks.get(med), 0.001);
    }

    @Test
    public void compactedOccurrence_replayedDeliveryCannotDoubleDeduct()
            throws Exception {
        String med = "med-410-replay";
        String dose = "dose-410-replay";
        String date = localDateOffset(-10);
        String key = occurrenceKey(med, dose, date);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);
        AutoDeductionEventStore events = new AutoDeductionEventStore(appContext());
        assertTrue(events.insertFiredIfAbsent(
                med, dose, date, epoch(date, "08:00"), 2.0).isCreated());
        assertTrue(stock.applyAutoDeduction(med, dose, date, 2.0).ok);
        assertTrue(events.markReconciled(med, dose, date).ok);
        assertTrue(AutoDeductionTestSupport.newScheduler().compactTerminalState());

        AutoDeductionScheduler replay = AutoDeductionTestSupport.newScheduler();
        AutoDeductionScheduler.FireResult result = replay.fireOccurrenceIfNotCancelled(
                med, dose, date, epoch(date, "08:00"), 2.0, "old-version", 1L);
        assertEquals(
                AutoDeductionScheduler.FireResult.Status.CANCELLED,
                result.status);
        assertEquals(18.0, stock.readAll().stocks.get(med), 0.001);
    }

    @Test
    public void invalidatedGeneration_preventsOverdueSuccessorCatchUp() throws Exception {
        String med = "med-411-cancel";
        String dose = "dose-411-cancel";
        String start = localDateOffset(-3);
        String time = "00:01";
        seedGeneration(med, dose, 1L);
        putSchedule(med, dose, start, time, 1.0, "v-cancel", 1L);

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);

        AutoDeductionScheduler.ScheduleResult result =
                scheduler.scheduleNextOccurrenceIfAbsent(
                        med, dose, start, time, 1.0, 1L);
        assertFalse(result.ok);
        assertFalse(eventPrefs().contains(
                evtKey(occurrenceKey(med, dose, AutoDeductionScheduler.nextCalendarDate(start)))));
    }

}