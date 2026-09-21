package app.drugtracker.criticalstock;

import static org.junit.Assert.assertEquals;

import app.drugtracker.notificationruntime.NotificationRuntime;

import org.junit.Test;

public class CriticalStockIdentityTest {
    @Test
    public void alarmIdentityUsesFullCriticalNamespaceAndMedicationId() {
        assertEquals(
                "content://app.drugtracker.alarm/alarm/critical-stock/med-123",
                CriticalStockAlarmAdapter.occurrenceUri("med-123"));
    }

    @Test
    public void notificationIdentityUsesExplicitCriticalNamespaceAndMedicationId() {
        assertEquals(
                "critical-stock:med-123",
                NotificationRuntime.notificationTag("critical-stock", "med-123"));
    }

    @Test
    public void differentMedicationIdsProduceDifferentNativeIdentitiesWithoutHashing() {
        String first = CriticalStockAlarmAdapter.occurrenceUri("med-a");
        String second = CriticalStockAlarmAdapter.occurrenceUri("med-b");

        org.junit.Assert.assertNotEquals(first, second);
        org.junit.Assert.assertNotEquals(
                NotificationRuntime.notificationTag("critical-stock", "med-a"),
                NotificationRuntime.notificationTag("critical-stock", "med-b"));
    }
}
