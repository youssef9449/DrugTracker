package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.appContext;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.evtKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.eventPrefs;
import static app.drugtracker.autodeduction.Phase2TestSupport.schKey;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
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
public class CancellationReliabilityTest extends Group2AutoReliabilityFixture {

    @Test
    public void rollbackCompensation_recoversPastOccurrenceThroughNativeCatchUp()
            throws Exception {
        String med = "med-409";
        String dose = "dose-409";
        String date = localDateOffset(-2);
        String time = "08:00";
        long generation = 2L;
        seedGeneration(med, dose, generation);

        String key = occurrenceKey(med, dose, date);
        appContext()
                .getSharedPreferences(
                        AutoDeductionContract.PREFS_CANCELLED, 0)
                .edit()
                .putString(
                        "cancel:" + key,
                        "{\"operationVersion\":\"v-cancel\"}")
                .commit();

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 50.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.FireResult result =
                scheduler.recoverMissedOccurrenceForCompensation(
                        med, dose, date, epoch(date, time), 3.0, generation, "", time);

        assertTrue(result.allowsRecurrence());
        assertFalse("compensation must not remain cancelled", scheduler.isOccurrenceCancelled(med, dose, date));
        assertTrue(eventPrefs().contains(evtKey(key)));
        assertEquals(47.0, stock.readAll().stocks.get(med), 0.001);
        assertNotNull(
                scheduler.successorObligationStore().get(med, dose, date));
    }

    @Test
    public void partialCancellationFailure_restoresAllCanceledSchedulesBeforeReportingFailure()
            throws Exception {
        String med = "med-409-partial";
        String dose = "dose-409-partial";
        String date1 = localDateOffset(2);
        String date2 = localDateOffset(3);
        String time = "10:00";
        double amount = 1.0;

        AutoDeductionScheduler setup = Phase2TestSupport.newScheduler();
        assertTrue(setup.scheduleOccurrence(
                med, dose, date1, time, amount, epoch(date1, time)).ok);
        assertTrue(setup.scheduleOccurrence(
                med, dose, date2, time, amount, epoch(date2, time)).ok);

        String key1 = occurrenceKey(med, dose, date1);
        String key2 = occurrenceKey(med, dose, date2);
        long oldGeneration = Phase2TestSupport.readAuthGeneration(med, dose);
        assertTrue(schedulePrefs().contains(schKey(key1)));
        assertTrue(schedulePrefs().contains(schKey(key2)));

        AutoDeductionScheduler failing = Phase2TestSupport.newScheduler(
                Phase2TestSupport.failScheduleMetadataRemovalAfter(1));
        AutoDeductionScheduler.InvalidateResult result =
                failing.invalidateRecurrenceAuthorization(med, dose);

        assertFalse("partial cancellation must fail invalidation",
                result.ok);
        assertFalse("rollback success means compensation metadata is unnecessary",
                result.schedulesCancelled);
        assertEquals("generation must remain the old authorized generation",
                oldGeneration,
                Phase2TestSupport.readAuthGeneration(med, dose));
        assertTrue("first canceled schedule must be restored",
                schedulePrefs().contains(schKey(key1)));
        assertTrue("second partially-canceled schedule must be restored",
                schedulePrefs().contains(schKey(key2)));
    }

    @Test
    public void invalidationCancellationFailure_leavesGenerationAndScheduleUsable()
            throws Exception {
        String med = "med-408-cancel-failure";
        String dose = "dose-408-cancel-failure";
        String date = localDateOffset(2);
        String time = "10:00";
        double amount = 1.0;

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, date, time, amount, epoch(date, time)).ok);

        long oldGeneration = Phase2TestSupport.readAuthGeneration(med, dose);
        assertTrue(oldGeneration > 0L);
        String key = occurrenceKey(med, dose, date);
        assertTrue(schedulePrefs().contains(schKey(key)));

        AutoDeductionFailurePolicy failCancellation =
                new AutoDeductionFailurePolicy() {
                    @Override
                    public boolean allowTombstoneCommit() {
                        return false;
                    }
                };
        AutoDeductionScheduler failing =
                Phase2TestSupport.newScheduler(failCancellation);

        AutoDeductionScheduler.InvalidateResult invalidation =
                failing.invalidateRecurrenceAuthorization(med, dose);
        assertFalse("failed cancellation must not report invalidation success",
                invalidation.ok);
        assertEquals(
                "failed cancellation must leave the prior generation authorized",
                oldGeneration,
                Phase2TestSupport.readAuthGeneration(med, dose));
        assertTrue(
                "failed cancellation must leave the existing schedule untouched",
                schedulePrefs().contains(schKey(key)));

        AutoDeductionScheduler.RestoreResult restored =
                Phase2TestSupport.newScheduler().restoreFutureSchedules();
        assertTrue("a failed cancellation is safe to retry from the unchanged schedule",
                restored.ok);
        assertTrue(
                "unchanged generation must allow restore of the existing schedule",
                schedulePrefs().contains(schKey(key)));
    }

    @Test
    public void directHistoricalAutoStockApply_isRejectedWithoutRecoveryAuthority()
            throws Exception {
        String med = "med-410-direct-age";
        String dose = "dose-410-direct-age";
        String oldDate = localDateOffset(-40);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionStockStore.AutoApplyResult result =
                stock.applyAutoDeduction(
                        med, dose, oldDate, 2.0);
        assertFalse("direct historical apply must require explicit recovery authority",
                result.ok);
        assertEquals("stale_auto_occurrence", result.error);
        assertEquals(100.0, stock.readAll().stocks.get(med), 0.001);

        assertTrue("explicit recovery authority may process the historical FIRED occurrence",
                stock.applyAutoDeductionForRecovery(
                        med, dose, oldDate, 2.0).ok);
        assertEquals(98.0, stock.readAll().stocks.get(med), 0.001);
    }
}
