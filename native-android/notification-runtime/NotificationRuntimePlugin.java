package app.drugtracker.notificationruntime;

import app.drugtracker.alarmruntime.NativeErrorCodes;
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
            // #534: structured machine code; the raw message stays in `error`.
            ret.put("code", NativeErrorCodes.structuredCode(result.error, "platform_failure"));
            // #511: distinguish "delivery failed, retry evidence stored" from
            // "delivery failed AND retry evidence could not be stored".
            if (result.retryEvidence == NotificationRuntime.PostResult.RetryEvidenceState.FAILED) {
                ret.put("code", "retry_persist_failed");
                ret.put("retryPersistFailed", true);
            }
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
            // #534: structured machine code; the raw message stays in `error`.
            ret.put("code", NativeErrorCodes.structuredCode(result.error, "platform_failure"));
            // #511: distinguish "delivery failed, retry evidence stored" from
            // "delivery failed AND retry evidence could not be stored".
            if (result.retryEvidence == NotificationRuntime.PostResult.RetryEvidenceState.FAILED) {
                ret.put("code", "retry_persist_failed");
                ret.put("retryPersistFailed", true);
            }
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
    public void ensureChannel(PluginCall call) {
        // #503: startup channel bootstrap before capability gating.
        String channelId = call.getString("channelId", "");
        String channelName = call.getString("channelName", channelId);
        Integer importance = call.getInt("channelImportance", 4);
        Integer visibility = call.getInt("channelVisibility", 1);
        JSObject ret = new JSObject();
        if (channelId == null || channelId.isEmpty()) {
            ret.put("ok", false);
            ret.put("error", "invalid_request");
            ret.put("code", "invalid_request");
            call.resolve(ret);
            return;
        }
        try {
            new NotificationRuntime(getContext()).createChannelIfAbsent(
                    channelId,
                    channelName,
                    importance == null ? 4 : importance,
                    visibility == null ? 1 : visibility);
            ret.put("ok", true);
        } catch (Exception e) {
            ret.put("ok", false);
            ret.put("error", "channel_bootstrap_failed");
            ret.put("code", "channel_bootstrap_failed");
        }
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
