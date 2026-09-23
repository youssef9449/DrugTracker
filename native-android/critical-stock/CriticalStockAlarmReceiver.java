package app.drugtracker.criticalstock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import app.drugtracker.alarmruntime.ExactAlarmContract;
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

        PendingResult pendingResult = goAsync();
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

                // Delivery ownership is checked BEFORE any user-facing side
                // effect. A cancelled/replaced/tombstoned operation can never
                // leak a stale notification.
                if (!new app.drugtracker.alarmruntime.ExactAlarmRuntime(
                        appContext,
                        "drugtracker_critical_stock_alarm_schedules_v1",
                        "drugtracker_critical_stock_alarm_cancelled_v1",
                        "drugtracker_critical_stock_alarm_ordering_v1",
                        0xC71C001)
                        .ownsActiveSchedule(
                                CriticalStockAlarmAdapter.occurrenceKey(medicationId),
                                operationVersion)) {
                    return;
                }

                // If notification delivery succeeded but durable one-shot
                // completion failed, recovery may re-fire this same operation.
                // Durable delivery evidence makes that replay idempotent.
                if (adapter.isOneShotDelivered(medicationId)) {
                    adapter.completeOneShot(medicationId, operationVersion);
                    return;
                }

                NotificationRuntime.PostResult postResult =
                        new NotificationRuntime(appContext).post(
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

                if (!postResult.accepted) {
                    // Keep the durable one-shot intact. Lifecycle recovery can
                    // re-arm it, and NotificationRuntime retains its own
                    // delivery retry evidence.
                    return;
                }

                // Delivery is accepted before the durable schedule can be
                // consumed. If this persistence step fails, completion is not
                // attempted, leaving a recoverable schedule instead of
                // silently losing evidence.
                if (!adapter.markOneShotDelivered(
                        medicationId,
                        operationVersion)) {
                    android.util.Log.w(
                            "CriticalStockAlarmReceiver",
                            "delivery evidence persistence failed for "
                                    + medicationId);
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
