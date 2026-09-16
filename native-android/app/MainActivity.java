package app.drugtracker;

import android.os.Bundle;
import com.capacitorjs.plugins.localnotifications.AppForegroundState;
import com.getcapacitor.BridgeActivity;
import app.drugtracker.autodeduction.AutoDeductionPlugin;
import app.drugtracker.dosereminder.DoseReminderPlugin;

/**
 * Capacitor BridgeActivity with process-local foreground tracking for
 * dose-reminder delivery-time channel selection.
 *
 * Phase 2: registers AutoDeductionPlugin for exact-time auto-deduction
 * scheduling and durable event ledger bridge.
 * DoseReminderPlugin: query native next-day re-arm evidence
 * (TimedNotificationPublisher → DoseReminderRecurrenceStore).
 *
 * Installed by scripts/prepare-android.mjs over the generated MainActivity.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AutoDeductionPlugin.class);
        registerPlugin(DoseReminderPlugin.class);
        super.onCreate(savedInstanceState);
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
