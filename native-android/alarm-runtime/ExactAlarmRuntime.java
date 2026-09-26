package app.drugtracker.alarmruntime;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;


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

    /** Private process-wide monitor; never exposed to callers. */
    private static final class OperationLock {
        private OperationLock() {}
    }

    /**
     * Bridge operations that can reach durable alarm persistence are dispatched
     * here so the Capacitor plugin handler thread never waits on disk I/O.
     * The executor is process-wide and ordered; the existing OperationLock still
     * owns the actual cross-feature transaction serialization.
     */
    private static final ExecutorService BACKGROUND_EXECUTOR =
            Executors.newSingleThreadExecutor(new ThreadFactory() {
                @Override
                public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(
                            runnable,
                            "DrugTracker-ExactAlarmRuntime");
                    thread.setDaemon(true);
                    return thread;
                }
            });

    /**
     * Run a caller-supplied exact-alarm operation away from the Capacitor plugin
     * dispatch thread. Persistence inside the operation remains synchronous so
     * durability/failure semantics are unchanged.
     */
    public static void executeAsync(Runnable action) {
        if (action == null) return;
        BACKGROUND_EXECUTOR.execute(action);
    }

    private final Context appContext;
    private final ExactAlarmStore store;
    private final int pendingIntentRequestCode;
    private final FailurePolicy failurePolicy;
    /** Platform pending-intent identity mechanics (#489 extraction). */
    private final ExactAlarmPendingIntents pendingIntents;

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
        this.pendingIntents = new ExactAlarmPendingIntents(
                appContext, pendingIntentRequestCode, OperationLock.class);
    }


    /** Execute a caller-owned delivery transaction under the shared runtime lock. */
    public static void runWithOperationLock(Runnable action) {
        if (action == null) return;
        synchronized (OperationLock.class) {
            action.run();
        }
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
        synchronized (OperationLock.class) {
            return store.getScheduleRaw(storageKey);
        }
    }

    /** Feature-neutral snapshot of all durable schedule metadata keyed by storage identity. */
    public java.util.Map<String, String> listScheduleMetadata() {
        synchronized (OperationLock.class) {
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
        synchronized (OperationLock.class) {
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
        synchronized (OperationLock.class) {
            return store.removeScheduleIfOwnedLocked(
                    storageKey, expectedOperationVersion);
        }
    }

    public boolean hasCancellationTombstone(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (OperationLock.class) {
            return store.hasCancellationTombstoneLocked(storageKey);
        }
    }

    public boolean isEffectivelyCancelled(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (OperationLock.class) {
            return store.isEffectivelyCancelledLocked(storageKey);
        }
    }

    public boolean clearCancellationTombstone(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return true;
        synchronized (OperationLock.class) {
            return store.removeCancellationTombstoneLocked(storageKey);
        }
    }

    public boolean canScheduleExactAlarms() {
        return canScheduleExactAlarms(appContext);
    }

    /** Snapshot of one durable schedule row. The returned object is a defensive copy. */
    public JSONObject getScheduleMetadata(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return null;
        synchronized (OperationLock.class) {
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
        synchronized (OperationLock.class) {
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
        synchronized (OperationLock.class) {
            return store.removeScheduleIfOwnedLocked(
                    storageKey,
                    expectedOperationVersion);
        }
    }

    /**
     * Record that a durable one-shot delivery was accepted while preserving
     * the operation-version ownership boundary. Feature adapters may use this
     * as idempotent delivery evidence when completion persistence fails.
     */
    public boolean markOneShotDelivered(
            String storageKey,
            String expectedOperationVersion) {
        if (storageKey == null || storageKey.isEmpty()
                || expectedOperationVersion == null
                || expectedOperationVersion.isEmpty()) {
            return false;
        }
        synchronized (OperationLock.class) {
            String raw = store.getScheduleRaw(storageKey);
            if (!ExactAlarmContract.isMetadataOwnedByOperationVersion(
                    raw,
                    expectedOperationVersion)) {
                return false;
            }
            try {
                JSONObject metadata = new JSONObject(raw);
                metadata.put("deliveryState", "accepted");
                boolean written = store.writeScheduleRawLocked(
                        storageKey,
                        metadata.toString());
                return written;
            } catch (JSONException | RuntimeException e) {
                return false;
            }
        }
    }

    /**
     * Check durable one-shot delivery evidence without treating missing or
     * malformed metadata as delivered.
     */
    public boolean isOneShotDelivered(String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) return false;
        synchronized (OperationLock.class) {
            String raw = store.getScheduleRaw(storageKey);
            if (raw == null || raw.isEmpty()) return false;
            try {
                return "accepted".equals(
                        new JSONObject(raw).optString(
                                "deliveryState",
                                ""));
            } catch (JSONException | RuntimeException e) {
                return false;
            }
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
        return pendingIntents.queryPendingState(identityUri, action, receiverClass);
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
        synchronized (OperationLock.class) {
            return ExactAlarmContract.isMetadataOwnedByOperationVersion(
                    store.getScheduleRaw(storageKey),
                    expectedOperationVersion)
                    && !store.isEffectivelyCancelledLocked(storageKey);
        }
    }

    /**
     * Grace window (ms) for schedules whose trigger time has just passed:
     * a schedule is rejected as past only when it is older than this
     * tolerance, so clock jitter between JS and native never rejects a
     * legitimately-current occurrence (#513 named constants).
     */
    private static final long EXACT_ALARM_PAST_GRACE_MS = 2000L;

    public ScheduleResult schedule(ScheduleRequest request) {
        // Focused transaction steps (#468): validation, ownership, record
        // preparation, platform installation, and tombstone finalization are
        // extracted; the transaction ORDER and lock semantics are unchanged.
        String preconditionError = validateSchedulePreconditions(request);
        if (preconditionError != null) {
            return ScheduleResult.fail(preconditionError);
        }

        synchronized (OperationLock.class) {
            String previousScheduleRaw =
                    store.getScheduleRaw(request.storageKey);

            String ownershipError =
                    verifyScheduleOwnershipLocked(request);
            if (ownershipError != null) {
                return ScheduleResult.fail(ownershipError);
            }

            String operationVersion =
                    allocateOperationVersionLocked();
            if (operationVersion == null) {
                return ScheduleResult.fail(
                        "ordering_sequence_write_failed");
            }

            JSONObject metadata =
                    buildScheduleMetadata(request, operationVersion);
            if (metadata == null) {
                return ScheduleResult.fail("metadata_build_failed");
            }

            if (!store.writeScheduleLocked(
                    request.storageKey,
                    metadata)) {
                return ScheduleResult.fail(
                        "schedule_metadata_write_failed");
            }

            String installError = installExactAlarmLocked(
                    request,
                    operationVersion,
                    previousScheduleRaw);
            if (installError != null) {
                return ScheduleResult.fail(installError);
            }

            finalizeTombstoneStateLocked(request, operationVersion);

            return ScheduleResult.success(
                    request.identityUri,
                    operationVersion);
        }
    }

    /** Request validation + capability preconditions outside the lock. */
    private String validateSchedulePreconditions(ScheduleRequest request) {
        if (!isValidScheduleRequest(request)) {
            return "invalid_request";
        }
        if (request.triggerAtEpochMs
                <= System.currentTimeMillis() - EXACT_ALARM_PAST_GRACE_MS) {
            return "trigger_in_past";
        }
        if (!canScheduleExactAlarms()) {
            return "exact_alarm_permission_denied";
        }
        return null;
    }

    /**
     * Ownership verification inside the transaction: recovery/re-arm requests
     * may replace only the exact schedule version they read, and a newer
     * cancellation tombstone must not be superseded by a restored version.
     */
    private String verifyScheduleOwnershipLocked(ScheduleRequest request) {
        if (request.expectedExistingOperationVersion != null
                && !ExactAlarmContract.isMetadataOwnedByOperationVersion(
                        store.getScheduleRaw(
                                request.storageKey),
                        request.expectedExistingOperationVersion)) {
            return "ownership_lost";
        }
        if (request.expectedExistingOperationVersion != null
                && !request.expectedExistingOperationVersion.isEmpty()
                && store.isEffectivelyCancelledLocked(request.storageKey)) {
            return "ownership_lost";
        }
        return null;
    }

    /** Prepare the durable metadata record for this operation version. */
    private JSONObject buildScheduleMetadata(
            ScheduleRequest request,
            String operationVersion) {
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
            return null;
        }
        return metadata;
    }

    /**
     * Platform installation with ownership-safe rollback. Returns null on
     * success, or the failure token after rollback already ran.
     */
    private String installExactAlarmLocked(
            ScheduleRequest request,
            String operationVersion,
            String previousScheduleRaw) {
        AlarmManager manager = pendingIntents.alarmManager(appContext);
        if (manager == null) {
            rollbackScheduleLocked(
                    request.storageKey,
                    operationVersion,
                    previousScheduleRaw);
            return "alarm_manager_unavailable";
        }

        try {
            PendingIntent pendingIntent =
                    pendingIntents.build(
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
                return "pending_intent_build_failed";
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
            return "exact_alarm_permission_denied";
        } catch (Exception e) {
            Log.e(TAG, "exact alarm install failed", e);
            rollbackScheduleLocked(
                    request.storageKey,
                    operationVersion,
                    previousScheduleRaw);
            return "schedule_failed";
        }
        return null;
    }

    /**
     * A fresh feature-owned schedule is an explicit new desired state, so it
     * legitimately supersedes any prior cancellation tombstone once
     * AlarmManager has accepted the new alarm. Restore/re-arm requests carry
     * expectedExistingOperationVersion and must still respect a newer
     * cancellation, handled by the ownership checks above.
     */
    private void finalizeTombstoneStateLocked(
            ScheduleRequest request,
            String operationVersion) {
        if (request.expectedExistingOperationVersion == null
                || request.expectedExistingOperationVersion.isEmpty()) {
            if (!store.removeCancellationTombstoneLocked(request.storageKey)
                    && store.hasCancellationTombstoneLocked(request.storageKey)) {
                Log.w(TAG, "failed to clear superseded tombstone: "
                        + request.storageKey);
            }
        } else {
            store.clearCancellationIfSupersededLocked(
                    request.storageKey,
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

        synchronized (OperationLock.class) {
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

            AlarmManager manager = pendingIntents.alarmManager(appContext);
            if (manager == null) {
                return CancelResult.fail(
                        "alarm_manager_unavailable");
            }

            try {
                PendingIntent pendingIntent =
                        pendingIntents.build(
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

        synchronized (OperationLock.class) {
            AlarmManager manager = pendingIntents.alarmManager(appContext);
            if (manager == null) return false;

            PendingIntent pendingIntent = pendingIntents.build(
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

        synchronized (OperationLock.class) {
            AlarmManager manager = pendingIntents.alarmManager(appContext);
            if (manager == null) return false;
            try {
                PendingIntent pendingIntent = pendingIntents.build(
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
     * Roll back a failed schedule installation without discarding a previous
     * durable schedule that was owned before this operation began.
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