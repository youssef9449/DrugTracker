package app.drugtracker.autodeduction;

import static app.drugtracker.autodeduction.AutoDeductionTestSupport.appContext;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.clearAllDurableState;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.futureCalendarDate;
import static app.drugtracker.autodeduction.AutoDeductionTestSupport.schedulePrefs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import app.drugtracker.alarmruntime.ExactAlarmContract;

import android.app.AlarmManager;
import android.content.Context;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.shadows.ShadowPendingIntent;

import java.util.List;

/**
 * Shared fixture for the fire-retry/recovery behavior split (#490): the
 * Robolectric alarm-queue helpers previously copied across the split files.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public abstract class FireRetryFixtureSupport {

    protected static String localDateOffset(int days) {
        return AutoDeductionTestSupport.futureCalendarDate(days);
    }


    @Before
    public void setUp() {
        clearAllDurableState();
        drainAlarms();
    }

    @After
    public void tearDown() {
    }

    protected static void drainAlarms() {
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

    protected static AlarmManager alarmManager() {
        return (AlarmManager) appContext().getSystemService(Context.ALARM_SERVICE);
    }

    protected static int alarmCount() {
        return Shadows.shadowOf(alarmManager()).getScheduledAlarms().size();
    }

    protected static ShadowAlarmManager.ScheduledAlarm firstAlarm() {
        List<ShadowAlarmManager.ScheduledAlarm> alarms =
                Shadows.shadowOf(alarmManager()).getScheduledAlarms();
        return alarms.isEmpty() ? null : alarms.get(0);
    }

    /**
     * Read the (single) schedule metadata payload written by scheduleOccurrence
     * so tests can pass the REAL ownership tokens to the receiver path.
     */
    protected static JSONObject readAnyScheduleMetadata() throws Exception {
        for (java.util.Map.Entry<String, ?> e : schedulePrefs().getAll().entrySet()) {
            Object v = e.getValue();
            if (v instanceof String && e.getKey().startsWith("sch:")) {
                return new JSONObject((String) v);
            }
        }
        return null;
    }

    protected static String[] activeVersionAndGen(
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
        long generation = AutoDeductionTestSupport.appContext()
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

}
