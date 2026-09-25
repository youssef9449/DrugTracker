package app.drugtracker.alarmruntime;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * Native → JS structured error-code vocabulary (#534).
 *
 * Contract: known native failures cross the Capacitor bridge with an
 * explicit stable snake_case `code` next to the human-readable `error`
 * message. This helper is the single feature-neutral authority deciding
 * whether a result message is ALREADY a stable machine code (pass-through)
 * or an unstructured/exception-derived string (map to the caller's stable
 * fallback code). The raw message always remains available in `error`, so
 * unexpected external failures stay observable.
 *
 * The tokens mirror the vocabulary registered on the JS side
 * (src/utils/nativeErrors.ts NATIVE_CODE_CATEGORIES). New native codes must
 * be registered in BOTH places.
 *
 * This class carries NO business rules — it is shared vocabulary, safe for
 * every feature bridge to consume.
 */
public final class NativeErrorCodes {
    private NativeErrorCodes() {}

    private static final Map<String, Boolean> KNOWN_CODES = buildKnown();

    private static Map<String, Boolean> buildKnown() {
        Map<String, Boolean> m = new HashMap<>();
        // Invalid argument / request shape.
        for (String t : new String[] {
                "invalid_request", "invalid_args", "invalid_argument", "invalid_json",
                "invalid_snooze_request", "invalid_snooze", "invalid_schedule",
                "malformed_fields", "malformed_pending_record",
                "malformed_schedule_metadata", "invalid_schedule_record",
                "invalid_event_record", "invalid_treatment_end_date", "invalid_next_date",
                "invalid_auto_marker", "invalid_retry_evidence",
                "invalid_successor_obligation", "invalid_args_or_state",
                "invalid_calendarDate", "invalid_time", "invalid_amount", "invalid_datetime",
                "invalid_occurrence_resolution", "missing_params", "missing_schedule_fields",
                "missing_medicationId", "missing_doseId"}) {
            m.put(t, Boolean.TRUE);
        }
        // Permission / capability.
        for (String t : new String[] {
                "permission_denied", "exact_alarm_permission_denied",
                "notifications_disabled", "notification_channel_disabled",
                "notification_permission_required"}) {
            m.put(t, Boolean.TRUE);
        }
        // Persistence / durability.
        for (String t : new String[] {
                "persist_failed", "persistence_failed", "rejected_persist_failed",
                "recurrence_generation_write_failed", "recurrence_generation_commit_failed",
                "ordering_sequence_write_failed", "metadata_build_failed",
                "snapshot_failed", "pending_promotion_failed",
                "source_schedule_cleanup_failed",
                "malformed_schedule_metadata_cleanup_failed",
                "retry_persist_failed", "retry_evicted",
                "dose_reminder_pending_state_failed"}) {
            m.put(t, Boolean.TRUE);
        }
        // Ownership / staleness / cancellation.
        for (String t : new String[] {
                "ownership_lost", "ownership_conflict", "snapshot_stale",
                "stale_auto_occurrence", "identity_mismatch", "cancelled_skip",
                "cancelled", "already_present", "treatment_ended",
                "recurrence_authorization_invalid", "recurrence_generation_unauthorized"}) {
            m.put(t, Boolean.TRUE);
        }
        // Recovery.
        for (String t : new String[] {
                "recovery_required", "recover_required", "successor_catchup_failed"}) {
            m.put(t, Boolean.TRUE);
        }
        // Platform-level delivery and per-bridge failure families. Tokens
        // emitted by the Capacitor call.reject(message, code) catch paths are
        // registered here too so the native vocabulary stays synchronized
        // with the JS mapping table (src/utils/nativeErrors.ts).
        // platform_failure is the generic structuredCode fallback token; it
        // must pass through as a known code so a result message that is
        // already the generic token is not re-mapped per caller.
        for (String t : new String[] {
                "platform_failure",
                "notification_post_failed", "notification_cancel_failed",
                "notification_manager_unavailable", "notification_security_exception",
                "stock_not_initialized", "trigger_in_past", "open_settings_failed",
                "channel_bootstrap_failed", "restore_failed", "recovery_failed",
                "schedule_occurrence_failed", "cancel_occurrence_failed",
                "invalidate_recurrence_failed", "list_fired_events_failed",
                "mark_reconciled_failed", "list_schedules_failed",
                "stock_init_failed", "foreground_stock_failed",
                "auto_stock_apply_failed", "critical_stock_schedule_failed",
                "critical_stock_cancel_failed", "dose_reminder_schedule_failed",
                "dose_reminder_cancel_failed", "dose_reminder_snooze_schedule_failed",
                "dose_reminder_snooze_cancel_failed"}) {
            m.put(t, Boolean.TRUE);
        }
        return Collections.unmodifiableMap(m);
    }

    /** True when the message is already a stable machine-code token. */
    public static boolean isKnownCode(String message) {
        return message != null && KNOWN_CODES.containsKey(message);
    }

    /**
     * Structured code for a bridge result error (#534):
     * - known stable token → passed through unchanged (JS classification
     *   must not depend on message wording);
     * - null/empty or unknown/unstructured message → the caller's stable
     *   fallback code (deterministic per delivery domain), while the raw
     *   text remains observable in the `error` field.
     */
    public static String structuredCode(String message, String fallback) {
        if (message == null || message.isEmpty()) {
            return fallback;
        }
        return KNOWN_CODES.containsKey(message) ? message : fallback;
    }
}
