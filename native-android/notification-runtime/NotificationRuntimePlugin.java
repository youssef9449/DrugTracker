package app.drugtracker.notificationruntime;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge for the shared Android notification-delivery runtime.
 *
 * <p>The plugin bridges generic notification posting/cancellation and generic
 * delivered/action events. It does not schedule alarms.</p>
 */
@CapacitorPlugin(name = "NotificationRuntime")
public final class NotificationRuntimePlugin extends Plugin {
    public static final String ACTION_ACTION_PERFORMED =
            "app.drugtracker.notificationruntime.ACTION_PERFORMED";

    private static volatile NotificationRuntimePlugin instance;
    private BroadcastReceiver postedReceiver;
    private BroadcastReceiver actionReceiver;

    @Override
    public void load() {
        super.load();
        instance = this;

        postedReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!NotificationRuntime.ACTION_NOTIFICATION_POSTED.equals(
                        intent.getAction())) {
                    return;
                }
                if (!AppForegroundState.isForeground()) {
                    return;
                }
                JSObject event = new JSObject();
                event.put(
                        "namespace",
                        intent.getStringExtra(NotificationRuntime.EXTRA_NAMESPACE));
                event.put(
                        "identity",
                        intent.getStringExtra(NotificationRuntime.EXTRA_IDENTITY));
                notifyListeners("notificationReceived", event, true);
            }
        };

        actionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                dispatchActionIntent(intent);
            }
        };

        ContextCompat.registerReceiver(
                getContext(),
                postedReceiver,
                new IntentFilter(NotificationRuntime.ACTION_NOTIFICATION_POSTED),
                ContextCompat.RECEIVER_NOT_EXPORTED);
        ContextCompat.registerReceiver(
                getContext(),
                actionReceiver,
                new IntentFilter(ACTION_ACTION_PERFORMED),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @PluginMethod
    public void post(PluginCall call) {
        String namespace = call.getString("namespace");
        String identity = call.getString("identity");
        String title = call.getString("title");
        String body = call.getString("body");
        String channelId = call.getString("channelId");
        String channelName = call.getString("channelName", channelId);
        Integer importance = call.getInt("channelImportance");
        Integer visibility = call.getInt("channelVisibility");
        String smallIcon = call.getString("smallIcon", "ic_launcher");
        Boolean autoCancel = call.getBoolean("autoCancel", true);
        Boolean ongoing = call.getBoolean("ongoing", false);

        if (importance == null) importance = 4;
        if (visibility == null) visibility = 1;

        String actionId = call.getString("actionId", "");
        String actionTitle = call.getString("actionTitle", "");
        boolean actionForeground = call.getBoolean("actionForeground", false);
        NotificationRuntime.Action action = null;
        if (!actionId.isEmpty() && !actionTitle.isEmpty()) {
            action = new NotificationRuntime.Action(
                    actionId,
                    actionTitle,
                    actionForeground);
        }

        NotificationRuntime runtime =
                new NotificationRuntime(getContext());
        NotificationRuntime.PostResult result = runtime.post(
                new NotificationRuntime.Request(
                        namespace,
                        identity,
                        title,
                        body,
                        channelId,
                        channelName,
                        importance,
                        visibility,
                        smallIcon,
                        autoCancel,
                        ongoing,
                        action));

        JSObject ret = new JSObject();
        ret.put("ok", result.accepted);
        if (result.error != null) {
            ret.put("error", result.error);
            ret.put("code", result.error);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String namespace = call.getString("namespace");
        String identity = call.getString("identity");
        NotificationRuntime.CancelResult result = new NotificationRuntime(getContext())
                .cancel(namespace, identity);
        JSObject ret = new JSObject();
        ret.put("ok", result.accepted);
        if (result.error != null) {
            ret.put("error", result.error);
            ret.put("code", result.error);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void retryPersistedNotificationDeliveries(PluginCall call) {
        int retried = new NotificationRuntime(getContext()).retryPersistedFailures();
        JSObject ret = new JSObject();
        ret.put("retried", retried);
        call.resolve(ret);
    }

    @PluginMethod
    public void checkChannel(PluginCall call) {
        String channelId = call.getString("channelId", "");
        boolean enabled = new NotificationRuntime(getContext())
                .isChannelEnabled(channelId);
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        boolean enabled = new NotificationRuntime(getContext())
                .areNotificationsEnabled();
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (postedReceiver != null) {
                getContext().unregisterReceiver(postedReceiver);
            }
        } catch (Exception ignored) {}
        try {
            if (actionReceiver != null) {
                getContext().unregisterReceiver(actionReceiver);
            }
        } catch (Exception ignored) {}
        postedReceiver = null;
        actionReceiver = null;
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    /**
     * Called from MainActivity after BridgeActivity has handled a new launch
     * intent. This is the cold-start/SINGLE_TOP path for foreground actions.
     */
    public static void dispatchActionIntent(Intent intent) {
        if (intent == null) return;
        String actionId = intent.getStringExtra(
                NotificationRuntime.EXTRA_ACTION_ID);
        String namespace = intent.getStringExtra(
                NotificationRuntime.EXTRA_NAMESPACE);
        String identity = intent.getStringExtra(
                NotificationRuntime.EXTRA_IDENTITY);
        if (actionId == null || actionId.isEmpty()
                || namespace == null || namespace.isEmpty()
                || identity == null || identity.isEmpty()) {
            return;
        }

        NotificationRuntimePlugin plugin = instance;
        if (plugin == null) return;

        JSObject event = new JSObject();
        event.put("namespace", namespace);
        event.put("identity", identity);
        event.put("actionId", actionId);
        plugin.notifyListeners("notificationActionPerformed", event, true);
    }
}
