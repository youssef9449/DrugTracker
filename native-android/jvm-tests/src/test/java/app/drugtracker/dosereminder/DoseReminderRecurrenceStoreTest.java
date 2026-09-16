package app.drugtracker.dosereminder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import com.capacitorjs.plugins.localnotifications.DoseReminderRecurrenceStore;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Temporary delivery/re-arm evidence for dose reminders.
 * Valid only when future + schedule identity (reminderTime) matches current config.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class DoseReminderRecurrenceStoreTest {

    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.getSharedPreferences(DoseReminderRecurrenceStore.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void successfulReArm_evidenceValidForMatchingConfig() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-a", "d1", next, "09:00");
        assertEquals(next, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-a", "d1"));
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void futureEvidence_differentReminderTime_isInvalid() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-a", "d1", next, "09:00");
        // Config changed to 10:00 — must not block repair for the new schedule.
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis(), "10:00"));
    }

    @Test
    public void staleExpiredEvidence_doesNotBlockRepair() {
        long past = System.currentTimeMillis() - 120_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-e", "d1", past, "09:00");
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-e", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void clear_removesEvidence() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-c", "d1", next, "09:00");
        DoseReminderRecurrenceStore.clear(context, "med-c", "d1");
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-c", "d1"));
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-c", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void processRestart_readsSameValidEvidence() {
        long next = System.currentTimeMillis() + 3_600_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-b", "morning", next, "08:30");
        Context again = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(next, DoseReminderRecurrenceStore.getNextOccurrenceMs(again, "med-b", "morning"));
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                again, "med-b", "morning", System.currentTimeMillis(), "08:30"));
    }

    @Test
    public void processRestart_staleConfigEvidence_doesNotBlockNewRecurrence() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-old", "d1", next, "07:00");
        Context again = InstrumentationRegistry.getInstrumentation().getTargetContext();
        // User changed dose time to 11:00 after process death — evidence must be invalid.
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                again, "med-old", "d1", System.currentTimeMillis(), "11:00"));
    }

    @Test
    public void siblingDoses_doNotShareEvidence() {
        long next1 = System.currentTimeMillis() + 1_000_000L;
        long next2 = System.currentTimeMillis() + 2_000_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-m", "d1", next1, "09:00");
        DoseReminderRecurrenceStore.markReArmed(context, "med-m", "d2", next2, "21:00");
        assertEquals(next1, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-m", "d1"));
        assertEquals(next2, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-m", "d2"));
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
    public void absentState_isNotValid() {
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-x", "d1"));
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-x", "d1", System.currentTimeMillis(), "09:00"));
    }

    @Test
    public void missingExpectedReminderTime_isInvalid() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-a", "d1", next, "09:00");
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis(), null));
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis(), ""));
    }

    @Test
    public void markReArmed_withoutReminderTime_doesNotWrite() {
        DoseReminderRecurrenceStore.markReArmed(
                context, "med-z", "d1", System.currentTimeMillis() + 1000L, null);
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-z", "d1"));
    }

    @Test
    public void markReArmed_zeroOrNegative_doesNotWrite() {
        DoseReminderRecurrenceStore.markReArmed(context, "med-z", "d1", 0L, "09:00");
        DoseReminderRecurrenceStore.markReArmed(context, "med-z", "d1", -5L, "09:00");
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-z", "d1"));
    }

    @Test
    public void normalizeReminderTime_acceptsUnpadded() {
        assertEquals("09:05", DoseReminderRecurrenceStore.normalizeReminderTime("9:05"));
        assertEquals("09:05", DoseReminderRecurrenceStore.normalizeReminderTime("09:05"));
    }

    @Test
    public void legacyDoseId_usesStableSentinel() {
        long next = System.currentTimeMillis() + 50_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-legacy", null, next, "12:00");
        assertEquals(
                next,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-legacy", null));
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-legacy", null, System.currentTimeMillis(), "12:00"));
        assertEquals(
                DoseReminderRecurrenceStore.storeKey("med-legacy", null),
                DoseReminderRecurrenceStore.storeKey("med-legacy", ""));
    }

    @Test
    public void storedReminderTime_readable() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-t", "d1", next, "15:30");
        assertEquals("15:30", DoseReminderRecurrenceStore.getStoredReminderTime(context, "med-t", "d1"));
        assertNull(DoseReminderRecurrenceStore.getStoredReminderTime(context, "missing", "d1"));
    }
}
