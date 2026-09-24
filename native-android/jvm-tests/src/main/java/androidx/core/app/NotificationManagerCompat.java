package androidx.core.app;

import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/**
 * JVM-test compile/runtime stub for the AndroidX notification permission API.
 * Production Android builds use the real AndroidX implementation.
 */
public final class NotificationManagerCompat {
    private final Context context;

    private NotificationManagerCompat(Context context) {
        this.context = context;
    }

    public static NotificationManagerCompat from(Context context) {
        return new NotificationManagerCompat(context);
    }

    public boolean areNotificationsEnabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return true;
        }
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }
}
