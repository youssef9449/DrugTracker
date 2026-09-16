package com.capacitorjs.plugins.localnotifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.shadows.ShadowPendingIntent;

/**
 * Regression: TimedNotificationPublisher.rescheduleDoseReminderNextDay atomicity.
 *
 * <pre>
 * AlarmManager.set* → NotificationStorage persist → markReArmed (only if persist committed)
 * </pre>
 *
 * Ordering is observed via test-only Context/SharedPreferences doubles and
 * Robolectric {@link ShadowAlarmManager} for the <em>specific</em> {@link #NOTIF_ID}
 * — no production instrumentation.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class TimedNotificationPublisherAtomicityTest {

    private static final int NOTIF_ID = 6_000_101;
    private static final String MED_ID = "med-atom";
    private static final String DOSE_ID = "d1";
    private static final String REMINDER_TIME = "09:15";

    private Context baseContext;
    private TimedNotificationPublisher publisher;
    private final List<String> events = new ArrayList<>();

    @Before
    public void setUp() {
        baseContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        clearShadowAlarms(baseContext);
        baseContext
                .getSharedPreferences(DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        baseContext
                .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        publisher = new TimedNotificationPublisher();
        events.clear();
        assertFalse(
                "setUp must leave no scheduled alarm for NOTIF_ID",
                hasScheduledAlarmForNotifId(baseContext, NOTIF_ID));
    }

    /** Drain all ShadowAlarmManager schedules so tests do not leak across cases. */
    private static void clearShadowAlarms(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        ShadowAlarmManager shadow = Shadows.shadowOf(am);
        // Deprecated poll removes and deschedules until empty — isolates each test.
        while (shadow.getNextScheduledAlarm() != null) {
            // drain
        }
    }

    /**
     * True when ShadowAlarmManager holds a schedule whose PendingIntent request code
     * is {@code notifId} (the stable dose-alarm id used by production).
     */
    private static boolean hasScheduledAlarmForNotifId(Context context, int notifId) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        ShadowAlarmManager shadow = Shadows.shadowOf(am);
        List<ShadowAlarmManager.ScheduledAlarm> alarms = shadow.getScheduledAlarms();
        if (alarms == null || alarms.isEmpty()) {
            return false;
        }
        for (ShadowAlarmManager.ScheduledAlarm alarm : alarms) {
            PendingIntent operation = alarm.operation;
            if (operation == null) {
                continue;
            }
            ShadowPendingIntent spi = Shadows.shadowOf(operation);
            if (spi.getRequestCode() == notifId) {
                return true;
            }
        }
        return false;
    }

    private JSObject validDoseNotificationJson() {
        JSObject extra = new JSObject();
        extra.put("doseRecurring", true);
        extra.put("reminderTime", REMINDER_TIME);
        extra.put("medicationId", MED_ID);
        extra.put("doseId", DOSE_ID);
        JSObject schedule = new JSObject();
        schedule.put("at", "2020-01-01T09:15:00.000Z");
        JSObject root = new JSObject();
        root.put("extra", extra);
        root.put("schedule", schedule);
        root.put("id", NOTIF_ID);
        return root;
    }

    private Intent deliveryIntent() {
        Intent intent = new Intent(baseContext, TimedNotificationPublisher.class);
        intent.putExtra(LocalNotificationManager.NOTIFICATION_INTENT_KEY, NOTIF_ID);
        return intent;
    }

    /**
     * Application-equivalent context: {@link #getApplicationContext()} returns this
     * instance so production getApplicationContext().getSharedPreferences still hits
     * the recording/failing doubles.
     */
    private final class ObservingAppContext extends ContextWrapper {
        final CommitTrackingSharedPreferences notificationStore;
        final CommitTrackingSharedPreferences recurrenceStore;
        final Context realApp;
        final boolean failNotificationStoreCommit;

        ObservingAppContext(Context base, boolean failNotificationStoreCommit) {
            super(base);
            this.realApp = base.getApplicationContext();
            this.failNotificationStoreCommit = failNotificationStoreCommit;
            this.notificationStore =
                    new CommitTrackingSharedPreferences(
                            realApp.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE),
                            "notificationStorageCommitted",
                            failNotificationStoreCommit,
                            /* observeSpecificAlarmBeforeCommit= */ true);
            this.recurrenceStore =
                    new CommitTrackingSharedPreferences(
                            realApp.getSharedPreferences(
                                    DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE),
                            "reArmEvidenceCommitted",
                            /* failCommit= */ false,
                            /* observeSpecificAlarmBeforeCommit= */ false);
        }

        @Override
        public Context getApplicationContext() {
            return this;
        }

        @Override
        public SharedPreferences getSharedPreferences(String name, int mode) {
            if ("NOTIFICATION_STORE".equals(name)) {
                return notificationStore;
            }
            if (DoseReminderRecurrenceStore.PREFS_NAME.equals(name)) {
                return recurrenceStore;
            }
            return realApp.getSharedPreferences(name, mode);
        }

        @Override
        public Object getSystemService(String name) {
            return realApp.getSystemService(name);
        }
    }

    /**
     * Tracks commits and appends ordered events. When observing the notification
     * store, records {@code alarmScheduled} only if ShadowAlarmManager already
     * holds a schedule for {@link #NOTIF_ID} — proving the current test's alarm
     * was armed before this SharedPreferences commit.
     */
    private final class CommitTrackingSharedPreferences implements SharedPreferences {
        private final SharedPreferences delegate;
        private final String successEvent;
        private final boolean failCommit;
        private final boolean observeSpecificAlarmBeforeCommit;
        volatile boolean commitCalled;

        CommitTrackingSharedPreferences(
                SharedPreferences delegate,
                String successEvent,
                boolean failCommit,
                boolean observeSpecificAlarmBeforeCommit) {
            this.delegate = delegate;
            this.successEvent = successEvent;
            this.failCommit = failCommit;
            this.observeSpecificAlarmBeforeCommit = observeSpecificAlarmBeforeCommit;
        }

        private void recordSpecificAlarmIfPresent() {
            if (!observeSpecificAlarmBeforeCommit) {
                return;
            }
            if (events.contains("alarmScheduled")) {
                return;
            }
            if (hasScheduledAlarmForNotifId(baseContext, NOTIF_ID)) {
                events.add("alarmScheduled");
            }
        }

        @Override
        public Map<String, ?> getAll() {
            return delegate.getAll();
        }

        @Override
        public String getString(String key, String defValue) {
            return delegate.getString(key, defValue);
        }

        @Override
        public java.util.Set<String> getStringSet(String key, java.util.Set<String> defValues) {
            return delegate.getStringSet(key, defValues);
        }

        @Override
        public int getInt(String key, int defValue) {
            return delegate.getInt(key, defValue);
        }

        @Override
        public long getLong(String key, long defValue) {
            return delegate.getLong(key, defValue);
        }

        @Override
        public float getFloat(String key, float defValue) {
            return delegate.getFloat(key, defValue);
        }

        @Override
        public boolean getBoolean(String key, boolean defValue) {
            return delegate.getBoolean(key, defValue);
        }

        @Override
        public boolean contains(String key) {
            return delegate.contains(key);
        }

        @Override
        public Editor edit() {
            final Editor real = delegate.edit();
            return new Editor() {
                @Override
                public Editor putString(String key, String value) {
                    real.putString(key, value);
                    return this;
                }

                @Override
                public Editor putStringSet(String key, java.util.Set<String> values) {
                    real.putStringSet(key, values);
                    return this;
                }

                @Override
                public Editor putInt(String key, int value) {
                    real.putInt(key, value);
                    return this;
                }

                @Override
                public Editor putLong(String key, long value) {
                    real.putLong(key, value);
                    return this;
                }

                @Override
                public Editor putFloat(String key, float value) {
                    real.putFloat(key, value);
                    return this;
                }

                @Override
                public Editor putBoolean(String key, boolean value) {
                    real.putBoolean(key, value);
                    return this;
                }

                @Override
                public Editor remove(String key) {
                    real.remove(key);
                    return this;
                }

                @Override
                public Editor clear() {
                    real.clear();
                    return this;
                }

                @Override
                public boolean commit() {
                    commitCalled = true;
                    // Observe AlarmManager state *before* recording storage success.
                    recordSpecificAlarmIfPresent();
                    if (failCommit) {
                        return false;
                    }
                    boolean ok = real.commit();
                    if (ok) {
                        events.add(successEvent);
                    }
                    return ok;
                }

                @Override
                public void apply() {
                    commitCalled = true;
                    recordSpecificAlarmIfPresent();
                    if (!failCommit) {
                        real.apply();
                        events.add(successEvent);
                    }
                }
            };
        }

        @Override
        public void registerOnSharedPreferenceChangeListener(
                OnSharedPreferenceChangeListener listener) {
            delegate.registerOnSharedPreferenceChangeListener(listener);
        }

        @Override
        public void unregisterOnSharedPreferenceChangeListener(
                OnSharedPreferenceChangeListener listener) {
            delegate.unregisterOnSharedPreferenceChangeListener(listener);
        }
    }

    @Test
    public void storagePersistFailure_afterAlarmSuccess_doesNotWriteReArmEvidence() {
        ObservingAppContext ctx = new ObservingAppContext(baseContext, /* fail= */ true);
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        boolean kept =
                publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json);

        assertTrue(
                "NOTIFICATION_STORE Editor.commit() must be invoked on failing double",
                ctx.notificationStore.commitCalled);

        assertTrue("AlarmManager success must keep the notification", kept);

        assertTrue(
                "specific NOTIF_ID must be scheduled before storage commit attempt: " + events,
                events.contains("alarmScheduled"));
        assertTrue(
                "ShadowAlarmManager must hold NOTIF_ID after AM success",
                hasScheduledAlarmForNotifId(baseContext, NOTIF_ID));
        assertFalse(events.contains("notificationStorageCommitted"));
        assertFalse(events.contains("reArmEvidenceCommitted"));
        assertFalse(
                "recurrence store must not be written on storage failure",
                ctx.recurrenceStore.commitCalled);

        assertEquals(
                -1L,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID));
        assertFalse(
                DoseReminderRecurrenceStore.isValidReArm(
                        ctx, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        String stored =
                baseContext
                        .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);
        assertTrue(
                "failed commit must not leave durable NOTIFICATION_STORE entry",
                stored == null || stored.isEmpty());
    }

    @Test
    public void alarmSuccess_storageSuccess_writesMatchingReArmEvidence() {
        ObservingAppContext ctx = new ObservingAppContext(baseContext, /* fail= */ false);
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        boolean kept =
                publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json);

        assertTrue(kept);
        assertTrue(ctx.notificationStore.commitCalled);
        assertTrue(ctx.recurrenceStore.commitCalled);
        assertTrue(hasScheduledAlarmForNotifId(baseContext, NOTIF_ID));

        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID);
        assertTrue(next > System.currentTimeMillis());
        assertEquals(
                REMINDER_TIME,
                DoseReminderRecurrenceStore.getStoredReminderTime(ctx, MED_ID, DOSE_ID));
        assertTrue(
                DoseReminderRecurrenceStore.isValidReArm(
                        ctx, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        String raw =
                ctx.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);
        assertNotNull(raw);
        assertTrue(raw.contains("\"at\""));
    }

    @Test
    public void successOrdering_alarmThenStorageThenReArmEvidence() {
        ObservingAppContext ctx = new ObservingAppContext(baseContext, /* fail= */ false);
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        assertTrue(publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json));

        int iAlarm = events.indexOf("alarmScheduled");
        int iStore = events.indexOf("notificationStorageCommitted");
        int iReArm = events.indexOf("reArmEvidenceCommitted");
        if (iAlarm < 0 || iStore < 0 || iReArm < 0) {
            fail("missing ordered events: " + events);
        }
        assertTrue(
                "specific NOTIF_ID alarm before NotificationStorage: " + events,
                iAlarm < iStore);
        assertTrue(
                "NotificationStorage before markReArmed: " + events, iStore < iReArm);
        assertTrue(hasScheduledAlarmForNotifId(baseContext, NOTIF_ID));

        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID);
        assertTrue(next > 0);
        assertTrue(
                DoseReminderRecurrenceStore.notificationStoreHasFutureOccurrence(
                        ctx, NOTIF_ID, next, System.currentTimeMillis()));
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(next);
        assertEquals(9, cal.get(Calendar.HOUR_OF_DAY));
        assertEquals(15, cal.get(Calendar.MINUTE));
    }


    /**
     * Delivery without open/action: next occurrence is calendar D+1 only.
     * Dismissing the shade does not re-enter onReceive; this asserts the
     * observable successor identity produced by rescheduleDoseReminderNextDay.
     */
    @Test
    public void deliveryWithoutOpen_schedulesOnlyNextCalendarDaySuccessor() {
        ObservingAppContext ctx = new ObservingAppContext(baseContext, /* fail= */ false);
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        long before = System.currentTimeMillis();
        assertTrue(publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json));

        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID);
        assertTrue(next > before);

        Calendar expected = Calendar.getInstance();
        expected.add(Calendar.DAY_OF_MONTH, 1);
        expected.set(Calendar.HOUR_OF_DAY, 9);
        expected.set(Calendar.MINUTE, 15);
        expected.set(Calendar.SECOND, 0);
        expected.set(Calendar.MILLISECOND, 0);

        Calendar actual = Calendar.getInstance();
        actual.setTimeInMillis(next);
        assertEquals(expected.get(Calendar.YEAR), actual.get(Calendar.YEAR));
        assertEquals(expected.get(Calendar.DAY_OF_YEAR), actual.get(Calendar.DAY_OF_YEAR));
        assertEquals(9, actual.get(Calendar.HOUR_OF_DAY));
        assertEquals(15, actual.get(Calendar.MINUTE));

        assertTrue(hasScheduledAlarmForNotifId(baseContext, NOTIF_ID));
        AlarmManager am = (AlarmManager) baseContext.getSystemService(Context.ALARM_SERVICE);
        int matching = 0;
        for (ShadowAlarmManager.ScheduledAlarm alarm :
                Shadows.shadowOf(am).getScheduledAlarms()) {
            if (alarm.operation != null
                    && Shadows.shadowOf(alarm.operation).getRequestCode() == NOTIF_ID) {
                matching++;
                assertEquals(next, alarm.triggerAtTime);
            }
        }
        assertEquals(1, matching);
    }

    /**
     * Second delivery-path call for the same stable id keeps a single D+1 arm
     * (FLAG_CANCEL_CURRENT) — never a same-day duplicate alarm.
     */
    @Test
    public void repeatedDeliveryPath_doesNotCreateSameDayDuplicate() {
        ObservingAppContext ctx = new ObservingAppContext(baseContext, /* fail= */ false);
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        assertTrue(publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json));
        long firstNext =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID);
        String firstAt =
                ctx.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);
        assertNotNull(firstAt);

        assertTrue(publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json));
        long secondNext =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID);
        String secondAt =
                ctx.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);

        assertEquals(firstNext, secondNext);
        assertNotNull(secondAt);
        // Same D+1 identity persisted (schedule.at still future successor).
        assertTrue(secondAt.contains("\"at\""));

        AlarmManager am = (AlarmManager) baseContext.getSystemService(Context.ALARM_SERVICE);
        int matching = 0;
        Calendar expectedNextDay = Calendar.getInstance();
        expectedNextDay.add(Calendar.DAY_OF_MONTH, 1);
        expectedNextDay.set(Calendar.HOUR_OF_DAY, 9);
        expectedNextDay.set(Calendar.MINUTE, 15);
        expectedNextDay.set(Calendar.SECOND, 0);
        expectedNextDay.set(Calendar.MILLISECOND, 0);
        for (ShadowAlarmManager.ScheduledAlarm alarm :
                Shadows.shadowOf(am).getScheduledAlarms()) {
            if (alarm.operation != null
                    && Shadows.shadowOf(alarm.operation).getRequestCode() == NOTIF_ID) {
                matching++;
                assertEquals(firstNext, alarm.triggerAtTime);
                Calendar scheduled = Calendar.getInstance();
                scheduled.setTimeInMillis(alarm.triggerAtTime);
                assertEquals(expectedNextDay.get(Calendar.YEAR), scheduled.get(Calendar.YEAR));
                assertEquals(
                        expectedNextDay.get(Calendar.DAY_OF_YEAR),
                        scheduled.get(Calendar.DAY_OF_YEAR));
                assertEquals(
                        expectedNextDay.get(Calendar.HOUR_OF_DAY),
                        scheduled.get(Calendar.HOUR_OF_DAY));
                assertEquals(
                        expectedNextDay.get(Calendar.MINUTE), scheduled.get(Calendar.MINUTE));
            }
        }
        assertEquals(1, matching);
    }

    /**
     * Full production entry point: onReceive → dose path → single D+1 successor.
     * Does not call rescheduleDoseReminderNextDay directly.
     */
    @Test
    public void onReceive_doseDelivery_armsOnlyNextDaySuccessorAndEvidence() throws Exception {
        // Seed NOTIFICATION_STORE as Capacitor would before the alarm fires.
        JSObject json = validDoseNotificationJson();
        baseContext
                .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                .edit()
                .putString(Integer.toString(NOTIF_ID), json.toString())
                .commit();

        Intent intent = deliveryIntent();
        // Parcelable Notification required by onReceive before notify().
        android.app.Notification tray = new android.app.Notification();
        intent.putExtra(TimedNotificationPublisher.NOTIFICATION_KEY, tray);

        publisher.onReceive(baseContext, intent);

        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(baseContext, MED_ID, DOSE_ID);
        assertTrue(next > System.currentTimeMillis());

        Calendar actual = Calendar.getInstance();
        actual.setTimeInMillis(next);
        Calendar expected = Calendar.getInstance();
        expected.add(Calendar.DAY_OF_MONTH, 1);
        assertEquals(expected.get(Calendar.YEAR), actual.get(Calendar.YEAR));
        assertEquals(expected.get(Calendar.DAY_OF_YEAR), actual.get(Calendar.DAY_OF_YEAR));
        assertEquals(9, actual.get(Calendar.HOUR_OF_DAY));
        assertEquals(15, actual.get(Calendar.MINUTE));

        assertTrue(
                DoseReminderRecurrenceStore.isValidReArm(
                        baseContext, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        String stored =
                baseContext
                        .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);
        assertNotNull("NOTIFICATION_STORE must keep future successor schedule.at", stored);
        assertTrue(stored.contains("\"at\""));
        // Must not have been deleted (kept=true after dose re-arm).
        assertTrue(hasScheduledAlarmForNotifId(baseContext, NOTIF_ID));

        AlarmManager am = (AlarmManager) baseContext.getSystemService(Context.ALARM_SERVICE);
        int matching = 0;
        for (ShadowAlarmManager.ScheduledAlarm alarm :
                Shadows.shadowOf(am).getScheduledAlarms()) {
            if (alarm.operation != null
                    && Shadows.shadowOf(alarm.operation).getRequestCode() == NOTIF_ID) {
                matching++;
                assertEquals(next, alarm.triggerAtTime);
            }
        }
        assertEquals(1, matching);
    }

}
