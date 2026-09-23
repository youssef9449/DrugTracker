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
public class Group2AutoReliabilityTest {

    @Before
    public void setUp() {
        clearAllDurableState();
    }

    private static String occurrenceKey(String med, String dose, String date) {
        return AutoDeductionContract.occurrenceKey(med, dose, date);
    }

    private static String localDateOffset(int days) {
        Calendar cal = Calendar.getInstance(TimeZone.getDefault(), Locale.US);
        cal.add(Calendar.DAY_OF_MONTH, days);
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(cal.getTime());
    }

    private static long epoch(String date, String time) {
        Long value = AutoDeductionScheduler.computeEpochMs(date, time);
        assertNotNull(value);
        return value;
    }

    private static void seedGeneration(String med, String dose, long generation) {
        appContext()
                .getSharedPreferences(
                        AutoDeductionContract.PREFS_RECURRENCE_AUTH,
                        0)
                .edit()
                .putLong(
                        AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                                + AutoDeductionContract.scheduleIdentityKey(med, dose),
                        generation)
                .commit();
    }

    private static void putSchedule(
            String med,
            String dose,
            String date,
            String time,
            double amount,
            String operationVersion,
            long generation) throws Exception {
        JSONObject row = new JSONObject();
        row.put("medicationId", med);
        row.put("doseId", dose);
        row.put("calendarDate", date);
        row.put("timeHhmm", time);
        row.put("amount", amount);
        row.put("scheduledAtEpochMs", epoch(date, time));
        row.put("operationVersion", operationVersion);
        row.put("recurrenceGeneration", generation);
        schedulePrefs()
                .edit()
                .putString(
                        schKey(occurrenceKey(med, dose, date)),
                        row.toString())
                .commit();
    }

    @Test
    public void firedWithoutSuccessorObligation_recoveryRebuildsJournalAndContinues()
            throws Exception {
        String med = "med-408";
        String dose = "dose-408";
        String date = localDateOffset(-1);
        String time = "23:59";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, date, time, 2.0, "v408", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        // Simulate the exact durable state left if process death happened after
        // FIRED was committed but before the dedicated successor journal write.
        AutoDeductionEventStore events = new AutoDeductionEventStore(appContext());
        assertTrue(events.insertFiredIfAbsent(
                med, dose, date, epoch(date, time), 2.0).isCreated());

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.RestoreResult stockRecovery =
                scheduler.recoverFiredStockPass();
        assertTrue(stockRecovery.ok);
        assertEquals(98.0, stock.readAll().stocks.get(med), 0.001);

        AutoDeductionPersistenceModels.SuccessorObligationRecord obligation =
                scheduler.successorObligationStore().get(med, dose, date);
        assertNotNull("FIRED recovery must rebuild the missing successor journal", obligation);
        assertTrue("recovery must record that stock is already durable",
                obligation.stockApplied);

        assertTrue("successor recovery must be idempotent",
                scheduler.recoverSuccessorObligations());
        assertTrue(
                schedulePrefs().contains(
                        schKey(occurrenceKey(med, dose, localDateOffset(1)))));
        assertEquals("successor recovery must not deduct the same occurrence twice",
                98.0,
                stock.readAll().stocks.get(med),
                0.001);
    }

