package app.drugtracker.alarmruntime;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

/**
 * Platform pending-intent identity factory for the shared exact-alarm
 * runtime (#489 responsibility extraction).
 *
 * Owns ONLY the AlarmManager PendingIntent mechanics: intent construction
 * with the stable identity URI + delivery extras + operation-version
 * ownership marker, and the real OS pending-state lookup. Business policy,
 * durable metadata ownership, and lock semantics stay in
 * {@link ExactAlarmRuntime} — this class never reads or writes the store.
 *
 * The pending-state contract: ABSENT means the OS has no matching alarm;
 * FAILED means the state could not be determined and callers must never
 * treat it as ABSENT for destructive reconciliation.
 */
final class ExactAlarmPendingIntents {
    private static final String TAG = "ExactAlarmPendingIntents";

    private final Context appContext;
    private final int requestCode;
    /**
     * The EXACT monitor ExactAlarmRuntime uses for its transactions. The
     * pending-state lookup must serialize with schedule/cancel transactions
     * exactly as before the extraction — a different monitor would change
     * observable linearization semantics.
     */
    private final Object operationMonitor;

    ExactAlarmPendingIntents(Context context, int requestCode, Object operationMonitor) {
        this.appContext = context.getApplicationContext();
        this.requestCode = requestCode;
        this.operationMonitor = operationMonitor;
    }

    /**
     * Build the broadcast PendingIntent for a scheduled alarm, or null when
     * the identity URI is invalid. Carries a defensive copy of the delivery
     * extras plus the operation-version ownership marker.
     */
    PendingIntent build(
            String identityUri,
            String action,
            Class<? extends BroadcastReceiver> receiverClass,
            Bundle deliveryExtras,
            String operationVersion) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)) {
            return null;
        }

        Intent intent = new Intent(appContext, receiverClass);
        intent.setAction(action);
        intent.setData(android.net.Uri.parse(identityUri));

        if (deliveryExtras != null) {
            intent.putExtras(new Bundle(deliveryExtras));
        }
        if (operationVersion != null && !operationVersion.isEmpty()) {
            intent.putExtra(ExactAlarmContract.EXTRA_OPERATION_VERSION, operationVersion);
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        return PendingIntent.getBroadcast(appContext, requestCode, intent, flags);
    }

    /**
     * Query the real AlarmManager PendingIntent state. Returns
     * {@link ExactAlarmRuntime.PendingStateResult#failed} on a malformed
     * request or an OS lookup failure.
     */
    ExactAlarmRuntime.PendingStateResult queryPendingState(
            String identityUri,
            String action,
            Class<? extends BroadcastReceiver> receiverClass) {
        if (!ExactAlarmContract.isValidIdentityUri(identityUri)
                || action == null
                || action.isEmpty()
                || receiverClass == null) {
            return ExactAlarmRuntime.PendingStateResult.failed("invalid_pending_request");
        }
        synchronized (operationMonitor) {
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
                        requestCode,
                        intent,
                        flags);
                return pendingIntent == null
                        ? ExactAlarmRuntime.PendingStateResult.absent()
                        : ExactAlarmRuntime.PendingStateResult.pending();
            } catch (Exception e) {
                Log.e(TAG, "pending-state lookup failed", e);
                return ExactAlarmRuntime.PendingStateResult.failed(
                        "pending_state_lookup_failed");
            }
        }
    }

    /** Shared AlarmManager lookup (platform service accessor). */
    AlarmManager alarmManager(Context context) {
        return (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }
}
