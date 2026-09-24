/**
 * Native bridge error contract.
 *
 * Classification policy (#534): known native failures cross the bridge with
 * an explicit structured snake_case `code` field next to the human-readable
 * message. JS classification prefers the code and maps it through the
 * explicit table below — it must NOT depend on message wording. The
 * substring-based classifier is retained ONLY as a narrowly-scoped fallback
 * for unstructured/legacy errors, and an unknown classification stays
 * deterministic instead of being guessed aggressively.
 */

export type NativeErrorCode =
  | 'invalid_argument'
  | 'not_android'
  | 'permission_denied'
  | 'persistence_failed'
  | 'ownership_lost'
  | 'recovery_required'
  | 'platform_failure'
  | 'unknown';

export class NativeBoundaryError extends Error {
  readonly code: NativeErrorCode;

  constructor(code: NativeErrorCode, message: string) {
    super(message);
    this.name = 'NativeBoundaryError';
    this.code = code;
  }
}

/**
 * Canonical native error-code vocabulary → JS categories.
 *
 * The table is the single source of truth for structured classification.
 * Native emitters reuse these stable snake_case tokens (they mirror the
 * tokens already used inside the native plugins) and new native codes must
 * be registered here; anything unregistered falls through to the narrow
 * string fallback and then to the deterministic fallback category.
 */
const NATIVE_CODE_CATEGORIES: Readonly<Record<string, NativeErrorCode>> = {
  // Bridge/platform shape errors.
  not_android: 'not_android',
  invalid_request: 'invalid_argument',
  invalid_args: 'invalid_argument',
  invalid_argument: 'invalid_argument',
  invalid_json: 'invalid_argument',
  malformed_fields: 'invalid_argument',
  malformed_pending_record: 'invalid_argument',
  malformed_schedule_metadata: 'invalid_argument',
  invalid_schedule_record: 'invalid_argument',
  invalid_event_record: 'invalid_argument',
  invalid_treatment_end_date: 'invalid_argument',
  invalid_next_date: 'invalid_argument',
  invalid_auto_marker: 'invalid_argument',
  invalid_retry_evidence: 'invalid_argument',
  invalid_successor_obligation: 'invalid_argument',
  invalid_args_or_state: 'invalid_argument',
  invalid_snooze_request: 'invalid_argument',
  invalid_calendarDate: 'invalid_argument',
  invalid_time: 'invalid_argument',
  invalid_amount: 'invalid_argument',
  invalid_datetime: 'invalid_argument',
  missing_medicationId: 'invalid_argument',
  missing_doseId: 'invalid_argument',

  // Permission / capability.
  permission_denied: 'permission_denied',
  exact_alarm_permission_denied: 'permission_denied',
  notifications_disabled: 'permission_denied',
  notification_channel_disabled: 'permission_denied',
  notification_permission_required: 'permission_denied',

  // Persistence / durability.
  persist_failed: 'persistence_failed',
  persistence_failed: 'persistence_failed',
  rejected_persist_failed: 'persistence_failed',
  recurrence_generation_write_failed: 'persistence_failed',
  recurrence_generation_commit_failed: 'persistence_failed',
  ordering_sequence_write_failed: 'persistence_failed',
  metadata_build_failed: 'persistence_failed',
  snapshot_failed: 'persistence_failed',
  pending_promotion_failed: 'persistence_failed',
  source_schedule_cleanup_failed: 'persistence_failed',
  malformed_schedule_metadata_cleanup_failed: 'persistence_failed',
  retry_persist_failed: 'persistence_failed',
  retry_evicted: 'persistence_failed',

  // Ownership / staleness / cancellation.
  ownership_lost: 'ownership_lost',
  ownership_conflict: 'ownership_lost',
  snapshot_stale: 'ownership_lost',
  stale_auto_occurrence: 'ownership_lost',
  identity_mismatch: 'ownership_lost',
  cancelled_skip: 'ownership_lost',
  cancelled: 'ownership_lost',
  already_present: 'ownership_lost',
  treatment_ended: 'ownership_lost',
  recurrence_authorization_invalid: 'ownership_lost',
  recurrence_generation_unauthorized: 'ownership_lost',

  // Recovery.
  recovery_required: 'recovery_required',
  recover_required: 'recovery_required',
  successor_catchup_failed: 'recovery_required',
  restore_failed: 'recovery_required',
  recovery_failed: 'recovery_required',

  // Platform-level delivery.
  notification_post_failed: 'platform_failure',
  notification_cancel_failed: 'platform_failure',
  notification_manager_unavailable: 'platform_failure',
  notification_security_exception: 'platform_failure',
  stock_not_initialized: 'platform_failure',
  trigger_in_past: 'platform_failure',
  open_settings_failed: 'platform_failure',
  channel_bootstrap_failed: 'platform_failure',
};

