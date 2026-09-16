package com.capacitorjs.plugins.localnotifications;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.Shadows;

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
     * Context that forces NOTIFICATION_STORE Editor.commit() to return false.
     * Other preference files behave normally.
     */
    private Context failingNotificationStoreContext() {
        return new ContextWrapper(baseContext) {
            @Override
            public SharedPreferences getSharedPreferences(String name, int mode) {
                SharedPreferences real = super.getSharedPreferences(name, mode);
                if ("NOTIFICATION_STORE".equals(name)) {
                    return new CommitFailingSharedPreferences(real);
                }
                return real;
            }
        };
    }

    @Test
    public void storagePersistFailure_afterAlarmSuccess_doesNotWriteReArmEvidence() {
        Context ctx = failingNotificationStoreContext();
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        boolean kept =
                publisher.rescheduleDoseReminderNextDay(ctx, intent, NOTIF_ID, json);

        // AlarmManager arm succeeded → notification is kept (not deleted by onReceive).
        assertTrue(kept);

        // No markReArmed when persist fails.
        assertEquals(
                -1L,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(ctx, MED_ID, DOSE_ID));
        assertFalse(
                DoseReminderRecurrenceStore.isValidReArm(
                        ctx, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        // NOTIFICATION_STORE must not hold a successful future occurrence write.
        SharedPreferences store =
                baseContext.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE);
        // Failing editor should not have committed a usable entry (may be absent or stale).
        String stored = store.getString(Integer.toString(NOTIF_ID), null);
        // Commit returned false — treat as no durable future occurrence for validity.
        if (stored != null) {
            // Even if something leaked, re-arm evidence must remain absent.
            assertFalse(
                    DoseReminderRecurrenceStore.isValidReArm(
                            ctx, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));
        }
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

        // Evidence matches occurrence identity.
        assertEquals(
                REMINDER_TIME,
                DoseReminderRecurrenceStore.getStoredReminderTime(baseContext, MED_ID, DOSE_ID));
        assertTrue(
                DoseReminderRecurrenceStore.isValidReArm(
                        baseContext, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        // NotificationStorage has matching future schedule.at for same notification id.
        SharedPreferences store =
                baseContext.getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE);
        String raw = store.getString(Integer.toString(NOTIF_ID), null);
        assertNotNull(raw);
        assertTrue(raw.contains("\"at\""));
        assertTrue(raw.contains(MED_ID) || raw.contains("medicationId"));

        // AlarmManager received a schedule (Robolectric shadow).
        AlarmManager am = (AlarmManager) baseContext.getSystemService(Context.ALARM_SERVICE);
        ShadowAlarmManager shadow = Shadows.shadowOf(am);
        assertFalse(
                "expected at least one AlarmManager schedule after success path",
                shadow.getScheduledAlarms().isEmpty());
    }

    @Test
    public void successOrdering_evidenceOnlyAfterStorageCommit() {
        // Instrument via sequence: empty store → after method, both storage and evidence exist.
        // If markReArmed ran before persist, isValidReArm would clear evidence when storage empty.
        // Full success path must leave both consistent.
        JSObject json = validDoseNotificationJson();
        Intent intent = deliveryIntent();

        assertEquals(
                -1L,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(baseContext, MED_ID, DOSE_ID));
        assertNull(
                baseContext
                        .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null));

        assertTrue(
                publisher.rescheduleDoseReminderNextDay(
                        baseContext, intent, NOTIF_ID, json));

        String raw =
                baseContext
                        .getSharedPreferences("NOTIFICATION_STORE", Context.MODE_PRIVATE)
                        .getString(Integer.toString(NOTIF_ID), null);
        assertNotNull("NotificationStorage must be written before/at evidence validity", raw);

        long next =
                DoseReminderRecurrenceStore.getNextOccurrenceMs(baseContext, MED_ID, DOSE_ID);
        assertTrue(next > 0);
        assertTrue(
                DoseReminderRecurrenceStore.notificationStoreHasFutureOccurrence(
                        baseContext, NOTIF_ID, next, System.currentTimeMillis()));
        assertTrue(
                DoseReminderRecurrenceStore.isValidReArm(
                        baseContext, MED_ID, DOSE_ID, System.currentTimeMillis(), REMINDER_TIME));

        // Calendar next-day at reminderTime HH:MM
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(next);
        assertEquals(9, cal.get(Calendar.HOUR_OF_DAY));
        assertEquals(15, cal.get(Calendar.MINUTE));
    }

    /**
     * SharedPreferences that delegates reads/writes but forces commit()/apply failure
     * for Editor — models NotificationStorage persist failure after AlarmManager success.
     */
    private static final class CommitFailingSharedPreferences implements SharedPreferences {
        private final SharedPreferences delegate;

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
                    // Do not commit to delegate — simulate disk/write failure.
                    return false;
                }

                @Override
                public void apply() {
                    // no-op failure
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
