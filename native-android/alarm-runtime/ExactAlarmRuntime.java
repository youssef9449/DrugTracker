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

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Shared native exact-alarm runtime.
 *
 * <p>The durable scheduling transaction is:
 * lock -> durable metadata -> AlarmManager install -> ownership-safe rollback.</p>
 *
 * <p>The durable cancellation transaction is:
 * lock -> durable tombstone -> AlarmManager.cancel -> metadata removal.</p>
 */
public final class ExactAlarmRuntime {
    private static final String TAG = "ExactAlarmRuntime";
    private static final String TYPE = "type";
    private static final String VALUE = "value";

    private final Context appContext;
    private final ExactAlarmStore store;
    private final int pendingIntentRequestCode;

    public volatile boolean forceOrderingTokenAllocationFailureForTest;
    public volatile boolean forceTombstoneCommitFailureForTest;
    public volatile boolean forceScheduleMetadataRemovalFailureForTest;

    public ExactAlarmRuntime(
            Context context,
            String schedulesPrefsName,
            String cancellationsPrefsName,
            String orderingPrefsName,
            int pendingIntentRequestCode) {
        appContext = context.getApplicationContext();
        store = new ExactAlarmStore(
                appContext,
                schedulesPrefsName,
                cancellationsPrefsName,
                orderingPrefsName);
        this.pendingIntentRequestCode = pendingIntentRequestCode;
    }

    public ExactAlarmStore store() {
        return store;
    }

