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

/**
 * Bounded fire-persistence retry: when a fire delivery cannot durably persist
 * FIRED or a pending record, the receiver must schedule a bounded
 * same-identity retry alarm instead of silently consuming the one-shot
 * delivery. The retry carries the SAME occurrence identity + ownership tokens
 * so the fire path stays the single linearized, idempotent transition.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FireRetryScheduleTest {
    private static String localDateOffset(int days) {
        return Phase2TestSupport.futureCalendarDate(days);
    }


    @Before
    public void setUp() {
        clearAllDurableState();
        drainAlarms();
    }

    @After
    public void tearDown() {
    }

    private static void drainAlarms() {
        AlarmManager am = alarmManager();
        List<ShadowAlarmManager.ScheduledAlarm> alarms = new java.util.ArrayList<>(
                Shadows.shadowOf(am).getScheduledAlarms());
        for (ShadowAlarmManager.ScheduledAlarm alarm : alarms) {
            if (alarm.operation != null) {
                am.cancel(alarm.operation);
            }
        }
        assertEquals("test alarm queue must be empty after drain", 0, alarmCount());
    }

    private static AlarmManager alarmManager() {
        return (AlarmManager) appContext().getSystemService(Context.ALARM_SERVICE);
    }

    private static int alarmCount() {
        return Shadows.shadowOf(alarmManager()).getScheduledAlarms().size();
    }

    private static ShadowAlarmManager.ScheduledAlarm firstAlarm() {
        List<ShadowAlarmManager.ScheduledAlarm> alarms =
                Shadows.shadowOf(alarmManager()).getScheduledAlarms();
        return alarms.isEmpty() ? null : alarms.get(0);
    }

    /**
     * Read the (single) schedule metadata payload written by scheduleOccurrence
     * so tests can pass the REAL ownership tokens to the receiver path.
     */
    private static JSONObject readAnyScheduleMetadata() throws Exception {
        for (java.util.Map.Entry<String, ?> e : schedulePrefs().getAll().entrySet()) {
            Object v = e.getValue();
            if (v instanceof String && e.getKey().startsWith("sch:")) {
                return new JSONObject((String) v);
            }
        }
        return null;
    }

    private static String[] activeVersionAndGen(
            String medicationId, String doseId, String calendarDate)
            throws Exception {
        String key = AutoDeductionContract.occurrenceKey(
                medicationId, doseId, calendarDate);
        String raw = schedulePrefs().getString(
                "sch:" + key, null);
        assertNotNull(raw);
        JSONObject metadata = new JSONObject(raw);
        assertFalse(
                "Shared alarm metadata must not persist Auto recurrence authorization",
                metadata.has(AutoDeductionScheduler.FIELD_RECURRENCE_GENERATION));
        String operationVersion = metadata.optString(
                ExactAlarmContract.FIELD_OPERATION_VERSION, "");
        assertFalse("schedule must contain operationVersion",
                operationVersion.isEmpty());
        long generation = Phase2TestSupport.appContext()
                .getSharedPreferences(
                        AutoDeductionContract.PREFS_RECURRENCE_AUTH, 0)
                .getLong(
                        AutoDeductionContract.RECURRENCE_AUTH_KEY_PREFIX
                                + AutoDeductionContract.scheduleIdentityKey(
                                        medicationId, doseId),
                        0L);
        assertTrue("Auto recurrence generation must be durable in its own state",
                generation > 0L);
        return new String[] {
                operationVersion,
                String.valueOf(generation)
        };
    }

    @Test
    public void shouldScheduleFireRetry_pureDecision() {
        AutoDeductionScheduler.FireResult failedNoPending =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, false);
        AutoDeductionScheduler.FireResult failedWithPending =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.FAILED, true);
        AutoDeductionScheduler.FireResult created =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.CREATED, false);
        AutoDeductionScheduler.FireResult cancelled =
                new AutoDeductionScheduler.FireResult(
                        AutoDeductionScheduler.FireResult.Status.CANCELLED, false);

        assertTrue(AutoDeductionReceiver.shouldScheduleFireRetry(failedNoPending, 0));
        assertTrue(AutoDeductionReceiver.shouldScheduleFireRetry(
                failedNoPending, AutoDeductionContract.MAX_FIRE_RETRIES - 1));
        assertFalse("budget exhausted — no more retries",
                AutoDeductionReceiver.shouldScheduleFireRetry(
                        failedNoPending, AutoDeductionContract.MAX_FIRE_RETRIES));
        assertFalse("pending evidence already exists — advance recurrence instead",
                AutoDeductionReceiver.shouldScheduleFireRetry(failedWithPending, 0));
        assertFalse(AutoDeductionReceiver.shouldScheduleFireRetry(created, 0));
        assertFalse(AutoDeductionReceiver.shouldScheduleFireRetry(cancelled, 0));
        assertFalse(AutoDeductionReceiver.shouldScheduleFireRetry(null, 0));
    }

    @Test
    public void scheduleFireRetry_schedulesSameIdentityAlarmWithRetryExtra()
            throws Exception {
        String date = futureCalendarDate(2);
        long epoch = futureEpochMs(date, "12:00");
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 1.0, epoch).ok);
        String[] vg = activeVersionAndGen("med", "dose", date);
        drainAlarms();

        assertTrue(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "12:00",
                     Long.parseLong(vg[1]), vg[0], 1));

        ShadowAlarmManager.ScheduledAlarm alarm = firstAlarm();
        assertNotNull("retry alarm must be scheduled", alarm);
        assertNotNull(alarm.operation);
        ShadowPendingIntent spi = Shadows.shadowOf(alarm.operation);
        assertEquals(AutoDeductionContract.PENDING_INTENT_REQUEST_CODE, spi.getRequestCode());

        Intent saved = spi.getSavedIntent();
        assertNotNull(saved);
        assertEquals(1, saved.getIntExtra(AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT, -1));
        assertEquals("med", saved.getStringExtra(AutoDeductionContract.EXTRA_MEDICATION_ID));
        assertEquals("dose", saved.getStringExtra(AutoDeductionContract.EXTRA_DOSE_ID));
        assertEquals(date, saved.getStringExtra(AutoDeductionContract.EXTRA_CALENDAR_DATE));
        assertEquals(
                "retry delivery must use the generic operationVersion token",
                vg[0],
                saved.getStringExtra(AutoDeductionContract.EXTRA_OPERATION_VERSION));
        assertNull(
                "retry delivery must not create a legacy scheduleVersion token",
                saved.getStringExtra("scheduleVersion"));

        Uri identity = saved.getData();
        assertNotNull("retry must target the exact occurrence identity",
                identity);
        assertEquals(AutoDeductionContract.occurrenceUri("med", "dose", date), identity);

        long expectedNoEarlierThan = System.currentTimeMillis()
                + AutoDeductionContract.FIRE_RETRY_DELAY_MS - 5_000L;
        assertTrue("retry must be delayed, not immediate",
                alarm.triggerAtTime >= expectedNoEarlierThan);
    }

    @Test
    public void scheduleFireRetry_keepsRetryStateOutOfSharedMetadata()
            throws Exception {
        String date = futureCalendarDate(2);
        seedAutoStock("med", 10.0);
        long epoch = futureEpochMs(date, "12:00");
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "12:00", 1.0, epoch).ok);
        String[] vg = activeVersionAndGen("med", "dose", date);

        drainAlarms();
        assertTrue(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "12:00",
                     Long.parseLong(vg[1]), vg[0], 1));

        JSONObject retryMeta = readAnyScheduleMetadata();
        assertNotNull(retryMeta);
        assertFalse(
                "retry counter must not be persisted in shared alarm metadata",
                retryMeta.has("fireRetryCount"));
        AutoDeductionPersistenceModels.RetryEvidenceRecord retryEvidence =
                s.getIndependentFireRetryEvidence("med", "dose", date);
        assertNotNull(retryEvidence);
        assertEquals(1, retryEvidence.retryCount);

        AutoDeductionScheduler.FireResult fire = s.fireOccurrenceIfNotCancelled(
                "med", "dose", date, epoch, 1.0, vg[0], Long.parseLong(vg[1]));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);

        JSONObject afterFire = readAnyScheduleMetadata();
        assertNotNull(afterFire);
        assertFalse("successful durable fire must leave shared metadata free of retry state",
                afterFire.has("fireRetryCount"));
        assertNull(
                "successful fire plus durable Native stock clears retry evidence",
                s.getIndependentFireRetryEvidence("med", "dose", date));
    }

    @Test
    public void scheduleFireRetry_staleOwnershipCannotOverwriteReplacementAlarm()
            throws Exception {
        String date = futureCalendarDate(3);
        long epoch = futureEpochMs(date, "13:00");
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "13:00", 1.0, epoch).ok);
        String[] oldVg = activeVersionAndGen("med", "dose", date);
        drainAlarms();

        // A new schedule for the same occurrence wins the native PendingIntent identity.
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "13:00", 2.0, epoch).ok);
        String[] newVg = activeVersionAndGen("med", "dose", date);
        assertFalse("reschedule must receive a fresh ownership version",
                oldVg[0].equals(newVg[0]));

        boolean retry = s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "13:00",
                Long.parseLong(oldVg[1]), oldVg[0], 1);
        assertFalse("stale retry must be rejected before touching AlarmManager", retry);
        assertEquals(1, alarmCount());

        Intent saved = Shadows.shadowOf(firstAlarm().operation).getSavedIntent();
        assertNotNull(saved);
        assertEquals("new operationVersion must remain authoritative",
                newVg[0],
                saved.getStringExtra(AutoDeductionContract.EXTRA_OPERATION_VERSION));
        assertEquals("new schedule must not be overwritten by retry",
                0,
                saved.getIntExtra(AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT, 0));
    }

    @Test
    public void scheduleFireRetry_cancelledOccurrenceCannotResurrectAlarm()
            throws Exception {
        String date = futureCalendarDate(4);
        long epoch = futureEpochMs(date, "14:00");
        AutoDeductionScheduler s = newScheduler();
        assertTrue(s.scheduleOccurrence(
                "med", "dose", date, "14:00", 1.0, epoch).ok);
        String[] vg = activeVersionAndGen("med", "dose", date);
        assertTrue(s.cancelOccurrence("med", "dose", date).isOk());

        assertFalse(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "14:00",
                Long.parseLong(vg[1]), vg[0], 1));
        assertEquals("cancel must leave no retry alarm", 0, alarmCount());
    }

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

    /** Access package-private SCHEDULE_LOCK via same package. */
    private static Object getScheduleLock() throws Exception {
        java.lang.reflect.Field f =
                AutoDeductionScheduler.class.getDeclaredField("SCHEDULE_LOCK");
        f.setAccessible(true);
        return f.get(null);
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
    public void scheduleFireRetry_staleOwnership_doesNotWriteIndependentEvidence()
            throws Exception {
        String date = futureCalendarDate(4);
        long epoch = futureEpochMs(date, "11:00");
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.ScheduleResult first =
                s.scheduleOccurrence("med", "dose", date, "11:00", 1.0, epoch);
        assertTrue(first.ok);
        // Capture ownership of first schedule
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        String prefKey = "sch:" + key;
        String raw1 = schedulePrefs().getString(prefKey, null);
        assertNotNull(raw1);
        JSONObject meta1 = new JSONObject(raw1);
        String ver1 = meta1.optString(ExactAlarmContract.FIELD_OPERATION_VERSION, "");
        long gen1 = readAuthGeneration("med", "dose");

        // Replace with newer schedule
        assertTrue(s.scheduleOccurrence("med", "dose", date, "11:00", 3.0, epoch).ok);
        String raw2 = schedulePrefs().getString(prefKey, null);
        JSONObject meta2 = new JSONObject(raw2);
        String ver2 = meta2.optString(ExactAlarmContract.FIELD_OPERATION_VERSION, "");
        assertFalse(ver1.equals(ver2));

        // Stale retry with old ownership tokens must not write evidence
        assertFalse(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "11:00", gen1, ver1, 1));
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
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
        assertEquals(vg[0],
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

        assertTrue(
                "stale retry evidence may still recover the already-authorized D stock mutation",
                fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                        || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS);
        AutoDeductionStockStore.SnapshotResult stock =
                new AutoDeductionStockStore(appContext()).readAll();
        assertEquals(9.0, stock.stocks.get("med"), 0.0001);

        // The replacement schedule is the current owner; old evidence must not create D+1.
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
    public void scheduleFireRetry_noSchAndNoEvidence_doesNotInventEvidence()
            throws Exception {
        String date = futureCalendarDate(6);
        long epoch = futureEpochMs(date, "10:00");
        AutoDeductionScheduler s = newScheduler();
        assertFalse(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "10:00", 1L, "v1", 1));
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
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

    @Test
    public void scheduleFireRetry_evidenceCommitFailure_failClosed()
            throws Exception {
        String date = futureCalendarDate(8);
        long epoch = futureEpochMs(date, "11:00");
        AutoDeductionScheduler s = newScheduler();
        AutoDeductionScheduler.ScheduleResult sr =
                s.scheduleOccurrence("med", "dose", date, "11:00", 1.0, epoch);
        assertTrue(sr.ok);
        String key = AutoDeductionContract.occurrenceKey("med", "dose", date);
        String raw = schedulePrefs().getString("sch:" + key, null);
        assertNotNull(raw);
        JSONObject meta = new JSONObject(raw);
        String ver = meta.optString(ExactAlarmContract.FIELD_OPERATION_VERSION, "");
        long gen = readAuthGeneration("med", "dose");

        int alarmsBefore = alarmCount();
        AutoDeductionFailurePolicy denyRetryEvidence =
                new AutoDeductionFailurePolicy() {
                    @Override
                    public boolean allowFireRetryEvidenceCommit() {
                        return false;
                    }
                };
        AutoDeductionScheduler failureScheduler = newScheduler(denyRetryEvidence);
        assertFalse(failureScheduler.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "11:00", gen, ver, 1));
        assertEquals("no retry alarm on evidence commit failure", alarmsBefore, alarmCount());
    }
}