/** Shape of a structured native failure crossing the bridge. */
export interface NativeFailureLike {
  code?: unknown;
  error?: unknown;
  message?: unknown;
}

/**
 * Classify a native failure preferring its structured `code`.
 * - Known code → mapped category (no message inspection).
 * - Unknown/unstructured code → narrow string fallback on the message.
 * - No message signal → deterministic fallback (default 'platform_failure').
 */
export function classifyNativeFailure(
  failure: NativeFailureLike,
  fallback: NativeErrorCode = 'platform_failure'
): NativeErrorCode {
  const code = typeof failure?.code === 'string' ? failure.code : undefined;
  if (code) {
    const mapped = NATIVE_CODE_CATEGORIES[code];
    if (mapped) return mapped;
    if (code === 'unknown') return 'unknown';
  }
  const message =
    typeof failure?.error === 'string'
      ? failure.error
      : typeof failure?.message === 'string'
        ? failure.message
        : undefined;
  return classifyNativeError(message ?? code, fallback);
}

/**
 * Convenience for bridge readers: classify a plugin result object that may
 * carry `{ ok, error, code }`. Prefers the structured code; falls back to
 * the narrow message classifier with the reader's default message.
 */
export function nativeFailureErrorCode(
  failure: NativeFailureLike | null | undefined,
  defaultMessage: string,
  fallback: NativeErrorCode = 'platform_failure'
): NativeErrorCode {
  if (failure && typeof failure.code === 'string') {
    return classifyNativeFailure(failure, fallback);
  }
  const message =
    typeof failure?.error === 'string' && failure.error
      ? failure.error
      : defaultMessage;
  return classifyNativeError(message, fallback);
}

/**
 * Legacy/narrow string-based classification. NOT used for known structured
 * codes (see {@link classifyNativeFailure}); retained for unstructured
 * native errors only.
 */
export function classifyNativeError(
  message: string | undefined,
  fallback: NativeErrorCode = 'platform_failure'
): NativeErrorCode {
  const value = (message ?? '').toLowerCase();
  if (value === 'unknown') return 'unknown';
  if (value.includes('invalid_') || value.includes('malformed_') || value.includes('missing_')) return 'invalid_argument';
  if (value === 'not_android') return 'not_android';
  if (value.includes('permission') || value.includes('notifications_disabled') || value.includes('notification_channel_disabled') || (value.includes('notification') && value.includes('not enabled'))) return 'permission_denied';
  if (value.includes('persist') || value.includes('storage') || value.includes('commit')) return 'persistence_failed';
  if (value.includes('ownership') || value.includes('stale') || value.includes('cancelled')) return 'ownership_lost';
  if (value.includes('recover') || value.includes('reconcile') || value.includes('catchup')) return 'recovery_required';
  return fallback;
}

export function toNativeBoundaryError(
  error: unknown,
  fallback: NativeErrorCode = 'platform_failure'
): NativeBoundaryError {
  if (error instanceof NativeBoundaryError) return error;
  if (
    error &&
    typeof error === 'object' &&
    ('code' in error || 'error' in error || 'message' in error)
  ) {
    const asFailure = error as NativeFailureLike;
    const message =
      typeof asFailure.error === 'string'
        ? asFailure.error
        : typeof asFailure.message === 'string'
          ? asFailure.message
          : 'native operation failed';
    return new NativeBoundaryError(
      classifyNativeFailure(asFailure, fallback),
      message
    );
  }
  const message = error instanceof Error ? error.message : String(error ?? 'native operation failed');
  return new NativeBoundaryError(classifyNativeError(message, fallback), message);
}


export interface NativeBoundaryFailure {
  ok: false;
  error: string;
  errorCode: NativeErrorCode;
}

export function toNativeBoundaryFailure(
  error: unknown,
  fallback: NativeErrorCode = 'platform_failure'
): NativeBoundaryFailure {
  const boundaryError = toNativeBoundaryError(error, fallback);
  return {
    ok: false,
    error: boundaryError.message,
    errorCode: boundaryError.code,
  };
}
