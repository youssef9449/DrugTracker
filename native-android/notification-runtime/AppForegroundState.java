package app.drugtracker.notificationruntime;

/**
 * Process-local foreground state used only for notification presentation policy.
 * It is deliberately not part of exact-alarm scheduling.
 */
public final class AppForegroundState {
    private static volatile boolean foreground = false;

    private AppForegroundState() {}

    public static void setForeground(boolean value) {
        foreground = value;
    }

    public static boolean isForeground() {
        return foreground;
    }
}
