package app.drugtracker.notificationruntime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Private notification-action receiver. It never contains feature policy.
 * It forwards generic action identity to the app process and may launch the
 * app when the action explicitly requests foreground delivery.
 */
public final class NotificationRuntimeActionReceiver extends BroadcastReceiver {
    public static final String EXTRA_FOREGROUND = "notificationActionForeground";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String namespace = intent.getStringExtra(
                NotificationRuntime.EXTRA_NAMESPACE);
        String identity = intent.getStringExtra(
                NotificationRuntime.EXTRA_IDENTITY);
        String actionId = intent.getStringExtra(
                NotificationRuntime.EXTRA_ACTION_ID);

        if (namespace == null || namespace.isEmpty()
                || identity == null || identity.isEmpty()
                || actionId == null || actionId.isEmpty()) {
            return;
        }

        boolean foreground = intent.getBooleanExtra(EXTRA_FOREGROUND, false);

        if (foreground) {
            Intent launch = context.getPackageManager()
                    .getLaunchIntentForPackage(context.getPackageName());
            if (launch != null) {
                launch.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK
                                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                launch.putExtra(
                        NotificationRuntime.EXTRA_NAMESPACE,
                        namespace);
                launch.putExtra(
                        NotificationRuntime.EXTRA_IDENTITY,
                        identity);
                launch.putExtra(
                        NotificationRuntime.EXTRA_ACTION_ID,
                        actionId);
                context.startActivity(launch);
            }
        } else {
            Intent event = new Intent(
                    NotificationRuntimePlugin.ACTION_ACTION_PERFORMED);
            event.setPackage(context.getPackageName());
            event.putExtra(
                    NotificationRuntime.EXTRA_NAMESPACE,
                    namespace);
            event.putExtra(
                    NotificationRuntime.EXTRA_IDENTITY,
                    identity);
            event.putExtra(
                    NotificationRuntime.EXTRA_ACTION_ID,
                    actionId);
            context.sendBroadcast(event);
        }
    }
}
