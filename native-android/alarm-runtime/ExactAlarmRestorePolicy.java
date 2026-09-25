package app.drugtracker.alarmruntime;

/**
 * Shared, feature-neutral native alarm restoration policy (#506).
 *
 * Every durable alarm record encountered during lifecycle/reboot restore
 * reaches a TERMINAL state — no malformed or stale record may remain
 * indefinitely as silently-ignored durable state:
 *
 * - RESTORE: valid metadata → the owning feature re-arms and reconciles it.
 * - RESOLVE_STALE: stale/obsolete metadata → the owning feature resolves it
 *   (feature-specific resolution, e.g. recurring next-day advance) and/or
 *   removes the record.
 * - REMOVE_MALFORMED: malformed/incomplete metadata → the owning feature
 *   removes the record, reporting the structured reason from
 *   {@link Outcome#reason} for diagnosis.
 * - PRESERVE: ownership/version conflict → the newer authoritative record
 *   wins; the older restore attempt must not touch it.
 *
 * The policy knows NOTHING about medications, doses, or stock — features
 * supply their own field checks and keep their own persistence mechanics.
 * No second AlarmManager implementation is introduced: removal/resolution
 * goes through the feature adapter's cancel path over the shared runtime.
 */
public final class ExactAlarmRestorePolicy {

    private ExactAlarmRestorePolicy() {}

    public enum Action {
        RESTORE,
        RESOLVE_STALE,
        REMOVE_MALFORMED,
        PRESERVE
    }

    public static final class Outcome {
        public final Action action;
        /** Structured machine-readable reason (null for RESTORE). */
        public final String reason;

        private Outcome(Action action, String reason) {
            this.action = action;
            this.reason = reason;
        }

        public boolean isRestore() {
            return action == Action.RESTORE;
        }
    }

    static Outcome restore() {
        return new Outcome(Action.RESTORE, null);
    }

    static Outcome resolveStale(String reason) {
        return new Outcome(Action.RESOLVE_STALE, reason);
    }

    static Outcome removeMalformed(String reason) {
        return new Outcome(Action.REMOVE_MALFORMED, reason);
    }

    static Outcome preserve(String reason) {
        return new Outcome(Action.PRESERVE, reason);
    }

    /**
     * Generic record evaluation shared by all feature restore paths.
     *
     * @param cancelled true when the record is already effectively cancelled
     *                  (terminal tombstone) — nothing to do, PRESERVE.
     * @param identityKeyValid true when the durable key parses into a valid
     *                         feature identity.
     * @param metadataPresent true when durable metadata exists for the key.
     * @param missingRequiredField structured token for the first missing
     *                             required metadata field, or null.
     * @param triggerDatetimeValid true when the record's date/time resolves
     *                             to a real future-or-past instant.
     * @param triggerInPast true when the resolved trigger already passed
     *                      (stale — feature decides the resolution).
     * @param ownershipConflict true when a newer authoritative record owns
     *                          the key.
     */
    public static Outcome evaluate(
            boolean cancelled,
            boolean identityKeyValid,
            boolean metadataPresent,
            String missingRequiredField,
            boolean triggerDatetimeValid,
            boolean triggerInPast,
            boolean ownershipConflict) {
        if (cancelled) {
            return preserve("record_cancelled");
        }
        if (!identityKeyValid) {
            return removeMalformed("malformed_identity_key");
        }
        if (!metadataPresent) {
            return removeMalformed("metadata_missing");
        }
        if (missingRequiredField != null) {
            return removeMalformed("missing_required_field:" + missingRequiredField);
        }
        if (!triggerDatetimeValid) {
            return removeMalformed("invalid_trigger_datetime");
        }
        if (ownershipConflict) {
            return preserve("newer_authoritative_record");
        }
        if (triggerInPast) {
            return resolveStale("trigger_in_past");
        }
        return restore();
    }
}
