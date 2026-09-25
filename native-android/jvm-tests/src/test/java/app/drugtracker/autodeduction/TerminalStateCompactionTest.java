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
public class TerminalStateCompactionTest extends Group2AutoReliabilityFixture {

    @Test
    public void terminalStateCompaction_commitFailure_isReportedAndRetryable()
            throws Exception {
        String med = "med-410-failure";
        String dose = "dose-410-failure";
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

        AutoDeductionScheduler failing = AutoDeductionTestSupport.newScheduler(
                AutoDeductionTestSupport.denyTerminalCompactionCommit());
        assertFalse(failing.compactTerminalState());
        assertTrue("failed compaction must leave terminal event retryable",
                eventPrefs().contains(evtKey(key)));
        assertTrue("failed compaction must leave terminal marker retryable",
                appContext().getSharedPreferences(
                        "drugtracker_auto_stock_v1", 0)
                        .contains("auto:" + key));

        AutoDeductionScheduler succeeding = AutoDeductionTestSupport.newScheduler();
        assertTrue(succeeding.compactTerminalState());
        assertFalse(eventPrefs().contains(evtKey(key)));
        assertFalse(appContext().getSharedPreferences(
                "drugtracker_auto_stock_v1", 0)
                .contains("auto:" + key));
    }

    @Test
    public void terminalStateCompaction_retainsUnresolvedFireRetryEvidence()
            throws Exception {
        String med = "med-410-retry";
        String dose = "dose-410-retry";
        String date = localDateOffset(-10);
        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();

        synchronized (AutoDeductionScheduler.class) {
            assertTrue(scheduler.recordIndependentFireRetryEvidenceLocked(
                    med,
                    dose,
                    date,
                    epoch(date, "08:00"),
                    2.0,
                    "08:00",
                    "",
                    1L,
                    "retry-v1",
                    1));
        }

        assertTrue(scheduler.compactTerminalState());
        assertNotNull("unresolved retry evidence must survive terminal compaction",
                scheduler.getIndependentFireRetryEvidence(med, dose, date));
        assertEquals(1,
                scheduler.getIndependentFireRetryEvidence(med, dose, date).retryCount);
    }

    @Test
    public void terminalStateCompaction_firedRecoveryState_isNeverCompacted()
            throws Exception {
        String med = "med-410-fired";
        String dose = "dose-410-fired";
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

        assertTrue(AutoDeductionTestSupport.newScheduler().compactTerminalState());
        assertTrue("unreconciled FIRED event is recovery state, not terminal history",
                eventPrefs().contains(evtKey(key)));
        assertTrue("active Auto marker must remain while FIRED is unresolved",
                appContext().getSharedPreferences(
                        "drugtracker_auto_stock_v1", 0)
                        .contains("auto:" + key));

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        AutoDeductionScheduler.RestoreResult recovered =
                scheduler.recoverFiredStockPass();
        assertTrue(recovered.ok);
        assertEquals(18.0, stock.readAll().stocks.get(med), 0.001);
    }

    @Test
    public void terminalStateCompaction_retainsRecentMarkers_butCompactsOlderTerminalState()
            throws Exception {
        String med = "med-410-retention";
        String dose = "dose-410-retention";
        String recentDate = localDateOffset(-AutoDeductionContract.TERMINAL_OCCURRENCE_MAX_AGE_DAYS);
        String oldDate = localDateOffset(-AutoDeductionContract.TERMINAL_OCCURRENCE_MAX_AGE_DAYS - 1);
        String time = "08:00";
        String recentKey = occurrenceKey(med, dose, recentDate);
        String oldKey = occurrenceKey(med, dose, oldDate);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);

        AutoDeductionEventStore events = new AutoDeductionEventStore(appContext());
        assertTrue(events.insertFiredIfAbsent(
                med, dose, recentDate, epoch(recentDate, time), 1.0).isCreated());
        assertTrue(stock.applyAutoDeduction(med, dose, recentDate, 1.0).ok);
        assertTrue(events.markReconciled(med, dose, recentDate).ok);

        assertTrue(events.insertFiredIfAbsent(
                med, dose, oldDate, epoch(oldDate, time), 1.0).isCreated());
        assertTrue(stock.applyAutoDeduction(med, dose, oldDate, 1.0).ok);
        assertTrue(events.markReconciled(med, dose, oldDate).ok);

        SharedPreferences stockPrefs =
                appContext().getSharedPreferences("drugtracker_auto_stock_v1", 0);
        String recentMarker = "auto:" + recentKey;
        String oldMarker = "auto:" + oldKey;
        assertTrue(stockPrefs.contains(recentMarker));
        assertTrue(stockPrefs.contains(oldMarker));
        assertTrue(eventPrefs().contains(evtKey(recentKey)));
        assertTrue(eventPrefs().contains(evtKey(oldKey)));

