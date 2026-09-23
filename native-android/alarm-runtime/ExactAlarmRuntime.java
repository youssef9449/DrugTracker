package app.drugtracker.alarmruntime;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;


/**
 * Shared native exact-alarm runtime.
 *
 * <p>The durable scheduling transaction is:
 * lock -> durable metadata -> AlarmManager install -> ownership-safe rollback.</p>
 *
 * <p>The durable cancellation transaction is:
 * lock -> durable tombstone -> AlarmManager.cancel -> metadata removal.</p>
 *
 * <p>Feature date/time semantics and lifecycle recovery remain outside this
 * mechanism class. Feature adapters reconstruct their own schedule requests
 * from feature-owned durable state.</p>
 */
public final class ExactAlarmRuntime {
    private static final String TAG = "ExactAlarmRuntime";

    private final Context appContext;
    private final ExactAlarmStore store;
    private final int pendingIntentRequestCode;
    private final FailurePolicy failurePolicy;

    public interface FailurePolicy {
        FailurePolicy ALLOW_ALL = new FailurePolicy() {};
        default boolean allowOrderingTokenAllocation() { return true; }
        default boolean allowTombstoneCommit() { return true; }
        default boolean allowScheduleMetadataRemoval() { return true; }
    }

    public ExactAlarmRuntime(
            Context context,
            String schedulesPrefsName,
            String cancellationsPrefsName,
            String orderingPrefsName,
            int pendingIntentRequestCode) {
        this(
                context,
                schedulesPrefsName,
                cancellationsPrefsName,
                orderingPrefsName,
                pendingIntentRequestCode,
                FailurePolicy.ALLOW_ALL);
    }

    public ExactAlarmRuntime(
            Context context,
            String schedulesPrefsName,
            String cancellationsPrefsName,
            String orderingPrefsName,
            int pendingIntentRequestCode,
            FailurePolicy failurePolicy) {
        appContext = context.getApplicationContext();
        store = new ExactAlarmStore(
                appContext,
                schedulesPrefsName,
                cancellationsPrefsName,
                orderingPrefsName);
        this.pendingIntentRequestCode = pendingIntentRequestCode;
        this.failurePolicy = failurePolicy == null
                ? FailurePolicy.ALLOW_ALL
                : failurePolicy;
    }


    /**
     * Single native source of truth for Android exact-alarm capability.
     * Feature adapters and lifecycle/bridge code must delegate here rather
     * than reimplementing the platform check.
     */
    public static boolean canScheduleExactAlarms(Context context) {
        if (context == null) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = (AlarmManager) context
                .getApplicationContext()
                .getSystemService(Context.ALARM_SERVICE);
        return manager != null && manager.canScheduleExactAlarms();
    }

