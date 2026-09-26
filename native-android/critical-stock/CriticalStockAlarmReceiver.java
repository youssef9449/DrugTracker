package app.drugtracker.criticalstock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.alarmruntime.ExactAlarmRuntime;
import app.drugtracker.notificationruntime.NotificationRuntime;

/**
 * Private delivery plumbing for the Critical Stock alarm.
 * It contains no Critical Stock business policy or notification content.
 */
public final class CriticalStockAlarmReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null
                || !CriticalStockAlarmAdapter.ACTION_CRITICAL_STOCK.equals(
                        intent.getAction())) {
            return;
        }

        BroadcastReceiver.PendingResult pendingResult = goAsync();
        Context appContext = context.getApplicationContext();
        new Thread(() -> {
            try {
                String medicationId = intent.getStringExtra("medicationId");
                String notificationTitle =
                        intent.getStringExtra("notificationTitle");
                String notificationBody =
                        intent.getStringExtra("notificationBody");
                String operationVersion = intent.getStringExtra(
                        ExactAlarmContract.EXTRA_OPERATION_VERSION);

                if (medicationId == null || medicationId.isEmpty()
                        || notificationTitle == null
                        || notificationBody == null
                        || operationVersion == null
                        || operationVersion.isEmpty()) {
                    return;
                }

                CriticalStockAlarmAdapter adapter =
                        new CriticalStockAlarmAdapter(appContext);

                // Durable ownership is checked and delivery is claimed
                // under the shared lock. The claim is the linearization point;
                // slow notification I/O happens after the lock is released.
                if (adapter.isOneShotDelivered(medicationId)) {
                    adapter.completeOneShot(medicationId, operationVersion);
                    return;
                }

                if (!adapter.claimOneShotDelivery(
                        medicationId,
                        operationVersion)) {
                    return;
                }

                NotificationRuntime.PostResult postResult;
                try {
                    postResult = new NotificationRuntime(appContext).post(
                            new NotificationRuntime.Request(
                                    "critical-stock",
                                    medicationId,
                                    notificationTitle,
                                    notificationBody,
                                    "low-stock",
                                    "تنبيهات النفاذ",
                                    4,
                                    1,
                                    "ic_launcher",
                                    true,
                                    false,
                                    null));
                } catch (RuntimeException e) {
                    adapter.releaseOneShotDeliveryClaim(
                            medicationId,
                            operationVersion);
                    throw e;
                }

                if (!postResult.accepted) {
                    // Keep the durable one-shot intact so recovery/retry can
                    // claim it again after the notification attempt fails.
                    adapter.releaseOneShotDeliveryClaim(
                            medicationId,
                            operationVersion);
                    return;
                }

                // Delivery is accepted before the durable one-shot is consumed.
                // If evidence persistence fails, release the claim and leave
                // the schedule recoverable instead of losing it.
                if (!adapter.markOneShotDelivered(
                        medicationId,
                        operationVersion)) {
                    android.util.Log.w(
                            "CriticalStockAlarmReceiver",
                            "delivery evidence persistence failed for "
                                    + medicationId);
                    adapter.releaseOneShotDeliveryClaim(
                            medicationId,
                            operationVersion);
                    return;
                }

                boolean completed = adapter.completeOneShot(
                        medicationId,
                        operationVersion);
                if (!completed) {
                    android.util.Log.w(
                            "CriticalStockAlarmReceiver",
                            "one-shot completion failed for "
                                    + medicationId);
                }
            } finally {
                pendingResult.finish();
            }
        }, "critical-stock-alarm").start();
    }
}
