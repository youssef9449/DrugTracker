package app.drugtracker.dosereminder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import com.capacitorjs.plugins.localnotifications.DoseReminderRecurrenceStore;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Occurrence-scoped delivery/re-arm evidence.
 * Valid only when config matches AND NOTIFICATION_STORE still has the future occurrence.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class DoseReminderRecurrenceStoreTest {

    private Context context;
    private static final int NOTIF_ID = 6_000_042;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences(DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        context.getSharedPreferences(
                        DoseReminderRecurrenceStore.NOTIFICATION_STORE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
    }

    private long nextDayAt(String hhmm) {
        String[] p = hhmm.split(":");
        Calendar cal = Calendar.getInstance();
        cal.add(Calendar.DAY_OF_MONTH, 1);
        cal.set(Calendar.HOUR_OF_DAY, Integer.parseInt(p[0]));
        cal.set(Calendar.MINUTE, Integer.parseInt(p[1]));
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    private void seedNotificationStore(int id, long atMs) {
        SimpleDateFormat iso =
                new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
        String json =
                "{\"id\":"
                        + id
                        + ",\"schedule\":{\"at\":\""
                        + iso.format(new Date(atMs))
                        + "\"}}";
        context.getSharedPreferences(
                        DoseReminderRecurrenceStore.NOTIFICATION_STORE_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(Integer.toString(id), json)
                .commit();
    }

    @Test
    public void A_matchingEvidence_validWhenStoragePresent() {
        long next = nextDayAt("09:00");
        seedNotificationStore(NOTIF_ID, next);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-a", "d1", next, "09:00", NOTIF_ID);
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis(), "09:00"));
        assertEquals(next, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-a", "d1"));
    }

    @Test
    public void B_configMismatch_invalid() {
        long next = nextDayAt("09:00");
        seedNotificationStore(NOTIF_ID, next);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-a", "d1", next, "09:00", NOTIF_ID);
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis(), "10:00"));
    }

    @Test
    public void C_expiredOccurrence_invalidAndCleared() {
        Calendar cal = Calendar.getInstance();
        cal.add(Calendar.HOUR_OF_DAY, -2);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long past = cal.getTimeInMillis();
        String hhmm =
                String.format(
                        Locale.US,
                        "%02d:%02d",
                        cal.get(Calendar.HOUR_OF_DAY),
                        cal.get(Calendar.MINUTE));
        seedNotificationStore(NOTIF_ID, past);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-e", "d1", past, hhmm, NOTIF_ID);
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-e", "d1", System.currentTimeMillis(), hhmm));
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-e", "d1"));
    }

    @Test
    public void D_processRestart_matchingStillValid() {
        long next = nextDayAt("08:30");
        seedNotificationStore(NOTIF_ID, next);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-b", "morning", next, "08:30", NOTIF_ID);
        Context again = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                again, "med-b", "morning", System.currentTimeMillis(), "08:30"));
    }

    @Test
    public void E_siblingIsolation() {
        long next1 = nextDayAt("09:00");
        long next2 = nextDayAt("21:00");
        seedNotificationStore(NOTIF_ID, next1);
        seedNotificationStore(NOTIF_ID + 1, next2);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-m", "d1", next1, "09:00", NOTIF_ID);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-m", "d2", next2, "21:00", NOTIF_ID + 1);
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-m", "d1", System.currentTimeMillis(), "09:00"));
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-m", "d1", System.currentTimeMillis(), "21:00"));
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-m", "d2", System.currentTimeMillis(), "21:00"));
        assertNotEquals(
                DoseReminderRecurrenceStore.storeKey("med-m", "d1"),
                DoseReminderRecurrenceStore.storeKey("med-m", "d2"));
    }

    @Test
    public void F_cancelClearsEvidence() {
        long next = nextDayAt("09:00");
        seedNotificationStore(NOTIF_ID, next);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-c", "d1", next, "09:00", NOTIF_ID);
        DoseReminderRecurrenceStore.clear(context, "med-c", "d1");
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-c", "d1", System.currentTimeMillis(), "09:00"));
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-c", "d1"));
    }

    @Test
    public void G_signatureTimeChange_oldEvidenceDoesNotValidateNewTime() {
        long next = nextDayAt("09:00");
        seedNotificationStore(NOTIF_ID, next);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-g", "d1", next, "09:00", NOTIF_ID);
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-g", "d1", System.currentTimeMillis(), "11:00"));
    }

    @Test
    public void J_staleEvidence_withoutNotificationStore_invalidAndCleared() {
        // Alarm/storage wiped; SharedPreferences evidence alone must not stay valid.
        long next = nextDayAt("09:00");
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-stale", "d1", next, "09:00", NOTIF_ID);
        // No seedNotificationStore — storage empty.
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-stale", "d1", System.currentTimeMillis(), "09:00"));
        assertEquals(
                -1L,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-stale", "d1"));
    }

    @Test
    public void J2_staleEvidence_storageAtMismatch_invalid() {
        long next = nextDayAt("09:00");
        long other = nextDayAt("15:00");
        seedNotificationStore(NOTIF_ID, other);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-mis", "d1", next, "09:00", NOTIF_ID);
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-mis", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void K_legacyLongValue_notValidAndRemoved() {
        String key = DoseReminderRecurrenceStore.storeKey("med-legacy-long", "d1");
        SharedPreferences prefs =
                context.getSharedPreferences(
                        DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putLong(key, System.currentTimeMillis() + 86_400_000L).commit();
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-legacy-long", "d1", System.currentTimeMillis(), "09:00"));
        assertFalse(prefs.contains(key));
        // Second read must not re-fail on same key.
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-legacy-long", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void L_exactOccurrenceIdentity_hhmmMustMatchNextMs() {
        long next = nextDayAt("09:00");
        // Force inconsistent mark: nextDayAt 09:00 but claim 10:00 — mark must reject.
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-bad", "d1", next, "10:00", NOTIF_ID);
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-bad", "d1"));
    }

    @Test
    public void L2_nextCalendarDateUsedInValidation() {
        long next = nextDayAt("14:00");
        seedNotificationStore(NOTIF_ID, next);
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-date", "d1", next, "14:00", NOTIF_ID);
        // Tamper calendar date while keeping nextOccurrenceMs.
        String key = DoseReminderRecurrenceStore.storeKey("med-date", "d1");
        SharedPreferences prefs =
                context.getSharedPreferences(
                        DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE);
        String raw = prefs.getString(key, null);
        assertTrue(raw != null && raw.contains("nextCalendarDate"));
        String tampered = raw.replaceAll(
                "\"nextCalendarDate\":\"[0-9-]+\"", "\"nextCalendarDate\":\"1999-01-01\"");
        prefs.edit().putString(key, tampered).commit();
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-date", "d1", System.currentTimeMillis(), "14:00"));
    }

    @Test
    public void absent_isInvalid() {
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-x", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void normalizeReminderTime_acceptsUnpadded() {
        assertEquals("09:05", DoseReminderRecurrenceStore.normalizeReminderTime("9:05"));
        assertEquals("09:05", DoseReminderRecurrenceStore.normalizeReminderTime("09:05"));
    }
}
