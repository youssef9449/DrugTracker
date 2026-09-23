package app.drugtracker.alarmruntime;

/** Shared process-wide linearization boundary for exact-alarm transactions. */
public final class ExactAlarmOperationLock {
    private ExactAlarmOperationLock() {}

    public static final Object LOCK = new Object();
}
