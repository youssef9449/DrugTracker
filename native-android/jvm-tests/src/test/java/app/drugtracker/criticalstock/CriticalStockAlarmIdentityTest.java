package app.drugtracker.criticalstock;

import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CriticalStockAlarmIdentityTest {
    @Test
    public void identityUsesTheFullMedicationId() {
        String first = CriticalStockAlarmAdapter.occurrenceUri("med-1");
        String second = CriticalStockAlarmAdapter.occurrenceUri("med-2");

        assertNotEquals(first, second);
        assertTrue(first.contains("/critical-stock/"));
        assertTrue(first.contains("/med-1"));
    }
}
