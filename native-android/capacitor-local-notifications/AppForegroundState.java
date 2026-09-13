package com.capacitorjs.plugins.localnotifications;

/**
 * Process-local foreground flag for DrugTracker notification delivery.
 *
 * Updated from MainActivity lifecycle (onResume / onPause).
 * Defaults to false so a freshly started process (e.g. after the app was
 * killed and an alarm BroadcastReceiver runs) is treated as background —
 * dose reminders then use dose-reminder-v3 (system default sound).
 *
 * Must NOT be persisted across process death. Static process-local state only.
 */
public final class AppForegroundState {

    private static volatile boolean appForeground = false;

    private AppForegroundState() {}

    /** Called from MainActivity.onResume. */
    public static void setForeground(boolean foreground) {
        appForeground = foreground;
    }

    /**
     * Whether the DrugTracker UI is currently active.
     * Fresh process default: false.
     */
    public static boolean isForeground() {
        return appForeground;
    }
}
