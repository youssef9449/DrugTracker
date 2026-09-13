import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
if (!fs.existsSync(androidDir)) {
  console.error('Android project not found. Run "npx cap add android" once.');
  process.exit(1);
}

const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
const exactPermission = '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />';
manifest = manifest.replace(/\s*<uses-permission android:name="android\.permission\.USE_EXACT_ALARM"\s*\/>/g, '');
if (!manifest.includes(exactPermission)) {
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${exactPermission}`);
}
fs.writeFileSync(manifestPath, manifest);

// Remove the legacy custom dose-reminder sound if it exists from a previous
// build. The dose-reminder channel (v3) now uses the default system
// notification sound, so the bundled 'dose_reminder.wav' is no longer needed.
const rawDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'raw');
const soundPath = path.join(rawDir, 'dose_reminder.wav');
if (fs.existsSync(soundPath)) {
  fs.unlinkSync(soundPath);
  console.info('Removed legacy dose_reminder.wav (channel now uses system default sound).');
}

// ─────────────────────────────────────────────────────────────
// Lifecycle race fix: patch Capacitor TimedNotificationPublisher so
// dose-reminder channel is chosen at DELIVERY time, not only at
// schedule time.
//
// Why: channelId is baked into the Notification object when the
// alarm is scheduled. If the app is killed after a foreground→
// background transition but before the JS cancel+reschedule
// finishes, a silent foreground-channel notification can survive
// and fire with no system sound. Conversely, a background-channel
// notification can fire after the user has returned to the app.
//
// The patch rebuilds the Notification with the correct channel
// based on whether the process is currently in the foreground
// when the BroadcastReceiver runs. JS scheduling still prefers the
// matching channel for the common case; this is the safety net for
// process death / incomplete reschedule windows.
// ─────────────────────────────────────────────────────────────
patchTimedNotificationPublisher();

console.info('Prepared Android exact-alarm permission.');

/**
 * Locate Capacitor LocalNotifications TimedNotificationPublisher.java
 * (node_modules or gradle cache path after cap sync) and inject
 * delivery-time channel selection for dose-reminder channels.
 */
function patchTimedNotificationPublisher() {
  const candidates = [
    path.join(
      root,
      'node_modules',
      '@capacitor',
      'local-notifications',
      'android',
      'src',
      'main',
      'java',
      'com',
      'capacitorjs',
      'plugins',
      'localnotifications',
      'TimedNotificationPublisher.java'
    ),
  ];

  // After `cap sync`, Capacitor may also materialize plugin sources under
  // android/. Search the android tree for any copy we can patch.
  function walk(dir, depth = 0) {
    if (depth > 8 || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'TimedNotificationPublisher.java') {
        candidates.push(full);
      } else if (e.isDirectory() && e.name !== 'build' && e.name !== '.git' && e.name !== 'node_modules') {
        walk(full, depth + 1);
      }
    }
  }
  walk(androidDir);

  const unique = [...new Set(candidates.filter((p) => fs.existsSync(p)))];
  if (unique.length === 0) {
    console.warn(
      '[prepare-android] TimedNotificationPublisher.java not found — ' +
        'delivery-time channel patch skipped. Run npm install + cap sync first.'
    );
    return;
  }

  const MARKER = 'DRUGTRACKER_DELIVERY_CHANNEL_PATCH';
  for (const filePath of unique) {
    let src = fs.readFileSync(filePath, 'utf8');
    if (src.includes(MARKER)) {
      console.info(`[prepare-android] Already patched: ${path.relative(root, filePath)}`);
      continue;
    }

    if (!src.includes('notificationManager.notify(id, notification);')) {
      console.warn(
        `[prepare-android] Unexpected TimedNotificationPublisher shape in ${filePath}; skip.`
      );
      continue;
    }

    const importsToAdd = [
      'import android.app.ActivityManager;',
      'import android.os.Bundle;',
      'import androidx.core.app.NotificationCompat;',
    ];
    for (const imp of importsToAdd) {
      if (!src.includes(imp)) {
        src = src.replace(
          'import android.app.NotificationManager;',
          `import android.app.NotificationManager;\n${imp}`
        );
      }
    }

    src = src.replace(
      'notificationManager.notify(id, notification);',
      `// ${MARKER}: choose dose-reminder channel at delivery time\n` +
        `        notification = maybeRewriteDoseReminderChannel(context, notification);\n` +
        `        notificationManager.notify(id, notification);`
    );

    const helper = `
    // ${MARKER}
    // Dose-reminder channel ids — must stay in sync with
    // src/utils/notifications.ts (DOSE_REMINDER_CHANNEL_ID /
    // DOSE_REMINDER_FOREGROUND_CHANNEL_ID).
    private static final String DOSE_BG_CHANNEL = "dose-reminder-v3";
    private static final String DOSE_FG_CHANNEL = "dose-reminder-foreground-v1";

    /**
     * If this is a dose-reminder notification, rebuild it on the channel
     * that matches whether the app process is currently in the foreground.
     * Prevents a silent foreground-channel notification from surviving
     * process death after a background transition, and avoids a noisy
     * background-channel notification when the user is already in-app.
     */
    private Notification maybeRewriteDoseReminderChannel(Context context, Notification notification) {
        if (notification == null) return notification;
        String channelId = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            channelId = notification.getChannelId();
        }
        if (channelId == null) return notification;
        if (!DOSE_BG_CHANNEL.equals(channelId) && !DOSE_FG_CHANNEL.equals(channelId)) {
            return notification;
        }

        boolean foreground = isProcessInForeground(context);
        String desired = foreground ? DOSE_FG_CHANNEL : DOSE_BG_CHANNEL;
        if (desired.equals(channelId)) {
            return notification;
        }

        try {
            Bundle extras = notification.extras;
            CharSequence title = extras != null ? extras.getCharSequence(Notification.EXTRA_TITLE) : null;
            CharSequence text = extras != null ? extras.getCharSequence(Notification.EXTRA_TEXT) : null;

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, desired)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setSmallIcon(notification.getSmallIcon())
                .setContentIntent(notification.contentIntent)
                .setDeleteIntent(notification.deleteIntent)
                .setWhen(System.currentTimeMillis())
                .setOnlyAlertOnce(true);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                builder.setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
                if (notification.color != 0) {
                    builder.setColor(notification.color);
                }
            }

            if (notification.actions != null) {
                for (Notification.Action action : notification.actions) {
                    builder.addAction(action);
                }
            }

            // Defaults: background channel should produce system sound;
            // foreground (LOW importance channel) stays silent via channel config.
            if (!foreground) {
                builder.setDefaults(Notification.DEFAULT_ALL);
                builder.setPriority(NotificationCompat.PRIORITY_HIGH);
            } else {
                builder.setPriority(NotificationCompat.PRIORITY_LOW);
            }

            Logger.debug(Logger.tags("LN"),
                "DrugTracker: rewrote dose reminder channel " + channelId + " → " + desired +
                " (foreground=" + foreground + ")");
            return builder.build();
        } catch (Exception e) {
            Logger.error(Logger.tags("LN"), "DrugTracker: failed to rewrite dose channel", e);
            return notification;
        }
    }

    private boolean isProcessInForeground(Context context) {
        try {
            ActivityManager.RunningAppProcessInfo info = new ActivityManager.RunningAppProcessInfo();
            ActivityManager.getMyMemoryState(info);
            return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                || info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
        } catch (Exception e) {
            // If we cannot determine, prefer the sound-capable channel so a
            // killed-process reminder is never silent.
            return false;
        }
    }
`;

    const lastBrace = src.lastIndexOf('}');
    if (lastBrace < 0) {
      console.warn(`[prepare-android] Could not find class end in ${filePath}`);
      continue;
    }
    src = src.slice(0, lastBrace) + helper + '\n' + src.slice(lastBrace);

    fs.writeFileSync(filePath, src);
    console.info(`[prepare-android] Patched delivery-time channel selection: ${path.relative(root, filePath)}`);
  }
}
