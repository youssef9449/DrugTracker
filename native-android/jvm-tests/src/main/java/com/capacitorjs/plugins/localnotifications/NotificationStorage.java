package com.capacitorjs.plugins.localnotifications;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;

/**
 * Test double that mirrors Capacitor NotificationStorage's NOTIFICATION_STORE
 * SharedPreferences surface used by TimedNotificationPublisher delivery.
 */
public class NotificationStorage {
    public static final String NOTIFICATION_STORE_ID = "NOTIFICATION_STORE";

    private final Context context;

    public NotificationStorage(Context context) {
        this.context = context;
    }

    public JSObject getSavedNotificationAsJSObject(String id) {
        SharedPreferences prefs =
                context.getSharedPreferences(NOTIFICATION_STORE_ID, Context.MODE_PRIVATE);
        String raw = prefs.getString(id, null);
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        try {
            return new JSObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    public void deleteNotification(String id) {
        context.getSharedPreferences(NOTIFICATION_STORE_ID, Context.MODE_PRIVATE)
                .edit()
                .remove(id)
                .commit();
    }
}
