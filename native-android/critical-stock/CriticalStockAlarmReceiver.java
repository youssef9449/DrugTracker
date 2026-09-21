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
                        || notificationBody == null) {
                    return;
                }

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

                if (operationVersion != null && !operationVersion.isEmpty()) {
                    new CriticalStockAlarmAdapter(appContext)
                            .completeOneShot(medicationId, operationVersion);
                }
            } finally {
                pendingResult.finish();
            }
        }, "critical-stock-alarm").start();
    }
}