    @Test
    public void liveFireCompletesBeforeReceiverSuccessorStep_hasDurableObligationForRestart()
            throws Exception {
        String med = "med-408-live-window";
        String dose = "dose-408-live-window";
        String date = localDateOffset(-1);
        String time = "23:59";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, date, time, 2.0, "v408-live", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.FireResult fired =
                scheduler.fireOccurrenceIfNotCancelled(
                        med,
                        dose,
                        date,
                        epoch(date, time),
                        2.0,
                        "v408-live",
                        generation);

        assertTrue("completed fire must permit recurrence", fired.allowsRecurrence());
        assertEquals(98.0, stock.readAll().stocks.get(med), 0.001);
        assertNotNull(
                "successful native fire must durably record successor obligation before receiver continuation",
                scheduler.successorObligationStore().get(med, dose, date));

        // The receiver would normally schedule the next occurrence after this return.
        // Recreate the native scheduler instead to model process death in that window.
        AutoDeductionScheduler restarted = Phase2TestSupport.newScheduler();
        assertTrue(restarted.recoverSuccessorObligations());

        assertTrue(
                schedulePrefs().contains(
                        schKey(occurrenceKey(med, dose, localDateOffset(0)))));
        assertNull(
                restarted.successorObligationStore().get(med, dose, date));
        assertEquals(
                "restart recovery must not repeat the completed fire",
                98.0,
                stock.readAll().stocks.get(med),
                0.001);
    }

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

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        synchronized (scheduler.scheduleLock()) {
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

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        synchronized (scheduler.scheduleLock()) {
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

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
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
    public void successorPartiallyInstalled_beforeProcessDeath_recoveryFinishesWithoutDoubleDeduction()
            throws Exception {
        String med = "med-408-partial";
        String dose = "dose-408-partial";
        String sourceDate = localDateOffset(0);
        String successorDate = localDateOffset(1);
        String time = "23:59";
        long generation = 1L;
        seedGeneration(med, dose, generation);

        putSchedule(med, dose, sourceDate, time, 2.0, "v408-partial", generation);
        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 50.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        assertTrue(scheduler.scheduleOccurrence(
                med, dose, successorDate, time, 2.0,
                epoch(successorDate, time)).ok);
        assertTrue(scheduler.persistSuccessorObligation(
                med, dose, sourceDate, time, 2.0, "", "v408-partial", generation));
        assertFalse(scheduler.successorObligationStore().get(
                med, dose, sourceDate).stockApplied);

        assertTrue(scheduler.recoverSuccessorObligations());
        assertEquals(48.0, stock.readAll().stocks.get(med), 0.001);
        assertTrue(schedulePrefs().contains(
                schKey(occurrenceKey(med, dose, successorDate))));
        assertNull(scheduler.successorObligationStore().get(
                med, dose, sourceDate));

        assertTrue(scheduler.recoverSuccessorObligations());
        assertEquals(48.0, stock.readAll().stocks.get(med), 0.001);
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
    public void disabledGeneration_discardsStaleSuccessorObligationWithoutStockMutation()
            throws Exception {
        String med = "med-408-disabled";
        String dose = "dose-408-disabled";
        String sourceDate = localDateOffset(0);
        String successorDate = localDateOffset(1);
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, sourceDate, "23:59", 2.0, "v408-disabled", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 30.0))).ok);
        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        assertTrue(scheduler.persistSuccessorObligation(
                med, dose, sourceDate, "23:59", 2.0, "", "v408-disabled", generation));
        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);

        assertTrue(scheduler.recoverSuccessorObligations());
        assertNull("stale obligation must be retired after disable",
                scheduler.successorObligationStore().get(med, dose, sourceDate));
        assertFalse("disabled chain must not resurrect successor",
                schedulePrefs().contains(schKey(occurrenceKey(med, dose, successorDate))));
        assertEquals("discarded obligation must not mutate Native stock",
                30.0, stock.readAll().stocks.get(med), 0.001);
    }

    @Test
    public void replacedSchedule_discardsObsoleteSuccessorObligationWithoutResurrection()
            throws Exception {
        String med = "med-408-replaced";
        String dose = "dose-408-replaced";
        String sourceDate = localDateOffset(0);
        String successorDate = localDateOffset(1);
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, sourceDate, "23:59", 1.0, "v408-old", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 30.0))).ok);
        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        assertTrue(scheduler.persistSuccessorObligation(
                med, dose, sourceDate, "23:59", 1.0, "", "v408-old", generation));

        assertTrue(scheduler.scheduleOccurrence(
                med, dose, sourceDate, "23:59", 2.0,
                epoch(sourceDate, "23:59")).ok);
        assertTrue(scheduler.recoverSuccessorObligations());

        assertNull(scheduler.successorObligationStore().get(med, dose, sourceDate));
        assertFalse("obsolete obligation must not create a successor",
                schedulePrefs().contains(schKey(occurrenceKey(med, dose, successorDate))));
        assertEquals("stale obligation must not mutate stock",
                30.0, stock.readAll().stocks.get(med), 0.001);
    }

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

        AutoDeductionScheduler failing = Phase2TestSupport.newScheduler(
                Phase2TestSupport.denyTerminalCompactionCommit());
        assertFalse(failing.compactTerminalState());
        assertTrue("failed compaction must leave terminal event retryable",
                eventPrefs().contains(evtKey(key)));
        assertTrue("failed compaction must leave terminal marker retryable",
                appContext().getSharedPreferences(
                        "drugtracker_auto_stock_v1", 0)
                        .contains("auto:" + key));

        AutoDeductionScheduler succeeding = Phase2TestSupport.newScheduler();
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
        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();

        synchronized (scheduler.scheduleLock()) {
            assertTrue(scheduler.recordIndependentFireRetryEvidenceLocked(
                    med,
                    dose,
                    date,
                    epoch(date, "08:00"),
                    2.0,
                    "08:00",
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

        assertTrue(Phase2TestSupport.newScheduler().compactTerminalState());
        assertTrue("unreconciled FIRED event is recovery state, not terminal history",
                eventPrefs().contains(evtKey(key)));
        assertTrue("active Auto marker must remain while FIRED is unresolved",
                appContext().getSharedPreferences(
                        "drugtracker_auto_stock_v1", 0)
                        .contains("auto:" + key));

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.RestoreResult recovered =
                scheduler.recoverFiredStockPass();
        assertTrue(recovered.ok);
        assertEquals(18.0, stock.readAll().stocks.get(med), 0.001);
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
        assertTrue(Phase2TestSupport.newScheduler().compactTerminalState());

        AutoDeductionScheduler replay = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.FireResult result = replay.fireOccurrenceIfNotCancelled(
                med, dose, date, epoch(date, "08:00"), 2.0, "old-version", 1L);
        assertEquals(
                AutoDeductionScheduler.FireResult.Status.CANCELLED,
                result.status);
        assertEquals(18.0, stock.readAll().stocks.get(med), 0.001);
    }

    @Test
    public void successorAlreadyInstalled_obligationRecoveryIsIdempotent()
            throws Exception {
        String med = "med-408-installed";
        String dose = "dose-408-installed";
        String sourceDate = localDateOffset(0);
        String futureDate = localDateOffset(1);
        String time = "23:59";
        long generation = 1L;
        seedGeneration(med, dose, generation);

        putSchedule(med, dose, sourceDate, time, 1.0, "v408-installed", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 50.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.ScheduleResult installed =
                scheduler.scheduleOccurrence(
                        med, dose, futureDate, time, 1.0,
                        epoch(futureDate, time));
        assertTrue(installed.ok);

        assertTrue(scheduler.persistSuccessorObligation(
                med, dose, sourceDate, time, 1.0, "", "v408-installed", generation));
        assertTrue(scheduler.markSuccessorObligationStockApplied(
                med, dose, sourceDate));

        assertTrue(scheduler.recoverSuccessorObligations());
        assertTrue(schedulePrefs().contains(
                schKey(occurrenceKey(med, dose, futureDate))));
        assertFalse("recovery must retire the consumed source metadata",
                schedulePrefs().contains(
                        schKey(occurrenceKey(med, dose, sourceDate))));
        assertNull(scheduler.successorObligationStore().get(
                med, dose, sourceDate));
        assertEquals(50.0, stock.readAll().stocks.get(med), 0.001);
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

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
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

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
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

        assertTrue(Phase2TestSupport.newScheduler().compactTerminalState());
        assertFalse(stockPrefs.contains(markerKey));
        assertFalse(eventPrefs().contains(evtKey(key)));
    }

    @Test
    public void overdueSuccessors_areRecoveredInOrder_andOnlyNextFutureIsArmed()
            throws Exception {
        String med = "med-411";
        String dose = "dose-411";
        String start = localDateOffset(-4);
        String time = "00:00";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, start, time, 1.0, "v411", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.ScheduleResult first =
                scheduler.scheduleNextOccurrenceIfAbsent(
                        med, dose, start, time, 1.0, generation);
        assertTrue(first.ok);

        String day1 = AutoDeductionScheduler.nextCalendarDate(start);
        String day2 = AutoDeductionScheduler.nextCalendarDate(day1);
        String day3 = AutoDeductionScheduler.nextCalendarDate(day2);
        String day4 = AutoDeductionScheduler.nextCalendarDate(day3);

        assertTrue("first overdue successor must be recovered",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, day1))));
        assertTrue("second overdue successor must be recovered",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, day2))));
        assertTrue("third overdue successor must be recovered",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, day3))));
        String firstFuture = AutoDeductionScheduler.nextCalendarDate(day4);
        assertTrue("only the first future successor should remain scheduled",
                schedulePrefs().contains(schKey(occurrenceKey(med, dose, firstFuture))));
        assertFalse("the current-day occurrence at 00:00 should already be recovered",
                schedulePrefs().contains(schKey(occurrenceKey(med, dose, day4))));

        double afterFirstPass = stock.readAll().stocks.get(med);
        assertTrue(afterFirstPass < 100.0);

        AutoDeductionScheduler.ScheduleResult second =
                scheduler.scheduleNextOccurrenceIfAbsent(
                        med, dose, start, time, 1.0, generation);
        assertTrue(second.ok);
        assertEquals("re-running overdue catch-up must not deduct twice",
                afterFirstPass,
                stock.readAll().stocks.get(med),
                0.001);
    }

    @Test
    public void liveFireAfterSuccessorIsAlreadyDue_recoversAllDueDatesAndArmsOnlyNextFuture()
            throws Exception {
        String med = "med-411-live";
        String dose = "dose-411-live";
        String sourceDate = localDateOffset(-3);
        String time = "00:01";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, sourceDate, time, 1.0, "v411-live", generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionReceiver.handleFireDelivery(
                appContext(),
                med,
                dose,
                sourceDate,
                epoch(sourceDate, time),
                1.0,
                time,
                generation,
                "v411-live",
                0);

        String day1 = AutoDeductionScheduler.nextCalendarDate(sourceDate);
        String day2 = AutoDeductionScheduler.nextCalendarDate(day1);
        String day3 = AutoDeductionScheduler.nextCalendarDate(day2);
        String future = AutoDeductionScheduler.nextCalendarDate(day3);

        assertTrue("live source occurrence must be recorded",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, sourceDate))));
        assertTrue("first overdue successor must be recovered",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, day1))));
        assertTrue("second overdue successor must be recovered",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, day2))));
        assertTrue("third overdue successor must be recovered",
                eventPrefs().contains(evtKey(occurrenceKey(med, dose, day3))));
        assertTrue("only the first future successor should remain armed",
                schedulePrefs().contains(schKey(occurrenceKey(med, dose, future))));
        assertFalse("the consumed source schedule must not remain as historical metadata",
                schedulePrefs().contains(schKey(occurrenceKey(med, dose, sourceDate))));
        assertEquals("source + all overdue successors must each deduct once",
                96.0,
                stock.readAll().stocks.get(med),
                0.001);
    }

    @Test
    public void overdueRecovery_processDeathBeforeSuccessorInstall_recoversFromDurableObligation()
            throws Exception {
        String med = "med-408-overdue-death";
        String dose = "dose-408-overdue-death";
        String sourceDate = localDateOffset(-2);
        String time = "00:01";
        long generation = 1L;
        seedGeneration(med, dose, generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        String overdueDate = AutoDeductionScheduler.nextCalendarDate(sourceDate);

        // Equivalent durable state to a process death immediately after an overdue
        // catch-up occurrence was FIRED + stock-deducted but before its successor
        // could be installed. No schedule row exists for the overdue occurrence.
        AutoDeductionScheduler.FireResult recovered =
                scheduler.recoverMissedOccurrence(
                        med,
                        dose,
                        overdueDate,
                        epoch(overdueDate, time),
                        1.0,
                        generation,
                        "",
                        time);
        assertTrue(recovered.allowsRecurrence());
        assertEquals(19.0, stock.readAll().stocks.get(med), 0.001);
        assertNotNull("overdue occurrence must retain durable successor ownership",
                scheduler.successorObligationStore().get(
                        med, dose, overdueDate));
        assertFalse("overdue occurrence itself is not a live future schedule",
                schedulePrefs().contains(
                        schKey(occurrenceKey(med, dose, overdueDate))));

        // Recreate the scheduler as the native process would after restart.
        AutoDeductionScheduler restarted = Phase2TestSupport.newScheduler();
        assertTrue("restart recovery must continue from the durable obligation",
                restarted.recoverSuccessorObligations());

        String futureDate = AutoDeductionScheduler.nextCalendarDate(overdueDate);
        assertTrue("successor must be installed exactly once",
                schedulePrefs().contains(
                        schKey(occurrenceKey(med, dose, futureDate))));
        assertNull("resolved obligation must be retired",
                restarted.successorObligationStore().get(
                        med, dose, overdueDate));

        assertTrue("re-running recovery must remain idempotent",
                restarted.recoverSuccessorObligations());
        assertEquals("restart recovery must not deduct the overdue occurrence twice",
                19.0,
                stock.readAll().stocks.get(med),
                0.001);
    }

    @Test
    public void invalidatedGeneration_preventsOverdueSuccessorCatchUp() throws Exception {
        String med = "med-411-cancel";
        String dose = "dose-411-cancel";
        String start = localDateOffset(-3);
        String time = "00:01";
        seedGeneration(med, dose, 1L);
        putSchedule(med, dose, start, time, 1.0, "v-cancel", 1L);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        assertTrue(scheduler.invalidateRecurrenceAuthorization(med, dose).ok);

        AutoDeductionScheduler.ScheduleResult result =
                scheduler.scheduleNextOccurrenceIfAbsent(
                        med, dose, start, time, 1.0, 1L);
        assertFalse(result.ok);
        assertFalse(eventPrefs().contains(
                evtKey(occurrenceKey(med, dose, AutoDeductionScheduler.nextCalendarDate(start)))));
    }

    @Test
    public void overdueCatchUp_alreadyFiredOccurrence_isIdempotent() throws Exception {
        String med = "med-411-idempotent";
        String dose = "dose-411-idempotent";
        String start = localDateOffset(-3);
        String time = "00:01";
        seedGeneration(med, dose, 1L);
        putSchedule(med, dose, start, time, 2.0, "v-idempotent", 1L);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 50.0))).ok);

        AutoDeductionEventStore events = new AutoDeductionEventStore(appContext());
        String firstDue = AutoDeductionScheduler.nextCalendarDate(start);
        assertTrue(events.insertFiredIfAbsent(
                med, dose, firstDue, epoch(firstDue, time), 2.0).isCreated());
        assertTrue(stock.applyAutoDeduction(med, dose, firstDue, 2.0).ok);
        double before = stock.readAll().stocks.get(med);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        assertTrue(scheduler.scheduleNextOccurrenceIfAbsent(
                med, dose, start, time, 2.0, 1L).ok);

        assertEquals(
                "existing FIRED occurrence must not deduct twice",
                before,
                stock.readAll().stocks.get(med),
                0.001);
        assertTrue(schedulePrefs().contains(
                schKey(occurrenceKey(
                        med, dose, AutoDeductionScheduler.nextCalendarDate(
                                AutoDeductionScheduler.nextCalendarDate(
                                        AutoDeductionScheduler.nextCalendarDate(start)))))));
    }

    @Test
    public void successorObligationReplay_preservesTreatmentEndDate() throws Exception {
        String med = "med-408-treatment-end";
        String dose = "dose-408-treatment-end";
        String date = localDateOffset(-1);
        String treatmentEndDate = localDateOffset(1);
        long generation = 1L;
        seedGeneration(med, dose, generation);

        putSchedule(med, dose, date, "23:59", 2.0, "v408-end", generation);
        String scheduleKey = schKey(occurrenceKey(med, dose, date));
        JSONObject scheduled = new JSONObject(schedulePrefs().getString(scheduleKey, "{}"));
        scheduled.put("treatmentEndDate", treatmentEndDate);
        schedulePrefs().edit().putString(scheduleKey, scheduled.toString()).commit();

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 100.0))).ok);

        AutoDeductionScheduler scheduler = Phase2TestSupport.newScheduler();
        AutoDeductionScheduler.FireResult fired =
                scheduler.fireOccurrenceIfNotCancelled(
                        med, dose, date, epoch(date, "23:59"), 2.0,
                        "v408-end", generation);
        assertTrue(fired.allowsRecurrence());

        AutoDeductionScheduler restarted = Phase2TestSupport.newScheduler();
        assertTrue(restarted.recoverSuccessorObligations());

        AutoDeductionPersistenceModels.ScheduleRecord successor =
                restarted.schedulingAdapter().getScheduleRecord(
                        occurrenceKey(med, dose, localDateOffset(0)));
        assertNotNull("replayed successor must remain scheduled", successor);
        assertEquals(
                "replayed successor must preserve treatment end",
                treatmentEndDate,
                successor.treatmentEndDate);
    }

    @Test
    public void malformedSuccessorObligation_isQuarantinedWithoutBlockingHealthyRecords()
            throws Exception {
        String med = "med-408-quarantine";
        String dose = "dose-408-quarantine";
        String date = localDateOffset(-1);
        seedGeneration(med, dose, 1L);

        AutoSuccessorObligationStore store = new AutoSuccessorObligationStore(appContext());
        AutoDeductionPersistenceModels.SuccessorObligationRecord healthy =
                new AutoDeductionPersistenceModels.SuccessorObligationRecord(
                        new AutoDeductionPersistenceModels.OccurrenceId(med, dose, date),
                        "08:00",
                        1.0,
                        "",
                        "v-quarantine",
                        1L,
                        false,
                        System.currentTimeMillis());
        assertTrue(store.save(healthy));

        String poisonKey =
                AutoDeductionContract.SUCCESSOR_OBLIGATION_KEY_PREFIX + "poison";
        android.content.SharedPreferences prefs = appContext()
                .getSharedPreferences(
                        AutoDeductionContract.PREFS_SUCCESSOR_OBLIGATIONS, 0);
        prefs.edit().putString(poisonKey, "{not-json").commit();

        AutoSuccessorObligationStore.ListResult listed = store.listAll();
        assertTrue("one malformed row must not poison healthy obligations", listed.ok);
        assertEquals(1, listed.obligations.size());

        String quarantineKey =
                AutoDeductionContract.SUCCESSOR_OBLIGATION_QUARANTINE_KEY_PREFIX + "poison";
        assertFalse("malformed active key must be removed after quarantine",
                prefs.contains(poisonKey));
        assertTrue("raw malformed payload must be retained diagnostically",
                prefs.contains(quarantineKey));
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

        assertTrue(Phase2TestSupport.newScheduler().compactTerminalState());
        assertFalse("old REJECTED terminal state must not remain forever",
                eventPrefs().contains(key));
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