    /** Raw durable schedule metadata snapshot for a feature adapter. */
    public String getScheduleRaw(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return null;
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.getScheduleRaw(storageKey);
        }
    }

    /** Feature-neutral snapshot of all durable schedule metadata keyed by storage identity. */
    public java.util.Map<String, String> listScheduleMetadata() {
        synchronized (ExactAlarmOperationLock.LOCK) {
            java.util.Map<String, String> result = new java.util.LinkedHashMap<>();
            for (java.util.Map.Entry<String, ?> entry : store.getAllScheduleMetadata().entrySet()) {
                String key = entry.getKey();
                if (key == null
                        || !key.startsWith(ExactAlarmContract.SCHEDULE_KEY_PREFIX)
                        || !(entry.getValue() instanceof String)) {
                    continue;
                }
                result.put(
                        key.substring(ExactAlarmContract.SCHEDULE_KEY_PREFIX.length()),
                        (String) entry.getValue());
            }
            return result;
        }
    }

    public boolean hasSchedule(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.hasSchedule(storageKey);
        }
    }

    public boolean removeScheduleIfOwned(
            String storageKey,
            String expectedOperationVersion) {
        if (storageKey == null || storageKey.isEmpty()
                || expectedOperationVersion == null
                || expectedOperationVersion.isEmpty()) {
            return false;
        }
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.removeScheduleIfOwnedLocked(
                    storageKey, expectedOperationVersion);
        }
    }

    public boolean removeSchedule(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.removeScheduleLocked(storageKey);
        }
    }

    public boolean hasCancellationTombstone(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.hasCancellationTombstoneLocked(storageKey);
        }
    }

    public boolean isEffectivelyCancelled(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.isEffectivelyCancelledLocked(storageKey);
        }
    }

    public boolean clearCancellationTombstone(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return true;
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.removeCancellationTombstoneLocked(storageKey);
        }
    }

    public boolean canScheduleExactAlarms() {
        return canScheduleExactAlarms(appContext);
    }

    /** Snapshot of one durable schedule row. The returned object is a defensive copy. */
    public JSONObject getScheduleMetadata(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return null;
        synchronized (ExactAlarmOperationLock.LOCK) {
            String raw = store.getScheduleRaw(storageKey);
            if (raw == null || raw.isEmpty()) return null;
            try {
                return new JSONObject(raw.toString());
            } catch (JSONException e) {
                return null;
            }
        }
    }

    /** Feature-neutral list of durable schedule storage keys. */
    public java.util.List<String> listScheduledStorageKeys() {
        synchronized (ExactAlarmOperationLock.LOCK) {
            return new java.util.ArrayList<>(store.listFeatureStorageKeys());
        }
    }

    /**
     * Remove a one-shot durable schedule only when the delivery still owns the
     * current operation version. A cancelled/replaced schedule is never removed.
     */
    public boolean completeOneShot(
            String storageKey,
            String expectedOperationVersion) {
        if (storageKey == null || storageKey.isEmpty()
                || expectedOperationVersion == null
                || expectedOperationVersion.isEmpty()) {
            return false;
        }
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.removeScheduleIfOwnedLocked(
                    storageKey,
                    expectedOperationVersion);
        }
    }

    /**
     * Query the real AlarmManager PendingIntent state.
     *
     * <p>ABSENT means the OS has no matching alarm. FAILED means the state
     * could not be determined; callers must never treat FAILED as ABSENT for
     * destructive reconciliation.</p>
     */
    public PendingStateResult getPendingState(
            String identityUri,
            String action,
            Class<? extends BroadcastReceiver> receiverClass) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)
                || action == null
                || action.isEmpty()
                || receiverClass == null) {
            return PendingStateResult.failed("invalid_pending_request");
        }
        synchronized (ExactAlarmOperationLock.LOCK) {
            try {
                Intent intent = new Intent(appContext, receiverClass);
                intent.setAction(action);
                intent.setData(android.net.Uri.parse(identityUri));

                int flags = PendingIntent.FLAG_NO_CREATE;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    flags |= PendingIntent.FLAG_IMMUTABLE;
                }
                PendingIntent pendingIntent = PendingIntent.getBroadcast(
                        appContext,
                        pendingIntentRequestCode,
                        intent,
                        flags);
                return pendingIntent == null
                        ? PendingStateResult.absent()
                        : PendingStateResult.pending();
            } catch (Exception e) {
                Log.e(TAG, "pending-state lookup failed", e);
                return PendingStateResult.failed("pending_state_lookup_failed");
            }
        }
    }

    /**
     * Atomically checks whether a fired delivery still owns an active durable
     * schedule. This is the delivery linearization point: a cancellation or
     * replacement that acquires the shared lock first makes this false.
     */
    public boolean ownsActiveSchedule(
            String storageKey,
            String expectedOperationVersion) {
        if (storageKey == null || storageKey.isEmpty()
                || expectedOperationVersion == null
                || expectedOperationVersion.isEmpty()) {
            return false;
        }
        synchronized (ExactAlarmOperationLock.LOCK) {
            return ExactAlarmContract.isMetadataOwnedByOperationVersion(
                    store.getScheduleRaw(storageKey),
                    expectedOperationVersion)
                    && !store.isEffectivelyCancelledLocked(storageKey);
        }
    }

    public ScheduleResult schedule(ScheduleRequest request) {
        if (!isValidScheduleRequest(request)) {
            return ScheduleResult.fail("invalid_request");
        }
        if (request.triggerAtEpochMs
                <= System.currentTimeMillis() - 2000L) {
            return ScheduleResult.fail("trigger_in_past");
        }
        if (!canScheduleExactAlarms()) {
            return ScheduleResult.fail(
                    "exact_alarm_permission_denied");
        }

        synchronized (ExactAlarmOperationLock.LOCK) {
            String previousScheduleRaw =
                    store.getScheduleRaw(request.storageKey);

            if (request.expectedExistingOperationVersion != null
                    && !ExactAlarmContract.isMetadataOwnedByOperationVersion(
                            store.getScheduleRaw(
                                    request.storageKey),
                            request.expectedExistingOperationVersion)) {
                return ScheduleResult.fail("ownership_lost");
            }

            // Recovery/re-arm requests are allowed to replace only the exact
            // schedule version they read. If a newer cancellation tombstone
            // appeared after the caller's pre-check, do not let recovery
            // allocate a fresh version that would supersede that cancellation.
            if (request.expectedExistingOperationVersion != null
                    && !request.expectedExistingOperationVersion.isEmpty()
                    && store.isEffectivelyCancelledLocked(request.storageKey)) {
                return ScheduleResult.fail("ownership_lost");
            }

            String operationVersion =
                    allocateOperationVersionLocked();
            if (operationVersion == null) {
                return ScheduleResult.fail(
                        "ordering_sequence_write_failed");
            }

            JSONObject metadata = new JSONObject();
            try {
                copyFeatureMetadata(
                        request.featureMetadata,
                        metadata);
                metadata.put(
                        ExactAlarmContract.FIELD_OPERATION_VERSION,
                        operationVersion);
                metadata.put(
                        ExactAlarmContract.FIELD_IDENTITY_URI,
                        request.identityUri);
                metadata.put(
                        ExactAlarmContract.FIELD_STORAGE_KEY,
                        request.storageKey);
                metadata.put(
                        ExactAlarmContract.FIELD_ACTION,
                        request.action);
                metadata.put(
                        ExactAlarmContract.FIELD_RECEIVER_CLASS,
                        request.receiverClass.getName());
                metadata.put(
                        ExactAlarmContract.FIELD_TRIGGER_AT_EPOCH_MS,
                        request.triggerAtEpochMs);
            } catch (JSONException | RuntimeException e) {
                return ScheduleResult.fail("metadata_build_failed");
            }

            if (!store.writeScheduleLocked(
                    request.storageKey,
                    metadata)) {
                return ScheduleResult.fail(
                        "schedule_metadata_write_failed");
            }

            AlarmManager manager = alarmManager();
            if (manager == null) {
                rollbackScheduleLocked(
                        request.storageKey,
                        operationVersion,
                        previousScheduleRaw);
                return ScheduleResult.fail(
                        "alarm_manager_unavailable");
            }

            try {
                PendingIntent pendingIntent =
                        buildPendingIntent(
                                request.identityUri,
                                request.action,
                                request.receiverClass,
                                request.deliveryExtras,
                                operationVersion);
                if (pendingIntent == null) {
                    rollbackScheduleLocked(
                            request.storageKey,
                            operationVersion,
                            previousScheduleRaw);
                    return ScheduleResult.fail(
                            "pending_intent_build_failed");
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    manager.setExactAndAllowWhileIdle(
                            AlarmManager.RTC_WAKEUP,
                            request.triggerAtEpochMs,
                            pendingIntent);
                } else {
                    manager.setExact(
                            AlarmManager.RTC_WAKEUP,
                            request.triggerAtEpochMs,
                            pendingIntent);
                }
            } catch (SecurityException e) {
                Log.w(TAG, "exact alarm install denied", e);
                rollbackScheduleLocked(
                        request.storageKey,
                        operationVersion,
                        previousScheduleRaw);
                return ScheduleResult.fail(
                        "exact_alarm_permission_denied");
            } catch (Exception e) {
                Log.e(TAG, "exact alarm install failed", e);
                rollbackScheduleLocked(
                        request.storageKey,
                        operationVersion,
                        previousScheduleRaw);
                return ScheduleResult.fail("schedule_failed");
            }

            // Only after AlarmManager accepted the new schedule may an older
            // cancellation tombstone be physically removed. If this cleanup fails,
            // ordering still makes the newer schedule authoritative; if install
            // fails, the older tombstone remains intact.
            store.clearCancellationIfSupersededLocked(
                    request.storageKey,
                    operationVersion);

            return ScheduleResult.success(
                    request.identityUri,
                    operationVersion);
        }
    }

    public CancelResult cancel(
            String identityUri,
            String storageKey,
            String action,
            Class<? extends BroadcastReceiver> receiverClass) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)
                || storageKey == null
                || storageKey.isEmpty()
                || action == null
                || action.isEmpty()
                || receiverClass == null) {
            return CancelResult.fail(
                    "invalid_cancel_request");
        }

        synchronized (ExactAlarmOperationLock.LOCK) {
            boolean hadMetadata =
                    store.hasSchedule(storageKey);
            boolean alreadyCancelled =
                    store.hasCancellationTombstoneLocked(
                            storageKey);

            // Every cancellation of an existing schedule must publish a fresh
            // ordering tombstone so an older leftover tombstone cannot lose to the
            // current schedule if metadata removal later fails.
            if (hadMetadata || !alreadyCancelled) {
                String cancelToken =
                        allocateOperationVersionLocked();
                if (cancelToken == null) {
                    return CancelResult.fail(
                            "ordering_sequence_write_failed");
                }
                if (!failurePolicy.allowTombstoneCommit() || !store.writeCancellationTombstoneLocked(
                                storageKey,
                                cancelToken)) {
                    return CancelResult.fail(
                            "cancellation_tombstone_write_failed");
                }
            }

            AlarmManager manager = alarmManager();
            if (manager == null) {
                return CancelResult.fail(
                        "alarm_manager_unavailable");
            }

            try {
                PendingIntent pendingIntent =
                        buildPendingIntent(
                                identityUri,
                                action,
                                receiverClass,
                                null,
                                null);
                if (pendingIntent != null) {
                    manager.cancel(pendingIntent);
                    pendingIntent.cancel();
                }
            } catch (Exception e) {
                Log.e(TAG, "alarm cancellation failed: "
                        + identityUri, e);
                return CancelResult.fail(
                        "alarm_cancel_failed");
            }

            if (!hadMetadata) {
                return alreadyCancelled
                        ? CancelResult.alreadyAbsent()
                        : CancelResult.success();
            }

            if (!failurePolicy.allowScheduleMetadataRemoval() || !store.removeScheduleLocked(
                            storageKey)) {
                Log.e(TAG, "schedule metadata removal failed: "
                        + storageKey);
                return CancelResult.fail(
                        "schedule_metadata_remove_failed");
            }

            return CancelResult.success();
        }
    }

    /**
     * Ephemeral exact/inexact one-shot mechanism for feature-owned retry work.
     * It deliberately writes no durable schedule row.
     */
    public boolean scheduleOneShot(
            String identityUri,
            String action,
            Class<? extends BroadcastReceiver> receiverClass,
            Bundle deliveryExtras,
            long triggerAtEpochMs,
            boolean allowInexactFallback) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)
                || action == null
                || action.isEmpty()
                || receiverClass == null
                || triggerAtEpochMs <= 0L) {
            return false;
        }

        synchronized (ExactAlarmOperationLock.LOCK) {
            AlarmManager manager = alarmManager();
            if (manager == null) return false;

            PendingIntent pendingIntent = buildPendingIntent(
                    identityUri,
                    action,
                    receiverClass,
                    deliveryExtras,
                    null);
            if (pendingIntent == null) return false;

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    manager.setExactAndAllowWhileIdle(
                            AlarmManager.RTC_WAKEUP,
                            triggerAtEpochMs,
                            pendingIntent);
                } else {
                    manager.setExact(
                            AlarmManager.RTC_WAKEUP,
                            triggerAtEpochMs,
                            pendingIntent);
                }
                return true;
            } catch (SecurityException e) {
                if (!allowInexactFallback) return false;
                try {
                    manager.set(
                            AlarmManager.RTC_WAKEUP,
                            triggerAtEpochMs,
                            pendingIntent);
                    return true;
                } catch (Exception ex) {
                    Log.e(TAG,
                            "inexact one-shot install failed", ex);
                    return false;
                }
            } catch (Exception e) {
                Log.e(TAG,
                        "one-shot install failed", e);
                return false;
            }
        }
    }

    public boolean cancelOneShot(
            String identityUri,
            String action,
            Class<? extends BroadcastReceiver> receiverClass) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)
                || action == null
                || action.isEmpty()
                || receiverClass == null) {
            return false;
        }

        synchronized (ExactAlarmOperationLock.LOCK) {
            AlarmManager manager = alarmManager();
            if (manager == null) return false;
            try {
                PendingIntent pendingIntent = buildPendingIntent(
                        identityUri,
                        action,
                        receiverClass,
                        null,
                        null);
                if (pendingIntent != null) {
                    manager.cancel(pendingIntent);
                    pendingIntent.cancel();
                }
                return true;
            } catch (Exception e) {
                Log.e(TAG,
                        "one-shot cancellation failed: "
                                + identityUri,
                        e);
                return false;
            }
        }
    }

    /**
     * Reinstall a durable row after lifecycle recovery. The caller supplies the
     * current local-date-derived epoch and the expected ownership token.
     */
    private void rollbackScheduleLocked(
            String storageKey,
            String expectedOperationVersion,
            String previousScheduleRaw) {
        if (!ExactAlarmContract.isMetadataOwnedByOperationVersion(
                store.getScheduleRaw(storageKey),
                expectedOperationVersion)) {
            Log.w(
                    TAG,
                    "ownership-safe rollback skipped: " + storageKey);
            return;
        }

        boolean restored;
        if (previousScheduleRaw == null || previousScheduleRaw.isEmpty()) {
            restored = store.removeScheduleLocked(storageKey);
        } else {
            restored = store.writeScheduleRawLocked(
                    storageKey,
                    previousScheduleRaw);
        }

        if (!restored) {
            Log.e(
                    TAG,
                    "schedule rollback persistence failed: " + storageKey);
        }
    }

    private String allocateOperationVersionLocked() {
        if (!failurePolicy.allowOrderingTokenAllocation()) {
            return null;
        }
        return store.allocateOperationVersionLocked();
    }

    private AlarmManager alarmManager() {
        return (AlarmManager) appContext.getSystemService(
                Context.ALARM_SERVICE);
    }

    private PendingIntent buildPendingIntent(
            String identityUri,
            String action,
            Class<? extends BroadcastReceiver> receiverClass,
            Bundle deliveryExtras,
            String operationVersion) {
        if (!ExactAlarmContract.isValidIdentityUri(
                identityUri)) {
            return null;
        }

        Intent intent = new Intent(
                appContext,
                receiverClass);
        intent.setAction(action);
        intent.setData(android.net.Uri.parse(identityUri));

        if (deliveryExtras != null) {
            intent.putExtras(new Bundle(deliveryExtras));
        }
        if (operationVersion != null
                && !operationVersion.isEmpty()) {
            intent.putExtra(
                    ExactAlarmContract.EXTRA_OPERATION_VERSION,
                    operationVersion);
        }

        int flags =
                PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        return PendingIntent.getBroadcast(
                appContext,
                pendingIntentRequestCode,
                intent,
                flags);
    }

    private boolean isValidScheduleRequest(
            ScheduleRequest request) {
        return request != null
                && ExactAlarmContract.isValidIdentityUri(
                        request.identityUri)
                && request.storageKey != null
                && !request.storageKey.isEmpty()
                && request.action != null
                && !request.action.isEmpty()
                && request.receiverClass != null
                && request.triggerAtEpochMs > 0L;
    }

    private static void copyFeatureMetadata(
            JSONObject source,
            JSONObject target) throws JSONException {
        if (source == null || source.names() == null) {
            return;
        }
        JSONArray names = source.names();
        for (int i = 0; i < names.length(); i++) {
            String name = names.optString(i, "");
            if (!name.isEmpty()) {
                target.put(name, source.get(name));
            }
        }
    }

    public static final class ScheduleRequest {
        public final String identityUri;
        public final String storageKey;
        public final String action;
        public final Class<? extends BroadcastReceiver> receiverClass;
        public final long triggerAtEpochMs;
        public final JSONObject featureMetadata;
        public final Bundle deliveryExtras;
        public final String expectedExistingOperationVersion;

        public ScheduleRequest(
                String identityUri,
                String storageKey,
                String action,
                Class<? extends BroadcastReceiver> receiverClass,
                long triggerAtEpochMs,
                JSONObject featureMetadata,
                Bundle deliveryExtras,
                String expectedExistingOperationVersion) {
            this.identityUri = identityUri;
            this.storageKey = storageKey;
            this.action = action;
            this.receiverClass = receiverClass;
            this.triggerAtEpochMs = triggerAtEpochMs;
            this.featureMetadata = featureMetadata;
            this.deliveryExtras = deliveryExtras;
            this.expectedExistingOperationVersion =
                    expectedExistingOperationVersion;
        }
    }

    public static final class PendingStateResult {
        public enum Status {
            PENDING,
            ABSENT,
            FAILED
        }

        public final Status status;
        public final String error;

        private PendingStateResult(Status status, String error) {
            this.status = status;
            this.error = error;
        }

        static PendingStateResult pending() {
            return new PendingStateResult(Status.PENDING, null);
        }

        static PendingStateResult absent() {
            return new PendingStateResult(Status.ABSENT, null);
        }

        static PendingStateResult failed(String error) {
            return new PendingStateResult(Status.FAILED, error);
        }

        public boolean isPending() {
            return status == Status.PENDING;
        }

        public boolean isOk() {
            return status != Status.FAILED;
        }
    }

    public static final class ScheduleResult {
        public final boolean ok;
        public final String error;
        public final String identityUri;
        public final String operationVersion;

        private ScheduleResult(
                boolean ok,
                String error,
                String identityUri,
                String operationVersion) {
            this.ok = ok;
            this.error = error;
            this.identityUri = identityUri;
            this.operationVersion = operationVersion;
        }

        public static ScheduleResult success(
                String identityUri,
                String operationVersion) {
            return new ScheduleResult(
                    true,
                    null,
                    identityUri,
                    operationVersion);
        }

        public static ScheduleResult fail(
                String error) {
            return new ScheduleResult(
                    false,
                    error,
                    null,
                    null);
        }
    }

    public static final class CancelResult {
        public enum Status {
            SUCCESS,
            ALREADY_ABSENT,
            FAILED
        }

        public final Status status;
        public final String error;

        private CancelResult(
                Status status,
                String error) {
            this.status = status;
            this.error = error;
        }

        public static CancelResult success() {
            return new CancelResult(
                    Status.SUCCESS, null);
        }

        public static CancelResult alreadyAbsent() {
            return new CancelResult(
                    Status.ALREADY_ABSENT, null);
        }

        public static CancelResult fail(
                String error) {
            return new CancelResult(
                    Status.FAILED, error);
        }

        public boolean isOk() {
            return status != Status.FAILED;
        }
    }

}