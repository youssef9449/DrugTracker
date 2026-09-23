package app.drugtracker.autodeduction;

/**
 * Immutable-injection policy seam for deterministic failure-path tests.
 * Production uses {@link #ALLOW_ALL}; no mutable test state lives in runtime classes.
 */
interface AutoDeductionFailurePolicy {
    AutoDeductionFailurePolicy ALLOW_ALL = new AutoDeductionFailurePolicy() {};

    default boolean allowEventCommit() { return true; }
    default boolean allowRecurrenceAuthCommit() { return true; }
    default boolean allowFireRetryEvidenceCommit() { return true; }
    default boolean allowRestoreFutureSchedules() { return true; }
    default boolean allowTombstoneCommit() { return true; }
    default boolean allowScheduleMetadataRemoval() { return true; }
    default boolean allowOrderingTokenAllocation() { return true; }
    default boolean allowTerminalStateCompactionCommit() { return true; }

    default Long recoveryNowOverrideMs() { return null; }
}