        assertTrue(AutoDeductionTestSupport.newScheduler().compactTerminalState());

        assertTrue("occurrence at max configured age must remain idempotent-safe",
                stockPrefs.contains(recentMarker));
        assertTrue("event at max configured age must remain retained",
                eventPrefs().contains(evtKey(recentKey)));
        assertFalse("older terminal occurrence marker must be compacted",
                stockPrefs.contains(oldMarker));
        assertFalse("older terminal event must be compacted",
                eventPrefs().contains(evtKey(oldKey)));
    }

    @Test
    public void terminalStateCompaction_removesOldReconciledOccurrenceState()
            throws Exception {
        String med = "med-410";
        String dose = "dose-410";
        String date = localDateOffset(-10);
        String time = "08:00";
        String key = occurrenceKey(med, dose, date);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);

        AutoDeductionEventStore events = new AutoDeductionEventStore(appContext());
        assertTrue(events.insertFiredIfAbsent(
                med, dose, date, epoch(date, time), 2.0).isCreated());
        assertTrue(stock.applyAutoDeduction(
                med, dose, date, 2.0).ok);
        assertTrue(events.markReconciled(med, dose, date).ok);

        SharedPreferences stockPrefs =
                appContext().getSharedPreferences("drugtracker_auto_stock_v1", 0);
        String markerKey = "auto:" + key;
        assertTrue(stockPrefs.contains(markerKey));
        assertTrue(eventPrefs().contains(evtKey(key)));

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        assertTrue(scheduler.compactTerminalState());

        assertFalse("old RECONCILED event should be compacted",
                eventPrefs().contains(evtKey(key)));
        assertFalse("old terminal stock marker should be compacted",
                stockPrefs.contains(markerKey));
    }

    @Test
    public void terminalStateCompaction_keepsMarkerForUnresolvedSuccessorObligation()
            throws Exception {
        String med = "med-410-obligation";
        String dose = "dose-410-obligation";
        String date = localDateOffset(-10);
        String key = occurrenceKey(med, dose, date);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);
        assertTrue(stock.applyAutoDeduction(med, dose, date, 2.0).ok);

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        assertTrue(scheduler.persistSuccessorObligation(
                med, dose, date, "08:00", 2.0, "", "v410-obligation", 1L));
        assertTrue(scheduler.compactTerminalState());

        assertTrue("unresolved successor work must keep the idempotency marker",
                appContext().getSharedPreferences(
                        "drugtracker_auto_stock_v1", 0)
                        .contains("auto:" + key));
        assertNotNull(scheduler.successorObligationStore().get(
                med, dose, date));
    }

    @Test
    public void terminalStateCompaction_removesOldForegroundResolutionMarkers()
            throws Exception {
        String med = "med-410-foreground";
        String dose = "dose-410-foreground";
        String date = localDateOffset(-10);
        String key = occurrenceKey(med, dose, date);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);
        assertTrue(stock.applyForegroundDeltas(
                1L,
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockDelta(med, 0.0)),
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.OccurrenceResolution(
                                med,
                                dose,
                                date,
                                AutoDeductionStockStore.OccurrenceResolution.Type.CONSUMED)))
                .ok);

        SharedPreferences stockPrefs =
                appContext().getSharedPreferences("drugtracker_auto_stock_v1", 0);
        String markerKey = "foreground:" + med + "\u001f" + dose + "\u001f" + date;
        assertTrue(stockPrefs.contains(markerKey));

        assertTrue(AutoDeductionTestSupport.newScheduler().compactTerminalState());
        assertFalse(stockPrefs.contains(markerKey));
        assertFalse(eventPrefs().contains(evtKey(key)));
    }

    @Test
    public void oldRejectedEvent_isCompactedAfterRetentionWindow() throws Exception {
        String med = "med-410-rejected";
        String dose = "dose-410-rejected";
        String date = localDateOffset(-40);
        String key = evtKey(occurrenceKey(med, dose, date));
        JSONObject rejected = new JSONObject();
        rejected.put("status", AutoDeductionContract.STATUS_REJECTED);
        rejected.put(
                "rejectedAt",
                System.currentTimeMillis()
                        - (long) (AutoDeductionContract.REJECTED_TERMINAL_RETENTION_DAYS + 1)
                        * 24L * 60L * 60L * 1000L);
        rejected.put("rejectionReason", "invalid_record");
        rejected.put("storageKey", key);
        eventPrefs().edit().putString(key, rejected.toString()).commit();

        assertTrue(AutoDeductionTestSupport.newScheduler().compactTerminalState());
        assertFalse("old REJECTED terminal state must not remain forever",
                eventPrefs().contains(key));
    }
}
