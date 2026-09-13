package app.drugtracker;

import android.os.Bundle;
import com.capacitorjs.plugins.localnotifications.AppForegroundState;
import com.getcapacitor.BridgeActivity;

/**
 * Capacitor BridgeActivity with process-local foreground tracking for
 * dose-reminder delivery-time channel selection.
 *
 * onResume → AppForegroundState true (UI active, silent channel preferred)
 * onPause  → AppForegroundState false (not active; v3 / system sound)
 *
 * AppForegroundState is process-local and defaults to false, so a fresh
 * process started by an alarm after kill correctly uses dose-reminder-v3.
 *
 * Installed by scripts/prepare-android.mjs over the generated MainActivity.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
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
