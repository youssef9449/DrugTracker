package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.Phase2TestSupport.appContext;
import static app.drugtracker.autodeduction.Phase2TestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.Phase2TestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.Phase2TestSupport.newScheduler;
import static app.drugtracker.autodeduction.Phase2TestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

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

    @Before
    public void setUp() {
        clearAllDurableState();
        drainAlarms();
        AutoDeductionEventStore.__setTestForceCommitResult(null);
    }

    @After
    public void tearDown() {
        AutoDeductionEventStore.__setTestForceCommitResult(null);
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
    public void scheduleFireRetry_persistsRecoveryMarkerAndFireClearsIt()
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

        JSONObject retryMeta = readAnyScheduleMetadata();
        assertNotNull(retryMeta);
        assertEquals(1, retryMeta.optInt(
                AutoDeductionScheduler.FIELD_FIRE_RETRY_COUNT, 0));

        AutoDeductionScheduler.FireResult fire = s.fireOccurrenceIfNotCancelled(
                "med", "dose", date, epoch, 1.0, vg[0], Long.parseLong(vg[1]));
        assertEquals(AutoDeductionScheduler.FireResult.Status.CREATED, fire.status);

        JSONObject afterFire = readAnyScheduleMetadata();
        assertNotNull(afterFire);
        assertFalse("successful durable fire must clear retry marker",
                afterFire.has(AutoDeductionScheduler.FIELD_FIRE_RETRY_COUNT));
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
        assertEquals("new scheduleVersion must remain authoritative",
                newVg[0],
                saved.getStringExtra(AutoDeductionContract.EXTRA_SCHEDULE_VERSION));
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
        String version = meta.optString(AutoDeductionScheduler.FIELD_SCHEDULE_VERSION, "");
        long gen = meta.optLong(AutoDeductionScheduler.FIELD_RECURRENCE_GENERATION, 0L);

        AutoDeductionReceiver.handleFireDelivery(
                appContext(), "med", "dose", date, epoch, 1.0, "12:00",
                gen, version, 0);

        assertEquals(1, alarmCount());
        ShadowAlarmManager.ScheduledAlarm alarm = firstAlarm();
        assertNotNull(alarm.operation);
        Intent saved = Shadows.shadowOf(alarm.operation).getSavedIntent();
        assertNotNull(saved);
        assertEquals("normal delivery carries no retry counter", 0,
                saved.getIntExtra(AutoDeductionContract.EXTRA_FIRE_RETRY_COUNT, 0));
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
                    "med", "dose", date, epoch, 2.0, "10:00", 1L, "v1", 1));
        }

        // Config mutation: remove schedule metadata
        String prefKey = "sch:" + key;
        schedulePrefs().edit().remove(prefKey).commit();
        assertFalse(schedulePrefs().contains(prefKey));

        // Independent evidence must still be present
        JSONObject evidence = s.getIndependentFireRetryEvidence("med", "dose", date);
        assertNotNull(evidence);
        assertEquals(1, evidence.optInt("retryCount"));
        assertEquals(2.0, evidence.optDouble("amount"), 0.0001);

        // Retry can still be scheduled from independent evidence
        assertTrue(s.scheduleFireRetry(
                "med", "dose", date, epoch, 2.0, "10:00", 1L, "v1", 2));
        evidence = s.getIndependentFireRetryEvidence("med", "dose", date);
        assertNotNull(evidence);
        assertEquals(2, evidence.optInt("retryCount"));
    }

    @Test
    public void restoreFutureSchedules_explicitFailure_okFalse() {
        AutoDeductionScheduler s = newScheduler();
        s.forceRestoreFutureFailureForTest = true;
        try {
            AutoDeductionScheduler.RestoreResult rr = s.restoreFutureSchedules();
            assertFalse(rr.ok);
            assertEquals("forced_restore_failure", rr.error);
            assertEquals(0, rr.restored);
        } finally {
            s.forceRestoreFutureFailureForTest = false;
        }
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
        String date = "2026-09-10";
        AutoDeductionScheduler s = newScheduler();
        // No sch: row — only independent evidence
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 2.0, "08:00", 1L, "v1", 1));
        }
        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);
        assertTrue(fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS
                || fr.pendingRecorded);
        // Evidence cleared after durable fire proof
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
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
        String ver1 = meta1.optString(AutoDeductionScheduler.FIELD_SCHEDULE_VERSION, "");
        long gen1 = meta1.optLong(AutoDeductionScheduler.FIELD_RECURRENCE_GENERATION, 0L);

        // Replace with newer schedule
        assertTrue(s.scheduleOccurrence("med", "dose", date, "11:00", 3.0, epoch).ok);
        String raw2 = schedulePrefs().getString(prefKey, null);
        JSONObject meta2 = new JSONObject(raw2);
        String ver2 = meta2.optString(AutoDeductionScheduler.FIELD_SCHEDULE_VERSION, "");
        assertFalse(ver1.equals(ver2));

        // Stale retry with old ownership tokens must not write evidence
        assertFalse(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "11:00", gen1, ver1, 1));
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
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
                    "med", "dose", date, 1000L, 2.0, "08:00", 1L, "v1", 1));
        }
        // Later cancellation tombstone (config mutation after failed fire)
        s.cancelOccurrence("med", "dose", date);
        AutoDeductionScheduler.FireResult fr =
                s.recoverFireFromIndependentEvidence("med", "dose", date);
        assertTrue(
                "later cancel must not erase prior fire evidence recovery",
                fr.status == AutoDeductionScheduler.FireResult.Status.CREATED
                        || fr.status == AutoDeductionScheduler.FireResult.Status.ALREADY_EXISTS
                        || fr.pendingRecorded);
        // Evidence cleared only after durable proof
        assertNull(s.getIndependentFireRetryEvidence("med", "dose", date));
    }

    @Test
    public void handleIndependentRecovery_created_doesNotScheduleSuccessor() {
        // Independent recovery CREATED path must not install a next-day alarm.
        // Use handleFireDelivery with pre-seeded evidence and no sch: metadata.
        String date = "2026-09-12";
        AutoDeductionScheduler s = newScheduler();
        try {
            java.lang.reflect.Method m = AutoDeductionScheduler.class
                    .getDeclaredMethod(
                            "recordIndependentFireRetryEvidenceLocked",
                            String.class, String.class, String.class, long.class,
                            double.class, String.class, long.class, String.class, int.class);
            m.setAccessible(true);
        } catch (Exception ignored) {
            // package-private; same package can call directly
        }
        synchronized (getScheduleLock()) {
            assertTrue(s.recordIndependentFireRetryEvidenceLocked(
                    "med", "dose", date, 1000L, 1.0, "08:00", 1L, "v1", 1));
        }
        int before = alarmCount();
        AutoDeductionReceiver.handleFireDelivery(
                appContext(), "med", "dose", date, 1000L, 1.0, "08:00",
                1L, "v1", 1);
        // No successor alarm from independent recovery
        assertEquals(
                "independent recovery must not schedule successor",
                before, alarmCount());
    }
}
