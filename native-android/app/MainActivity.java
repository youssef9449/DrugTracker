package app.drugtracker;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import app.drugtracker.alarmruntime.ExactAlarmPlugin;
import app.drugtracker.autodeduction.AutoDeductionPlugin;
import app.drugtracker.criticalstock.CriticalStockAlarmAdapter;
import app.drugtracker.dosereminder.DoseReminderPlugin;
import app.drugtracker.notificationruntime.AppForegroundState;
import app.drugtracker.notificationruntime.NotificationRuntimePlugin;

/**
 * Capacitor BridgeActivity.
 *
 * <p>Registers the feature bridges and the shared capability/notification
 * runtime. Exact alarms and notification presentation are separate native
 * services.</p>
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ExactAlarmPlugin.class);
        registerPlugin(NotificationRuntimePlugin.class);
        registerPlugin(AutoDeductionPlugin.class);
        registerPlugin(DoseReminderPlugin.class);
        registerPlugin(CriticalStockAlarmAdapter.class);
        super.onCreate(savedInstanceState);
        NotificationRuntimePlugin.dispatchActionIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NotificationRuntimePlugin.dispatchActionIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        AppForegroundState.setForeground(true);
    }

    @Override
    public void onPause() {
        AppForegroundState.setForeground(false);
        super.onPause();
    }
}
