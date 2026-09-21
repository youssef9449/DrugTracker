package app.drugtracker.alarmruntime;

/** Shared process-wide linearization boundary for exact-alarm transactions. */
final class ExactAlarmOperationLock {
    private ExactAlarmOperationLock() {}

    static final Object LOCK = new Object();
}
