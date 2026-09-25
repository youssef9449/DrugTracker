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
public class SuccessorObligationRecoveryTest extends Group2AutoReliabilityFixture {

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

        // Recovery is modeled after today's 23:59 slot, so the next occurrence
        // is deterministically tomorrow rather than depending on wall-clock time.
        long recoveryNow = epoch(localDateOffset(0), "23:59") + 1_000L;
        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newSchedulerAt(recoveryNow);
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
                "expected future successor, actual schedule keys="
                        + schedulePrefs().getAll().keySet(),
                schedulePrefs().contains(
                        schKey(occurrenceKey(med, dose, localDateOffset(1)))));
        assertTrue("today's overdue successor must be recorded during catch-up",
                eventPrefs().contains(
                        evtKey(occurrenceKey(med, dose, localDateOffset(0)))));
        assertEquals(
                "recovery must not deduct the original FIRED occurrence twice; actual stock="
                        + stock.readAll().stocks.get(med),
                96.0,
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

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
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
        AutoDeductionScheduler restarted = AutoDeductionTestSupport.newScheduler();
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

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
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
        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
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
        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
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

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
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

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        assertTrue("source occurrence must be durably FIRED before successor scheduling",
                new AutoDeductionEventStore(appContext()).insertFiredIfAbsent(
                        med, dose, start, epoch(start, time), 1.0).isCreated());
        assertTrue(new AutoDeductionStockStore(appContext())
                .applyAutoDeductionForRecovery(med, dose, start, 1.0).ok);
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
        assertTrue(
                "re-running overdue catch-up failed: " + second.error,
                second.ok);
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
        String time = "23:59";
        long generation = 1L;
        seedGeneration(med, dose, generation);

        AutoDeductionStockStore stock = new AutoDeductionStockStore(appContext());
        assertTrue(stock.ensureMissingAndRead(
                java.util.Collections.singletonList(
                        new AutoDeductionStockStore.StockSeed(med, 20.0))).ok);

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
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
        AutoDeductionScheduler restarted = AutoDeductionTestSupport.newScheduler();
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
    public void overdueCatchUp_alreadyFiredOccurrence_isIdempotent() throws Exception {
        String med = "med-411-idempotent";
        String dose = "dose-411-idempotent";
        String start = localDateOffset(-2);
        String time = "23:59";
        long generation = 1L;
        seedGeneration(med, dose, generation);
        putSchedule(med, dose, start, time, 2.0, "v-idempotent", generation);

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

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        assertTrue(scheduler.scheduleNextOccurrenceIfAbsent(
                med, dose, start, time, 2.0, generation).ok);

        assertEquals(
                "existing FIRED occurrence must not deduct twice",
                before,
                stock.readAll().stocks.get(med),
                0.001);
        String expectedFuture = AutoDeductionScheduler.nextCalendarDate(firstDue);
        assertTrue(schedulePrefs().contains(
                schKey(occurrenceKey(med, dose, expectedFuture))));
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

        AutoDeductionScheduler scheduler = AutoDeductionTestSupport.newScheduler();
        AutoDeductionScheduler.FireResult fired =
                scheduler.fireOccurrenceIfNotCancelled(
                        med, dose, date, epoch(date, "23:59"), 2.0,
                        "v408-end", generation);
        assertTrue(fired.allowsRecurrence());

        AutoDeductionScheduler restarted = AutoDeductionTestSupport.newScheduler();
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

}