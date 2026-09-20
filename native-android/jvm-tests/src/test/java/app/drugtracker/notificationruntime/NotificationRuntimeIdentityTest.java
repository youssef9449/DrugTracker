package app.drugtracker.notificationruntime;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class NotificationRuntimeIdentityTest {
    @Test
    public void fullNamespaceAndIdentityFormNotificationTag() {
        assertEquals(
                "dose-reminder:med-1::d1",
                NotificationRuntime.notificationTag(
                        "dose-reminder",
                        "med-1::d1"));
    }

    @Test
    public void distinctLogicalIdentitiesRemainDistinct() {
        String first = NotificationRuntime.notificationTag(
                "dose-reminder",
                "med-1::d1");
        String sibling = NotificationRuntime.notificationTag(
                "dose-reminder",
                "med-1::d2");
        String otherNamespace = NotificationRuntime.notificationTag(
                "critical-stock",
                "med-1");

        assertNotEquals(first, sibling);
        assertNotEquals(first, otherNamespace);
    }
}
