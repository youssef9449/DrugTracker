package com.capacitorjs.plugins.localnotifications;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Notification;
import android.content.Context;
import androidx.core.app.NotificationCompat;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Critical Stock vs Dose Reminder isolation at publish time.
 * medicationId alone (low-stock) must never be treated as a dose reminder.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class DoseReminderClassifierTest {

    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AppForegroundState.setForeground(false);
    }

    private static JSObject notificationJson(String medId, String doseId, String channelId) throws Exception {
        JSObject extra = new JSObject();
        if (medId != null) {
            extra.put("medicationId", medId);
        }
        if (doseId != null) {
            extra.put("doseId", doseId);
        }
        JSObject root = new JSObject();
        root.put("extra", extra);
        if (channelId != null) {
            root.put("channelId", channelId);
        }
        return root;
    }

    private Notification notificationOnChannel(String channelId) {
        return new NotificationCompat.Builder(context, channelId)
                .setContentTitle("t")
                .setContentText("b")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .build();
    }

    @Test
    public void criticalStock_medicationIdOnly_lowStock_isNotDoseReminder() throws Exception {
        JSObject json = notificationJson("med-1", null, "low-stock");
        Notification n = notificationOnChannel("low-stock");
        assertFalse(TimedNotificationPublisher.isDoseReminderNotification(n, json));
    }

    @Test
    public void doseReminder_medicationIdAndDoseId_isDoseReminder() throws Exception {
        JSObject json = notificationJson("med-1", "d1", TimedNotificationPublisher.DOSE_BG_CHANNEL);
        Notification n = notificationOnChannel(TimedNotificationPublisher.DOSE_BG_CHANNEL);
        assertTrue(TimedNotificationPublisher.isDoseReminderNotification(n, json));
    }

    @Test
    public void existingForegroundDoseChannel_isDoseReminder() {
        Notification n = notificationOnChannel(TimedNotificationPublisher.DOSE_FG_CHANNEL);
        assertTrue(TimedNotificationPublisher.isDoseReminderNotification(n, null));
    }

    @Test
    public void existingBackgroundDoseChannel_isDoseReminder() {
        Notification n = notificationOnChannel(TimedNotificationPublisher.DOSE_BG_CHANNEL);
        assertTrue(TimedNotificationPublisher.isDoseReminderNotification(n, null));
    }

    @Test
    public void criticalStock_lowStock_notRewrittenInBackground() throws Exception {
        AppForegroundState.setForeground(false);
        JSObject json = notificationJson("med-1", null, "low-stock");
        Notification n = notificationOnChannel("low-stock");
        TimedNotificationPublisher publisher = new TimedNotificationPublisher();
        Notification out = publisher.applyDoseReminderChannelIfNeeded(context, n, json);
        assertFalse(TimedNotificationPublisher.isDoseReminderNotification(out, json));
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            org.junit.Assert.assertEquals("low-stock", out.getChannelId());
        }
    }

    @Test
    public void criticalStock_lowStock_notRewrittenInForeground() throws Exception {
        AppForegroundState.setForeground(true);
        JSObject json = notificationJson("med-1", null, "low-stock");
        Notification n = notificationOnChannel("low-stock");
        TimedNotificationPublisher publisher = new TimedNotificationPublisher();
        Notification out = publisher.applyDoseReminderChannelIfNeeded(context, n, json);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            org.junit.Assert.assertEquals("low-stock", out.getChannelId());
        }
        AppForegroundState.setForeground(false);
    }

    @Test
    public void blankDoseId_isNotDoseReminder() throws Exception {
        JSObject json = notificationJson("med-1", "   ", "low-stock");
        Notification n = notificationOnChannel("low-stock");
        assertFalse(TimedNotificationPublisher.isDoseReminderNotification(n, json));
    }
}
