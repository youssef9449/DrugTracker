package app.drugtracker.dosereminder;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DoseReminderAlarmIdentityTest {
    @Test
    public void occurrenceIdentityIncludesMedicationAndDose() {
        String first = DoseReminderAlarmAdapter.occurrenceUri("med-1", "d1");
        String sibling = DoseReminderAlarmAdapter.occurrenceUri("med-1", "d2");
        String otherMedication = DoseReminderAlarmAdapter.occurrenceUri("med-2", "d1");

        assertNotEquals(first, sibling);
        assertNotEquals(first, otherMedication);
        assertTrue(first.contains("/dose-reminder/"));
        assertTrue(first.contains("/med-1"));
        assertTrue(first.contains("/d1"));
    }

    @Test
    public void snoozeIdentityIsSeparateFromRecurringIdentity() {
        assertNotEquals(
                DoseReminderAlarmAdapter.occurrenceUri("med-1", "d1"),
                DoseReminderAlarmAdapter.snoozeUri("med-1", "d1"));
    }
}