    public boolean canScheduleExactAlarms() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = alarmManager();
        return manager != null && manager.canScheduleExactAlarms();
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
            if (request.expectedExistingOperationVersion != null
                    && !ExactAlarmStore.isMetadataOwnedByOperationVersion(
                            store.getScheduleRaw(
                                    request.storageKey),
                            request.expectedExistingOperationVersion)) {
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
                        ExactAlarmContract.FIELD_CALENDAR_DATE,
                        request.calendarDate);
                metadata.put(
                        ExactAlarmContract.FIELD_TIME_HHMM,
                        request.timeHhmm);
                metadata.put(
                        ExactAlarmContract.FIELD_TRIGGER_AT_EPOCH_MS,
                        request.triggerAtEpochMs);
                metadata.put(
                        ExactAlarmContract.FIELD_DELIVERY_EXTRAS,
                        bundleToJson(
                                request.deliveryExtras));
                metadata.put(
                        ExactAlarmContract.FIELD_RESTORE_ON_LIFECYCLE,
                        request.restoreOnLifecycle);
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
                        operationVersion);
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
                            operationVersion);
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
                        operationVersion);
                return ScheduleResult.fail(
                        "exact_alarm_permission_denied");
            } catch (Exception e) {
                Log.e(TAG, "exact alarm install failed", e);
                rollbackScheduleLocked(
                        request.storageKey,
                        operationVersion);
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
                if (forceTombstoneCommitFailureForTest
                        || !store.writeCancellationTombstoneLocked(
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

            if (forceScheduleMetadataRemovalFailureForTest
                    || !store.removeScheduleLocked(
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

    public boolean isEffectivelyCancelled(
            String storageKey) {
        if (storageKey == null || storageKey.isEmpty()) {
            return false;
        }
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.isEffectivelyCancelledLocked(storageKey);
        }
    }

    public JSONObject getScheduleMetadata(
            String storageKey) {
        String raw = store.getScheduleRaw(storageKey);
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return null;
        }
    }

    public boolean removeScheduleIfOwned(
            String storageKey,
            String expectedOperationVersion) {
        if (storageKey == null || storageKey.isEmpty()) {
            return false;
        }
        synchronized (ExactAlarmOperationLock.LOCK) {
            return store.removeScheduleIfOwnedLocked(
                    storageKey,
                    expectedOperationVersion);
        }
    }

    public List<JSONObject> listScheduledMetadata() {
        List<JSONObject> result = new ArrayList<>();
        synchronized (ExactAlarmOperationLock.LOCK) {
            for (String storageKey
                    : store.listFeatureStorageKeys()) {
                String raw =
                        store.getScheduleRaw(storageKey);
                if (raw == null || raw.isEmpty()) continue;
                try {
                    JSONObject metadata =
                            new JSONObject(raw);
                    metadata.put(
                            ExactAlarmContract.FIELD_STORAGE_KEY,
                            storageKey);
                    result.add(metadata);
                } catch (JSONException e) {
                    Log.w(TAG,
                            "malformed schedule metadata: "
                                    + storageKey);
                }
            }
        }
        return result;
    }

    /**
     * Reinstall a durable row after lifecycle recovery. The caller supplies the
     * current local-date-derived epoch and the expected ownership token.
     */
    public ScheduleResult restore(
            String identityUri,
            String storageKey,
            String expectedOperationVersion,
            long triggerAtEpochMs) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)
                || storageKey == null
                || storageKey.isEmpty()
                || expectedOperationVersion == null
                || expectedOperationVersion.isEmpty()
                || triggerAtEpochMs
                        <= System.currentTimeMillis() - 2000L) {
            return ScheduleResult.fail(
                    "invalid_restore_request");
        }

        JSONObject raw =
                getScheduleMetadata(storageKey);
        if (raw == null) {
            return ScheduleResult.fail(
                    "schedule_absent");
        }

        if (!expectedOperationVersion.equals(
                ExactAlarmStore.extractOperationVersion(raw))) {
            return ScheduleResult.fail("ownership_lost");
        }

        try {
            String action = raw.optString(
                    ExactAlarmContract.FIELD_ACTION, "");
            String receiverName = raw.optString(
                    ExactAlarmContract.FIELD_RECEIVER_CLASS,
                    "");
            Class<? extends BroadcastReceiver> receiver =
                    resolveReceiverClass(receiverName);
            if (action.isEmpty() || receiver == null) {
                return ScheduleResult.fail(
                        "restore_metadata_invalid");
            }

            Bundle extras = jsonToBundle(
                    raw.optJSONObject(
                            ExactAlarmContract.FIELD_DELIVERY_EXTRAS));
            JSONObject featureMetadata =
                    new JSONObject(raw.toString());
            removeCoreFields(featureMetadata);

            return schedule(new ScheduleRequest(
                    identityUri,
                    storageKey,
                    action,
                    receiver,
                    raw.optString(
                            ExactAlarmContract.FIELD_CALENDAR_DATE,
                            ""),
                    raw.optString(
                            ExactAlarmContract.FIELD_TIME_HHMM,
                            ""),
                    triggerAtEpochMs,
                    featureMetadata,
                    extras,
                    expectedOperationVersion,
                    raw.optBoolean(
                            ExactAlarmContract.FIELD_RESTORE_ON_LIFECYCLE,
                            true)));
        } catch (JSONException e) {
            return ScheduleResult.fail(
                    "restore_metadata_invalid");
        }
    }

    private void rollbackScheduleLocked(
            String storageKey,
            String expectedOperationVersion) {
        if (!store.removeScheduleIfOwnedLocked(
                storageKey,
                expectedOperationVersion)) {
            Log.w(TAG,
                    "ownership-safe rollback skipped: "
                            + storageKey);
        }
    }

    private String allocateOperationVersionLocked() {
        if (forceOrderingTokenAllocationFailureForTest) {
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
                && isValidCalendarDate(
                        request.calendarDate)
                && isValidTimeHhmm(
                        request.timeHhmm)
                && request.triggerAtEpochMs > 0L;
    }

    private Class<? extends BroadcastReceiver> resolveReceiverClass(
            String name) {
        if (name == null
                || !name.startsWith(
                        appContext.getPackageName() + ".")) {
            return null;
        }
        try {
            Class<?> clazz = Class.forName(name);
            if (!BroadcastReceiver.class.isAssignableFrom(
                    clazz)) {
                return null;
            }
            @SuppressWarnings("unchecked")
            Class<? extends BroadcastReceiver> receiver =
                    (Class<? extends BroadcastReceiver>) clazz;
            return receiver;
        } catch (Exception e) {
            Log.e(TAG,
                    "failed to resolve receiver: " + name,
                    e);
            return null;
        }
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

    public static JSONObject bundleToJson(
            Bundle bundle) {
        JSONObject out = new JSONObject();
        if (bundle == null) return out;

        for (String key : bundle.keySet()) {
            Object value = bundle.get(key);
            JSONObject entry = new JSONObject();
            try {
                if (value instanceof String) {
                    entry.put(TYPE, "string");
                } else if (value instanceof Long) {
                    entry.put(TYPE, "long");
                } else if (value instanceof Integer) {
                    entry.put(TYPE, "int");
                } else if (value instanceof Double) {
                    entry.put(TYPE, "double");
                } else if (value instanceof Boolean) {
                    entry.put(TYPE, "boolean");
                } else {
                    throw new IllegalArgumentException(
                            "unsupported delivery extra: " + key);
                }
                entry.put(VALUE, value);
                out.put(key, entry);
            } catch (JSONException e) {
                throw new IllegalArgumentException(
                        "delivery extra serialization failed",
                        e);
            }
        }
        return out;
    }

    public static Bundle jsonToBundle(
            JSONObject json) throws JSONException {
        Bundle out = new Bundle();
        if (json == null || json.names() == null) {
            return out;
        }

        JSONArray names = json.names();
        for (int i = 0; i < names.length(); i++) {
            String key = names.optString(i, "");
            JSONObject entry = json.optJSONObject(key);
            if (key.isEmpty() || entry == null) continue;

            String type = entry.optString(TYPE, "");
            if ("string".equals(type)) {
                out.putString(key, entry.optString(VALUE, ""));
            } else if ("long".equals(type)) {
                out.putLong(key, entry.optLong(VALUE, 0L));
            } else if ("int".equals(type)) {
                out.putInt(key, entry.optInt(VALUE, 0));
            } else if ("double".equals(type)) {
                out.putDouble(
                        key,
                        entry.optDouble(
                                VALUE, Double.NaN));
            } else if ("boolean".equals(type)) {
                out.putBoolean(
                        key,
                        entry.optBoolean(VALUE, false));
            }
        }
        return out;
    }

    public static Long computeEpochMs(
            String calendarDate,
            String timeHhmm) {
        if (!isValidCalendarDate(calendarDate)
                || !isValidTimeHhmm(timeHhmm)) {
            return null;
        }
        try {
            int year = Integer.parseInt(
                    calendarDate.substring(0, 4));
            int month = Integer.parseInt(
                    calendarDate.substring(5, 7));
            int day = Integer.parseInt(
                    calendarDate.substring(8, 10));

            int colon = timeHhmm.indexOf(':');
            int hour = Integer.parseInt(
                    timeHhmm.substring(0, colon));
            int minute = Integer.parseInt(
                    timeHhmm.substring(colon + 1));

            Calendar calendar = Calendar.getInstance(
                    TimeZone.getDefault(),
                    Locale.getDefault());
            calendar.clear();
            calendar.set(
                    Calendar.YEAR, year);
            calendar.set(
                    Calendar.MONTH, month - 1);
            calendar.set(
                    Calendar.DAY_OF_MONTH, day);
            calendar.set(
                    Calendar.HOUR_OF_DAY, hour);
            calendar.set(
                    Calendar.MINUTE, minute);
            calendar.set(Calendar.SECOND, 0);
            calendar.set(Calendar.MILLISECOND, 0);
            return calendar.getTimeInMillis();
        } catch (Exception e) {
            return null;
        }
    }

    public static String nextCalendarDate(
            String calendarDate) {
        if (!isValidCalendarDate(calendarDate)) {
            return null;
        }
        try {
            int year = Integer.parseInt(
                    calendarDate.substring(0, 4));
            int month = Integer.parseInt(
                    calendarDate.substring(5, 7));
            int day = Integer.parseInt(
                    calendarDate.substring(8, 10));

            Calendar calendar = Calendar.getInstance(
                    TimeZone.getDefault(),
                    Locale.getDefault());
            calendar.clear();
            calendar.set(Calendar.YEAR, year);
            calendar.set(Calendar.MONTH, month - 1);
            calendar.set(Calendar.DAY_OF_MONTH, day);
            calendar.set(Calendar.HOUR_OF_DAY, 0);
            calendar.set(Calendar.MINUTE, 0);
            calendar.set(Calendar.SECOND, 0);
            calendar.set(Calendar.MILLISECOND, 0);
            calendar.add(Calendar.DAY_OF_MONTH, 1);

            return String.format(
                    Locale.US,
                    "%04d-%02d-%02d",
                    calendar.get(Calendar.YEAR),
                    calendar.get(Calendar.MONTH) + 1,
                    calendar.get(Calendar.DAY_OF_MONTH));
        } catch (Exception e) {
            return null;
        }
    }

    public static boolean isValidCalendarDate(
            String date) {
        if (date == null || date.length() != 10) {
            return false;
        }
        for (int i = 0; i < 10; i++) {
            char c = date.charAt(i);
            if (i == 4 || i == 7) {
                if (c != '-') return false;
            } else if (c < '0' || c > '9') {
                return false;
            }
        }

        try {
            int year = Integer.parseInt(
                    date.substring(0, 4));
            int month = Integer.parseInt(
                    date.substring(5, 7));
            int day = Integer.parseInt(
                    date.substring(8, 10));
            if (month < 1 || month > 12 || day < 1) {
                return false;
            }

            int maxDay;
            switch (month) {
                case 2:
                    boolean leap = year % 4 == 0
                            && (year % 100 != 0
                            || year % 400 == 0);
                    maxDay = leap ? 29 : 28;
                    break;
                case 4:
                case 6:
                case 9:
                case 11:
                    maxDay = 30;
                    break;
                default:
                    maxDay = 31;
            }
            return day <= maxDay;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public static boolean isValidTimeHhmm(
            String time) {
        if (time == null
                || time.length() < 4
                || time.length() > 5) {
            return false;
        }
        int colon = time.indexOf(':');
        if (colon < 1) return false;
        try {
            int hour = Integer.parseInt(
                    time.substring(0, colon));
            int minute = Integer.parseInt(
                    time.substring(colon + 1));
            return hour >= 0 && hour <= 23
                    && minute >= 0 && minute <= 59;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    public static final class ScheduleRequest {
        public final String identityUri;
        public final String storageKey;
        public final String action;
        public final Class<? extends BroadcastReceiver> receiverClass;
        public final String calendarDate;
        public final String timeHhmm;
        public final long triggerAtEpochMs;
        public final JSONObject featureMetadata;
        public final Bundle deliveryExtras;
        public final String expectedExistingOperationVersion;
        public final boolean restoreOnLifecycle;

        public ScheduleRequest(
                String identityUri,
                String storageKey,
                String action,
                Class<? extends BroadcastReceiver> receiverClass,
                String calendarDate,
                String timeHhmm,
                long triggerAtEpochMs,
                JSONObject featureMetadata,
                Bundle deliveryExtras,
                String expectedExistingOperationVersion,
                boolean restoreOnLifecycle) {
            this.identityUri = identityUri;
            this.storageKey = storageKey;
            this.action = action;
            this.receiverClass = receiverClass;
            this.calendarDate = calendarDate;
            this.timeHhmm = timeHhmm;
            this.triggerAtEpochMs = triggerAtEpochMs;
            this.featureMetadata = featureMetadata;
            this.deliveryExtras = deliveryExtras;
            this.expectedExistingOperationVersion =
                    expectedExistingOperationVersion;
            this.restoreOnLifecycle = restoreOnLifecycle;
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

    private static void removeCoreFields(
            JSONObject metadata) {
        metadata.remove(
                ExactAlarmContract.FIELD_OPERATION_VERSION);
        metadata.remove(
                ExactAlarmContract.LEGACY_FIELD_SCHEDULE_VERSION);
        metadata.remove(
                ExactAlarmContract.FIELD_IDENTITY_URI);
        metadata.remove(
                ExactAlarmContract.FIELD_STORAGE_KEY);
        metadata.remove(
                ExactAlarmContract.FIELD_ACTION);
        metadata.remove(
                ExactAlarmContract.FIELD_RECEIVER_CLASS);
        metadata.remove(
                ExactAlarmContract.FIELD_CALENDAR_DATE);
        metadata.remove(
                ExactAlarmContract.FIELD_TIME_HHMM);
        metadata.remove(
                ExactAlarmContract.FIELD_TRIGGER_AT_EPOCH_MS);
        metadata.remove(
                ExactAlarmContract.FIELD_DELIVERY_EXTRAS);
        metadata.remove(
                ExactAlarmContract.FIELD_RESTORE_ON_LIFECYCLE);
    }
}