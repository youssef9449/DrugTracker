package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.appContext;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.futureEpochMs;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.newScheduler;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.readAuthGeneration;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.seedAutoStock;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schedulePrefs;
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

/** FireRetrySchedulingTest — fire-retry/recovery behavior split (#490). */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class FireRetrySchedulingTest extends FireRetryFixtureSupport {

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