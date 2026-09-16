package com.capacitorjs.plugins.localnotifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

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
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Regression: TimedNotificationPublisher.rescheduleDoseReminderNextDay atomicity.
 *
 * <pre>
 * AlarmManager.set* → NotificationStorage persist → markReArmed (only if persist committed)
 * </pre>
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
    private final List<String> atomicityEvents = new ArrayList<>();

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
        atomicityEvents.clear();
        TimedNotificationPublisher.atomicityProbe = atomicityEvents::add;
    }

    @After
    public void tearDown() {
        TimedNotificationPublisher.atomicityProbe = null;
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
     * Context that survives production {@code getApplicationContext()} and forces
     * NOTIFICATION_STORE {@code Editor.commit()} to return false.
     */
    private static final class FailingAppContext extends ContextWrapper {
        final CommitFailingSharedPreferences failingNotificationStore;
        final Context realApp;

        FailingAppContext(Context base) {
            super(base);
            this.realApp = base.getApplicationContext();
            SharedPreferences realStore =
                    realApp.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE);
            this.failingNotificationStore = new CommitFailingSharedPreferences(realStore);
        }

        @Override
        public Context getApplicationContext() {
            // Production DoseReminderRecurrenceStore / some callers use this —
            // must remain the same failing harness, not the real Application.
            return this;
        }

        @Override
        public SharedPreferences getSharedPreferences(String name, int mode) {
            if ("NOTIFICATION_STORE".equals(name)) {
                return failingNotificationStore;
            }
            // Other prefs (including dose_reminder_recurrence) use real app storage.
            return realApp.getSharedPreferences(name, mode);
        }

        @Override
        public Object getSystemService(String name) {
            return realApp.getSystemService(name);
        }
    }

    @Test
    public void storagePersistFailure_afterAlarmSuccess_doesNotWriteReArmEvidence() {
        FailingAppContext ctx = new FailingAppContext(baseContext);
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        boolean kept =
                publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json);

        // Failure path must actually invoke Editor.commit() on the injected store.
        assertTrue(
                "NOTIFICATION_STORE Editor.commit() must be invoked on failing double",
                ctx.failingNotificationStore.commitCalled);

        // AlarmManager arm succeeded → kept (no onReceive delete).
        assertTrue(kept);

        // Probe: alarm scheduled, storage never reported committed, no re-arm evidence.
        assertTrue(atomicityEvents.contains("alarmScheduled"));
        assertFalse(atomicityEvents.contains("notificationStorageCommitted"));
        assertFalse(atomicityEvents.contains("reArmEvidenceCommitted"));

        // No markReArmed when persist fails.
        assertEquals(
                -1L,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID));
        assertFalse(
                DoseReminderRecurrenceStore.isValidReArm(
                        ctx, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        // Real NOTIFICATION_STORE must not have a durable write from the failed commit.
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
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        boolean kept =
                publisher.rescheduleDoseReminderNextDay(
                        baseContext, intent, NOTIF_ID, json);

        assertTrue(kept);

        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(baseContext, MED_ID, DOSE_ID);
        assertTrue(next > System.currentTimeMillis());
        assertEquals(
                REMINDER_TIME,
                DoseReminderRecurrenceStore.getStoredReminderTime(baseContext, MED_ID, DOSE_ID));
        assertTrue(
                DoseReminderRecurrenceStore.isValidReArm(
                        baseContext, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        String raw =
                baseContext
                        .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);
        assertNotNull(raw);
        assertTrue(raw.contains("\"at\""));
    }

    @Test
    public void successOrdering_alarmThenStorageThenReArmEvidence() {
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        assertTrue(
                publisher.rescheduleDoseReminderNextDay(
                        baseContext, intent, NOTIF_ID, json));

        int iAlarm = atomicityEvents.indexOf("alarmScheduled");
        int iStore = atomicityEvents.indexOf("notificationStorageCommitted");
        int iReArm = atomicityEvents.indexOf("reArmEvidenceCommitted");

        if (iAlarm < 0 || iStore < 0 || iReArm < 0) {
            fail("missing probe events: " + atomicityEvents);
        }
        assertTrue(
                "AlarmManager must be recorded before NotificationStorage commit: " + atomicityEvents,
                iAlarm < iStore);
        assertTrue(
                "NotificationStorage commit must be recorded before markReArmed: " + atomicityEvents,
                iStore < iReArm);

        // Final state still consistent with successful ordered path.
        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(baseContext, MED_ID, DOSE_ID);
        assertTrue(next > 0);
        assertTrue(
                DoseReminderRecurrenceStore.notificationStoreHasFutureOccurrence(
                        baseContext, NOTIF_ID, next, System.currentTimeMillis()));
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(next);
        assertEquals(9, cal.get(Calendar.HOUR_OF_DAY));
        assertEquals(15, cal.get(Calendar.MINUTE));
    }

    /**
     * SharedPreferences that records commit() invocation and always returns false
     * without writing through — models NotificationStorage persist failure.
     */
    private static final class CommitFailingSharedPreferences implements SharedPreferences {
        private final SharedPreferences delegate;
        volatile boolean commitCalled;

        CommitFailingSharedPreferences(SharedPreferences delegate) {
            this.delegate = delegate;
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
                    // Do not commit to delegate — simulate write failure.
                    return false;
                }

                @Override
                public void apply() {
                    commitCalled = true;
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
}
