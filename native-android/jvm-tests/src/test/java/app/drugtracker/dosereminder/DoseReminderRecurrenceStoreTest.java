package app.drugtracker.dosereminder;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.test.platform.app.InstrumentationRegistry;
import com.capacitorjs.plugins.localnotifications.DoseReminderRecurrenceStore;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Native persisted delivery/re-arm evidence for dose reminders.
 * Keyed by medicationId + doseId; survives process death (SharedPreferences).
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
    public void markReArmed_persistsNextOccurrenceAfterSuccessfulSchedule() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-a", "d1", next);
        assertEquals(next, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-a", "d1"));
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-a", "d1", System.currentTimeMillis()));
    }

    @Test
    public void absentState_isNotValid() {
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-x", "d1"));
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-x", "d1", System.currentTimeMillis()));
    }

    @Test
    public void processRestart_readsSameState() {
        long next = System.currentTimeMillis() + 3_600_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-b", "morning", next);
        // New Context handle, same SharedPreferences file (process-death simulation).
        Context again = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(next, DoseReminderRecurrenceStore.getNextOccurrenceMs(again, "med-b", "morning"));
        assertTrue(DoseReminderRecurrenceStore.isValidReArm(
                again, "med-b", "morning", System.currentTimeMillis()));
    }

    @Test
    public void siblingDoses_doNotShareState() {
        long next1 = System.currentTimeMillis() + 1_000_000L;
        long next2 = System.currentTimeMillis() + 2_000_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-m", "d1", next1);
        DoseReminderRecurrenceStore.markReArmed(context, "med-m", "d2", next2);
        assertEquals(next1, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-m", "d1"));
        assertEquals(next2, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-m", "d2"));
        assertNotEquals(
                DoseReminderRecurrenceStore.storeKey("med-m", "d1"),
                DoseReminderRecurrenceStore.storeKey("med-m", "d2"));
    }

    @Test
    public void expiredState_isNotValid_allowsRepair() {
        long past = System.currentTimeMillis() - 120_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-e", "d1", past);
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-e", "d1", System.currentTimeMillis()));
    }

    @Test
    public void clear_removesEvidence() {
        long next = System.currentTimeMillis() + 86_400_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-c", "d1", next);
        DoseReminderRecurrenceStore.clear(context, "med-c", "d1");
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-c", "d1"));
        assertFalse(DoseReminderRecurrenceStore.isValidReArm(
                context, "med-c", "d1", System.currentTimeMillis()));
    }

    @Test
    public void legacyDoseId_usesStableSentinel() {
        long next = System.currentTimeMillis() + 50_000L;
        DoseReminderRecurrenceStore.markReArmed(context, "med-legacy", null, next);
        assertEquals(
                next,
                DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-legacy", null));
        assertEquals(
                DoseReminderRecurrenceStore.storeKey("med-legacy", null),
                DoseReminderRecurrenceStore.storeKey("med-legacy", ""));
        assertEquals(
                DoseReminderRecurrenceStore.storeKey("med-legacy", null),
                DoseReminderRecurrenceStore.storeKey("med-legacy", "__legacy__"));
    }

    @Test
    public void markReArmed_zeroOrNegative_doesNotWrite() {
        DoseReminderRecurrenceStore.markReArmed(context, "med-z", "d1", 0L);
        DoseReminderRecurrenceStore.markReArmed(context, "med-z", "d1", -5L);
        assertEquals(-1L, DoseReminderRecurrenceStore.getNextOccurrenceMs(context, "med-z", "d1"));
    }
}
