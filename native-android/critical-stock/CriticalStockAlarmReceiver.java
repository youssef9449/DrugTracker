package app.drugtracker.criticalstock;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import app.drugtracker.alarmruntime.ExactAlarmContract;
import app.drugtracker.notificationruntime.NotificationRuntime;

/**
 * Exact-alarm delivery for one future Critical Stock notification.
 * Alarm timing and notification presentation are intentionally separate.
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
                String medicationName = intent.getStringExtra("medicationName");
                String unit = intent.getStringExtra("unit");
                String operationVersion = intent.getStringExtra(
                        ExactAlarmContract.EXTRA_OPERATION_VERSION);

                if (medicationId == null || medicationId.isEmpty()) return;

                new NotificationRuntime(appContext).post(
                        new NotificationRuntime.Request(
                                "critical-stock",
                                medicationId,
                                "🚨 " + medicationName + ": اقترب النفاد الحرج",
                                "مخزون \"" + medicationName
                                        + "\" دخل مرحلة النفاد الحرج ("
                                        + (unit == null ? "قرص" : unit)
                                        + "). يرجى التعبئة فوراً!",
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
