package com.capacitorjs.plugins.localnotifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.AlarmManager;
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

/**
 * Regression: TimedNotificationPublisher.rescheduleDoseReminderNextDay atomicity.
 *
 * <pre>
 * AlarmManager.set* → NotificationStorage persist → markReArmed (only if persist committed)
 * </pre>
 *
 * Ordering is observed via test-only Context/SharedPreferences doubles and
 * Robolectric {@link ShadowAlarmManager} — no production instrumentation.
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
     * instance so production code that calls getApplicationContext().getSharedPreferences
     * still hits the recording/failing doubles.
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
                            /* requireAlarmAlreadyScheduled= */ true);
            this.recurrenceStore =
                    new CommitTrackingSharedPreferences(
                            realApp.getSharedPreferences(
                                    DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE),
                            "reArmEvidenceCommitted",
                            /* failCommit= */ false,
                            /* requireAlarmAlreadyScheduled= */ false);
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
     * Tracks successful (or attempted) commits and appends ordered events.
     * When {@code requireAlarmAlreadyScheduled} is true, records {@code alarmScheduled}
     * first if ShadowAlarmManager already has a schedule — proving AlarmManager ran
     * before this SharedPreferences commit.
     */
    private final class CommitTrackingSharedPreferences implements SharedPreferences {
        private final SharedPreferences delegate;
        private final String successEvent;
        private final boolean failCommit;
        private final boolean requireAlarmAlreadyScheduled;
        volatile boolean commitCalled;

        CommitTrackingSharedPreferences(
                SharedPreferences delegate,
                String successEvent,
                boolean failCommit,
                boolean requireAlarmAlreadyScheduled) {
            this.delegate = delegate;
            this.successEvent = successEvent;
            this.failCommit = failCommit;
            this.requireAlarmAlreadyScheduled = requireAlarmAlreadyScheduled;
        }

        private void recordAlarmIfNeeded() {
            if (!requireAlarmAlreadyScheduled) {
                return;
            }
            if (events.contains("alarmScheduled")) {
                return;
            }
            AlarmManager am = (AlarmManager) baseContext.getSystemService(Context.ALARM_SERVICE);
            ShadowAlarmManager shadow = Shadows.shadowOf(am);
            if (shadow.getScheduledAlarms() != null && !shadow.getScheduledAlarms().isEmpty()) {
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
                    recordAlarmIfNeeded();
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
                    recordAlarmIfNeeded();
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

        // Alarm was scheduled (observed when storage commit was attempted).
        assertTrue(
                "AlarmManager must have scheduled before storage commit attempt: " + events,
                events.contains("alarmScheduled"));
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
                "AlarmManager before NotificationStorage: " + events, iAlarm < iStore);
        assertTrue(
                "NotificationStorage before markReArmed: " + events, iStore < iReArm);

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
}
