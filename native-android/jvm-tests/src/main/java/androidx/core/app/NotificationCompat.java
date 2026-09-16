package androidx.core.app;

import android.app.Notification;
import android.content.Context;

/** Minimal stub so TimedNotificationPublisher compiles under jvm-tests. */
public class NotificationCompat {
    public static class Builder {
        public Builder(Context context, Notification notification) {}

        public Builder setChannelId(String channelId) {
            return this;
        }

        public Notification build() {
            return new Notification();
        }
    }
}
