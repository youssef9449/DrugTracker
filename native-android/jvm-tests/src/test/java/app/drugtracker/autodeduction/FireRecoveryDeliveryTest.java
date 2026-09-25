package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.appContext;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.readAuthGeneration;
import static app.drugtracker.autodeduction.Phase2TestSupport.seedAutoStock;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import app.drugtracker.alarmruntime.ExactAlarmContract;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.shadows.ShadowPendingIntent;

import java.time.LocalDate;
import java.util.List;

/** FireRecoveryDeliveryTest — fire-retry/recovery behavior split (#490). */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FireRecoveryDeliveryTest extends FireRetryFixtureSupport {

    @Test
    public void receiverDelivery_createdFire_schedulesSuccessorWithoutRetryExtra()
            throws Exception {
        String date = futureCalendarDate(2);
        long epoch = futureEpochMs(date, "12:00");
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence("med", "dose", date, "12:00", 1.0, epoch).ok);
        // The original D alarm is still pending in the shadow — drain it so the
        // assertion below sees exactly the D+1 successor this delivery creates.
        drainAlarms();
        JSONObject meta = readAnyScheduleMetadata();
        assertNotNull(meta);
        String version = meta.optString(ExactAlarmContract.FIELD_OPERATION_VERSION, "");
        long gen = readAuthGeneration("med", "dose");

        seedAutoStock("med", 10.0);

        AutoDeductionReceiver.handleFireDelivery(
                appContext(), "med", "dose", date, epoch, 1.0, "12:00",
                gen, version, 0);

        AutoDeductionStockStore.SnapshotResult stock =
                new AutoDeductionStockStore(appContext()).readAll();
        assertTrue(stock.ok);
        assertEquals(
                "live fire must finish Native stock before the receiver returns",
                9.0,
                stock.stocks.get("med"),
                0.0001);

        assertEquals(1, alarmCount());
        ShadowAlarmManager.ScheduledAlarm alarm = firstAlarm();
        assertNotNull(alarm.operation);
        Intent saved = Shadows.shadowOf(alarm.operation).getSavedIntent();
        assertNotNull(saved);
        assertEquals("normal delivery carries no retry counter", 0,
                saved.getIntExtra(AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT, 0));
    }

    @Test
    public void recoverFiredStockPass_uninitializedDefersWithoutCreatingBaseline() {
        AutoDeductionScheduler s = newScheduler();

        AutoDeductionEventStore store = new AutoDeductionEventStore(appContext());
        AutoDeductionEventStore.InsertFiredResult inserted =
                store.insertFiredIfAbsent(
                        "med",
                        "dose",
                        "2026-09-15",
                        1000L,
                        2.0);
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                inserted.status);

        AutoDeductionScheduler.RestoreResult result = s.recoverFiredStockPass();
        assertTrue(result.ok);

        AutoDeductionStockStore.SnapshotResult stock =
                new AutoDeductionStockStore(appContext()).readAll();
        assertTrue(stock.ok);
        assertTrue("no Native baseline must be created from an ambiguous legacy FIRED row",
                stock.stocks.isEmpty());
    }

    @Test
    public void receiverDelivery_staleFire_schedulesNothing() {
        // No schedule metadata exists → ownership check rejects the delivery
        // (CANCELLED). Neither recurrence nor a retry may be scheduled.
        String date = futureCalendarDate(2);
        long epoch = futureEpochMs(date, "12:00");

        AutoDeductionReceiver.handleFireDelivery(
                appContext(), "med", "dose", date, epoch, 1.0, "12:00",
                0L, "stale-version", 0);

        assertNull("cancelled fire must not schedule any alarm", firstAlarm());
    }

    @Test
    public void receiverDelivery_retryBudgetExhausted_defersWithoutRescheduling() {
        // The receiver gate refuses a retry once the per-occurrence budget is
        // exhausted, so no alarm may be scheduled on that path — recovery is
        // deferred to boot/TZ/JS restore instead.
        AutoDeductionScheduler.FireResult failedNoPending =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, false);
        assertFalse(AutoDeductionReceiver.shouldScheduleFireRetry(
                failedNoPending, AutoDeductionContract.MAX_FIRE_RETRIES));
        assertEquals(0, alarmCount());
    }

    @Test
    public void independentFireRetryEvidence_survivesScheduleMetadataRemoval()
            throws Exception {
        String date = futureCalendarDate(3);
        long epoch = futureEpochMs(date, "10:00");
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "10:00", 2.0, epoch).ok);

        // Simulate FAILED/no-pending by recording independent evidence under lock
        // (production path does this inside fireOccurrenceIfNotCancelled).
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, epoch, 2.0, "10:00", "", 1L, "v1", 1));
        }

        // Config mutation: remove schedule metadata
        String prefKey = "sch:" + key;
        schedulePrefs().edit().remove(prefKey).commit();
        assertFalse(schedulePrefs().contains(prefKey));

        // Independent evidence must still be present
        AutoDeductionPersistenceModels.RetryEvidenceRecord evidence =
                s.getIndependentFireRetryEvidence("med", "dose", date);
        assertNotNull(evidence);
        assertEquals(1, evidence.retryCount);
        assertEquals(2.0, evidence.amount, 0.0001);

        // Retry can still be scheduled from independent evidence
        assertTrue(s.scheduleFireRetry(
                "med", "dose", date, epoch, 2.0, "10:00", 1L, "v1", 2));
        evidence = s.getIndependentFireRetryEvidence("med", "dose", date);
        assertNotNull(evidence);
        assertEquals(2, evidence.retryCount);
    }

    @Test
    public void restoreFutureSchedules_explicitFailure_okFalse() {
        AutoDeductionFailurePolicy denyRestore =
                new AutoDeductionFailurePolicy() {
                    @Override
                    public boolean allowRestoreFutureSchedules() {
                        return false;
                    }
                };
        AutoDeductionScheduler s = newScheduler(denyRestore);
        AutoDeductionScheduler.RestoreResult rr = s.restoreFutureSchedules();
        assertFalse(rr.ok);
        assertEquals("forced_restore_failure", rr.error);
        assertEquals(0, rr.restored);
    }

    /** Shared Auto serialization monitor used by production collaborators. */
    private static Object getScheduleLock() {
        return AutoDeductionScheduler.class;
    }

    @Test
    public void recoverFireFromIndependentEvidence_withoutScheduleMetadata_succeeds()
            throws Exception {
        String date = localDateOffset(-40);
        AutoDeductionScheduler s = newScheduler();
        // No sch: row — only independent evidence
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 2.0, "08:00", "", 1L, "v1", 1));
        }
        seedAutoStock("med", 10.0);
        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);
        assertTrue(fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS
                || fr.pendingRecorded);
        assertNull(
                "successful recovery completes Native stock and clears retry evidence",
                s.getIndependentFireRetryEvidence("med", "dose", date));
    }

    @Test
    public void recoverFiredStockPass_repairsFiredWithoutJsAndLeavesAckForJs() {
        String date = "2026-09-14";
        AutoDeductionScheduler scheduler = newScheduler();
        seedAutoStock("med", 10.0);

        AutoDeductionEventStore.InsertFiredResult inserted =
                new AutoDeductionEventStore(appContext()).insertFiredIfAbsent(
                        "med", "dose", date, 1000L, 2.0);
        assertEquals(
                AutoDeductionEventStore.InsertFiredResult.Status.CREATED,
                inserted.status);

        AutoDeductionScheduler.RestoreResult recovery =
                scheduler.recoverFiredStockPass();

        assertTrue(recovery.ok);
        assertEquals(1, recovery.restored);
        assertEquals(0, recovery.failed);

        AutoDeductionStockStore.SnapshotResult stock =
                new AutoDeductionStockStore(appContext()).readAll();
        assertEquals(8.0, stock.stocks.get("med"), 0.0001);

        AutoDeductionEventStore.EventLookupResult event =
                new AutoDeductionEventStore(appContext())
                        .getFiredUnreconciledEvent("med", "dose", date);
        assertTrue("JS still owns the final RECONCILED acknowledgement", event.ok);
        assertNotNull("FIRED evidence must remain for JS reconciliation", event.record);
    }

    @Test
    public void restoreFutureSchedules_allValid_okTrue() {
        AutoDeductionScheduler s = newScheduler();
        String date = futureCalendarDate(5);
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "09:00", 1.0, futureEpochMs(date, "09:00")).ok);
        AutoDeductionScheduler.RestoreResult rr = s.restoreFutureSchedules();
        assertTrue(rr.ok);
        assertEquals(0, rr.failed);
    }

    @Test
    public void recoverFireFromIndependentEvidence_survivesLaterCancellation()
            throws Exception {
        String date = "2026-09-11";
        AutoDeductionScheduler s = newScheduler();
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 2.0, "08:00", "", 1L, "v1", 1));
        }
        // Later cancellation tombstone (config mutation after failed fire)
        s.cancelOccurrence("med", "dose", date);
        seedAutoStock("med", 10.0);
        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);
        assertTrue(
                "later cancel must not erase prior fire evidence recovery",
                fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                        || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS
                        || fr.pendingRecorded);
        assertNull(
                "successful recovery completes Native stock and clears retry evidence",
                s.getIndependentFireRetryEvidence("med", "dose", date));
    }

    @Test
    public void recoverIndependentEvidence_ownedSchedule_resumesSuccessor() throws Exception {
        String date = futureCalendarDate(2);
        long epoch = futureEpochMs(date, "12:00");
        AutoDeductionScheduler s = newScheduler();

        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 1.0, epoch).ok);
        String[] vg = activeVersionAndGen("med", "dose", date);
        drainAlarms();
        seedAutoStock("med", 10.0);

        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med",
                    "dose",
                    date,
                    epoch,
                    1.0,
                    "12:00",
                    "",
                     Long.parseLong(vg[1]),
                    vg[0],
                    1));
        }

        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);

        assertTrue(
                "successful independent recovery must complete the Auto occurrence",
                fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                        || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS);
        AutoDeductionStockStore.SnapshotResult stock =
                new AutoDeductionStockStore(appContext()).readAll();
        assertEquals(9.0, stock.stocks.get("med"), 0.0001);

        // The consumed D alarm is gone; successful retry recovery must immediately
        // recreate only the next occurrence while the D schedule still owns the evidence.
        assertEquals("retry recovery must resume the recurrence chain", 1, alarmCount());
        ShadowAlarmManager.ScheduledAlarm alarm = firstAlarm();
        assertNotNull(alarm.operation);
        Intent saved = Shadows.shadowOf(alarm.operation).getSavedIntent();
        assertNotNull(saved);
        String expectedNextDate = LocalDate.parse(date).plusDays(1).toString();
        assertEquals(expectedNextDate,
                saved.getStringExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE));
        assertEquals(0,
                saved.getIntExtra(AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT, 0));
        JSONObject successorMetadata = new JSONObject(
                schedulePrefs().getString(
                        "sch:" + AutoDeductionContract.occurrenceKey(
                                "med", "dose", expectedNextDate),
                        "{}"));
        String successorVersion = successorMetadata.optString(
                ExactAlarmContract.FIELD_OPERATION_VERSION,
                "");
        assertFalse("successor must have its own fresh operationVersion",
                successorVersion.isEmpty());
        assertEquals(
                "PendingIntent must carry the successor's authoritative operationVersion",
                successorVersion,
                saved.getStringExtra(AutoDeductionContract.EXTRA_OPERATION_VERSION));

        // The retry evidence is no longer needed after both stock and successor
        // scheduling have reached their durable boundary.
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
    }

    @Test
    public void recoverIndependentEvidence_replacedScheduleDoesNotResurrectStaleSuccessor()
            throws Exception {
        String date = futureCalendarDate(3);
        long epoch = futureEpochMs(date, "12:00");
        AutoDeductionScheduler s = newScheduler();

        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 1.0, epoch).ok);
        String[] oldVg = activeVersionAndGen("med", "dose", date);
        drainAlarms();

        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 2.0, epoch).ok);
        String[] newVg = activeVersionAndGen("med", "dose", date);
        assertFalse(oldVg[0].equals(newVg[0]));
        drainAlarms();

        seedAutoStock("med", 10.0);
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med",
                    "dose",
                    date,
                    epoch,
                    1.0,
                    "12:00",
                    "",
                     Long.parseLong(oldVg[1]),
                    oldVg[0],
                    1));
        }

        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);

        assertEquals(
                "stale retry evidence must not recover an occurrence after schedule replacement",
                AutoDeductionScheduler.FireResult.Status.CANCELLED,
                fr.status);
        AutoDeductionStockStore.SnapshotResult stock =
                new AutoDeductionStockStore(appContext()).readAll();
        assertEquals(10.0, stock.stocks.get("med"), 0.0001);

        // The replacement schedule is the current owner; old evidence must not
        // mutate stock or create a successor.
        assertEquals(0, alarmCount());
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
    }

    @Test
    public void handleIndependentRecovery_created_doesNotScheduleSuccessor() throws Exception {
        // Independent recovery CREATED path must not install a next-day alarm.
        // Use handleFireDelivery with pre-seeded evidence and no sch: metadata.
        String date = "2026-09-12";
        AutoDeductionScheduler s = newScheduler();
        try {
            java.lang.reflect.Method m = AutoDeductionScheduler.class
                    .getDeclaredMethod(
                            "recordIndependentFireRetryEvidenceLocked",
                            String.class, String.class, String.class, long.class,
                            double.class, String.class, String.class, long.class, String.class, int.class);
            m.setAccessible(true);
        } catch (Exception ignored) {
            // package-private; same package can call directly
        }
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 1.0, "08:00", "", 1L, "v1", 1));
        }
        int before = alarmCount();
        seedAutoStock("med", 10.0);

        AutoDeductionReceiver.handleFireDelivery(
                appContext(), "med", "dose", date, 1000L, 1.0, "08:00",
                1L, "v1", 1);
        // No successor alarm from independent recovery
        assertEquals(
                "independent recovery must not schedule successor",
                before, alarmCount());
    }

    @Test
    public void maxRetriesUnresolved_restoreOkFalse_evidenceRetained()
            throws Exception {
        // Invalid amount so recoverFireFromIndependentEvidence cannot produce FIRED;
        // retryCount already at MAX → no new retry; boundary must be incomplete.
        String date = "2026-09-13";
        AutoDeductionFailurePolicy denyEventCommit =
                new AutoDeductionFailurePolicy() {
                    @Override
                    public boolean allowEventCommit() {
                        return false;
                    }

                    @Override
                    public boolean allowPendingFireCommit() {
                        return false;
                    }
                };
        AutoDeductionScheduler s = newScheduler(denyEventCommit);
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 1.0, "08:00", "", 1L, "v1",
                    AutoDeductionContract.MAX_FIRE_RETRIES));
        }
        seedAutoStock("med", 10.0);
        AutoDeductionScheduler.RestoreResult rr =
                s.recoverIndependentFireRetryEvidencePass();
        assertFalse(rr.ok);
        assertTrue(rr.failed >= 1);
        // Evidence must remain for a later boundary
        assertNotNull(s.getIndependentFireRetryEvidence("med", "dose", date));
        assertEquals(
                AutoDeductionContract.MAX_FIRE_RETRIES,
                s.getIndependentFireRetryEvidence("med", "dose", date)
                        .retryCount);
    }

    @Test
    public void recoverWithoutSch_existingEvidence_producesDurableFired()
            throws Exception {
        String date = "2026-09-16";
        seedAutoStock("med", 10.0);
        AutoDeductionScheduler s = newScheduler();
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 2.0, "08:00", "", 1L, "v1", 1));
        }
        // No sch: row
        assertFalse(schedulePrefs().contains(
                "sch:" + AutoDeductionContract.occurrenceKey("med", "dose", date)));
        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);
        assertTrue(fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS
                || fr.pendingRecorded);
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
    }

}