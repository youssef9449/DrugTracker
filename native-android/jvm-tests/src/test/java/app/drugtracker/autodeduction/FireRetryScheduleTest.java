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
    public void scheduleFireRetry_schedulesSameIdentityAlarmWithRetryExtra() {
        String date = futureCalendarDate(2);
        long epoch = futureEpochMs(date, "12:00");
        AutoDeductionScheduler s = newScheduler();

        assertTrue(s.scheduleFireRetry(
                "med", "dose", date, epoch, 1.0, "12:00", 7L, "ver-1", 1));

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
}
