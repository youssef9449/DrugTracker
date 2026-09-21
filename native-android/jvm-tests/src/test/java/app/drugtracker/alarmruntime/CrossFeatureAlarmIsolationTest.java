package app.drugtracker.alarmruntime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.shadows.ShadowPendingIntent;

import app.drugtracker.autodeduction.AutoDeductionContract;
import app.drugtracker.autodeduction.AutoDeductionSchedulingAdapter;
import app.drugtracker.criticalstock.CriticalStockAlarmAdapter;
import app.drugtracker.dosereminder.DoseReminderAlarmAdapter;

/**
 * Phase 9 runtime coexistence proof for the three native exact-alarm features.
 *
 * Same medication:
 *   Dose Reminder 08:00
 *   Auto Deduction 08:00
 *   Critical Stock 08:00
 *
 * Each feature must retain an independent native alarm identity, and cancelling
 * one feature must leave the other two alarms untouched.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CrossFeatureAlarmIsolationTest {
    private static final String MEDICATION_ID = "med-phase9";
    private static final String DOSE_ID = "dose-08";
    private static final String DATE = "2100-01-01";
    private static final long TRIGGER_AT = 4_102_473_600_000L;

    @Before
    public void setUp() {
        grantExactAlarmPermission();
        clearFeaturePrefs();
        drainAlarms();
    }

    @After
    public void tearDown() {
        drainAlarms();
        clearFeaturePrefs();
    }

    @Test
    public void schedulesAllThreeFeaturesAtSameTimeWithoutIdentityCollision() {
        AutoDeductionSchedulingAdapter auto =
                new AutoDeductionSchedulingAdapter(context());
        DoseReminderAlarmAdapter dose =
                new DoseReminderAlarmAdapter(context());
        CriticalStockAlarmAdapter critical =
                new CriticalStockAlarmAdapter(context());

        assertTrue(auto.scheduleOccurrence(
                AutoDeductionContract.occurrenceKey(
                        MEDICATION_ID,
                        DOSE_ID,
                        DATE),
                MEDICATION_ID,
                DOSE_ID,
                DATE,
                "08:00",
                1.0,
                TRIGGER_AT,
                1L,
                null).ok);

        assertTrue(dose.scheduleOccurrence(
                MEDICATION_ID,
                DOSE_ID,
                "08:00",
                1.0,
                "Phase 9 Medicine",
                "قرص",
                true,
                TRIGGER_AT,
                null).ok);

        assertTrue(critical.schedule(
                MEDICATION_ID,
                "Phase 9 Medicine",
                TRIGGER_AT,
                "قرص",
                "Critical title",
                "Critical body",
                null).ok);

        assertEquals(3, scheduledAlarms().size());

        Set<String> identities = scheduledIdentities();
        assertEquals("three independent full identities must be armed", 3, identities.size());

        Set<String> pendingIntentIdentities = scheduledPendingIntentIdentities();
        assertEquals(
                "three independent PendingIntent identity tuples must be armed",
                3,
                pendingIntentIdentities.size());
        assertTrue(pendingIntentIdentities.stream().anyMatch(
                value -> value.contains(
                        AutoDeductionContract.ACTION_AUTO_DEDUCTION
                                + "|AutoDeductionReceiver|"
                )));
        assertTrue(pendingIntentIdentities.stream().anyMatch(
                value -> value.contains(
                        DoseReminderAlarmAdapter.ACTION_DOSE_REMINDER
                                + "|DoseReminderAlarmReceiver|"
                )));
        assertTrue(pendingIntentIdentities.stream().anyMatch(
                value -> value.contains(
                        CriticalStockAlarmAdapter.ACTION_CRITICAL_STOCK
                                + "|CriticalStockAlarmReceiver|"
                )));
        assertTrue(identities.contains(
                AutoDeductionContract.occurrenceUri(
                        MEDICATION_ID, DOSE_ID, DATE).toString()));
        assertTrue(identities.contains(
                DoseReminderAlarmAdapter.occurrenceUri(
                        MEDICATION_ID, DOSE_ID)));
        assertTrue(identities.contains(
                CriticalStockAlarmAdapter.occurrenceUri(
                        MEDICATION_ID)));
    }

    @Test
    public void cancellingDoseLeavesAutoAndCriticalArmed() {
        scheduleAllThree();

        assertTrue(doseAdapter().cancelOccurrence(MEDICATION_ID, DOSE_ID).isOk());
        assertEquals(2, scheduledAlarms().size());

        Set<String> remaining = scheduledIdentities();
        assertTrue(remaining.contains(
                AutoDeductionContract.occurrenceUri(
                        MEDICATION_ID, DOSE_ID, DATE).toString()));
        assertTrue(remaining.contains(
                CriticalStockAlarmAdapter.occurrenceUri(
                        MEDICATION_ID)));
        assertTrue(!remaining.contains(
                DoseReminderAlarmAdapter.occurrenceUri(
                        MEDICATION_ID, DOSE_ID)));
    }

    @Test
    public void cancellingCriticalLeavesDoseAndAutoArmed() {
        scheduleAllThree();

        assertTrue(criticalAdapter().cancel(MEDICATION_ID).isOk());
        assertEquals(2, scheduledAlarms().size());

        Set<String> remaining = scheduledIdentities();
        assertTrue(remaining.contains(
                AutoDeductionContract.occurrenceUri(
                        MEDICATION_ID, DOSE_ID, DATE).toString()));
        assertTrue(remaining.contains(
                DoseReminderAlarmAdapter.occurrenceUri(
                        MEDICATION_ID, DOSE_ID)));
        assertTrue(!remaining.contains(
                CriticalStockAlarmAdapter.occurrenceUri(
                        MEDICATION_ID)));
    }

    @Test
    public void cancellingAutoLeavesDoseAndCriticalArmed() {
        scheduleAllThree();

        assertTrue(autoAdapter().cancelOccurrence(
                MEDICATION_ID, DOSE_ID, DATE).isOk());
        assertEquals(2, scheduledAlarms().size());

        Set<String> remaining = scheduledIdentities();
        assertTrue(remaining.contains(
                DoseReminderAlarmAdapter.occurrenceUri(
                        MEDICATION_ID, DOSE_ID)));
        assertTrue(remaining.contains(
                CriticalStockAlarmAdapter.occurrenceUri(
                        MEDICATION_ID)));
        assertTrue(!remaining.contains(
                AutoDeductionContract.occurrenceUri(
                        MEDICATION_ID, DOSE_ID, DATE).toString()));
    }

    private static AutoDeductionSchedulingAdapter autoAdapter() {
        return new AutoDeductionSchedulingAdapter(context());
    }

    private static DoseReminderAlarmAdapter doseAdapter() {
        return new DoseReminderAlarmAdapter(context());
    }

    private static CriticalStockAlarmAdapter criticalAdapter() {
        return new CriticalStockAlarmAdapter(context());
    }

    private static void scheduleAllThree() {
        assertTrue(autoAdapter().scheduleOccurrence(
                AutoDeductionContract.occurrenceKey(
                        MEDICATION_ID,
                        DOSE_ID,
                        DATE),
                MEDICATION_ID, DOSE_ID, DATE, "08:00", 1.0,
                TRIGGER_AT, 1L, null).ok);
        assertTrue(doseAdapter().scheduleOccurrence(
                MEDICATION_ID, DOSE_ID, "08:00", 1.0,
                "Phase 9 Medicine", "قرص", true,
                TRIGGER_AT, null).ok);
        assertTrue(criticalAdapter().schedule(
                MEDICATION_ID, "Phase 9 Medicine", TRIGGER_AT, "قرص",
                "Critical title", "Critical body", null).ok);
        assertEquals("all three features must arm at the exact same epoch", 3, scheduledAlarms().size());
        for (ShadowAlarmManager.ScheduledAlarm alarm : scheduledAlarms()) {
            assertEquals("all three features must use the same trigger time",
                    TRIGGER_AT, alarm.triggerAtTime);
        }
    }

    private static Context context() {
        return org.robolectric.RuntimeEnvironment.getApplication();
    }

    private static void grantExactAlarmPermission() {
        AlarmManager manager =
                (AlarmManager) context().getSystemService(Context.ALARM_SERVICE);
        assertNotNull(manager);
        Shadows.shadowOf(manager).setCanScheduleExactAlarms(true);
    }

    private static List<ShadowAlarmManager.ScheduledAlarm> scheduledAlarms() {
        return new ArrayList<>(
                Shadows.shadowOf(alarmManager()).getScheduledAlarms());
    }

    private static Set<String> scheduledIdentities() {
        Set<String> result = new HashSet<>();
        for (ShadowAlarmManager.ScheduledAlarm alarm : scheduledAlarms()) {
            if (alarm.operation == null) continue;
            ShadowPendingIntent pending =
                    Shadows.shadowOf(alarm.operation);
            Intent saved = pending.getSavedIntent();
            if (saved != null && saved.getData() != null) {
                result.add(saved.getData().toString());
            }
        }
        return result;
    }

    private static Set<String> scheduledPendingIntentIdentities() {
        Set<String> result = new HashSet<>();
        for (ShadowAlarmManager.ScheduledAlarm alarm : scheduledAlarms()) {
            if (alarm.operation == null) continue;
            ShadowPendingIntent pending =
                    Shadows.shadowOf(alarm.operation);
            Intent saved = pending.getSavedIntent();
            assertNotNull("scheduled alarm must retain PendingIntent intent", saved);
            assertNotNull("scheduled alarm must retain PendingIntent component", saved.getComponent());
            assertNotNull("scheduled alarm must retain PendingIntent action", saved.getAction());
            assertNotNull("scheduled alarm must retain PendingIntent data URI", saved.getData());

            result.add(
                    pending.getRequestCode()
                            + "|"
                            + saved.getAction()
                            + "|"
                            + saved.getComponent().getClassName()
                            + "|"
                            + saved.getData().toString());
        }
        return result;
    }

    private static AlarmManager alarmManager() {
        return (AlarmManager) context().getSystemService(Context.ALARM_SERVICE);
    }

    private static void drainAlarms() {
        for (ShadowAlarmManager.ScheduledAlarm alarm : scheduledAlarms()) {
            if (alarm.operation != null) {
                alarmManager().cancel(alarm.operation);
            }
        }
        assertEquals(0, scheduledAlarms().size());
    }

    private static void clearFeaturePrefs() {
        clear(
                AutoDeductionContract.PREFS_SCHEDULES,
                AutoDeductionContract.PREFS_CANCELLED,
                AutoDeductionContract.PREFS_ORDERING,
                DoseReminderAlarmAdapter.PREFS_SCHEDULES,
                DoseReminderAlarmAdapter.PREFS_CANCELLED,
                DoseReminderAlarmAdapter.PREFS_ORDERING,
                "drugtracker_critical_stock_alarm_schedules_v1",
                "drugtracker_critical_stock_alarm_cancelled_v1",
                "drugtracker_critical_stock_alarm_ordering_v1");
    }

    private static void clear(String... names) {
        for (String name : names) {
            context()
                    .getSharedPreferences(name, Context.MODE_PRIVATE)
                    .edit()
                    .clear()
                    .commit();
        }
    }
}
