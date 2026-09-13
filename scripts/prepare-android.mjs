import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Post-`cap sync` Android preparation for Drug Tracker.
 *
 * Responsibilities:
 *  1. Ensure SCHEDULE_EXACT_ALARM is present in AndroidManifest.xml
 *  2. Remove legacy dose_reminder.wav if present (v3 uses system default)
 *  3. Install the repository-owned TimedNotificationPublisher override into
 *     the Capacitor Local Notifications Android sources so delivery-time
 *     dose-reminder channel selection is compiled into the APK.
 *
 * The override is a whole-file vendor copy from:
 *   native-android/capacitor-local-notifications/TimedNotificationPublisher.java
 * It is NOT a string/regex patch of dependency source.
 *
 * This script MUST run after every `cap sync android` (see package.json
 * cap:sync / apk:debug / cap:studio). If the Capacitor plugin source is
 * missing, the script exits non-zero so a production APK cannot be built
 * without the delivery-time safeguard.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
if (!fs.existsSync(androidDir)) {
  console.error('Android project not found. Run "npx cap add android" once.');
  process.exit(1);
}

// ── 1. Exact-alarm permission ──────────────────────────────────────────
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = fs.readFileSync(manifestPath, 'utf8');
const exactPermission = '<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />';
manifest = manifest.replace(/\s*<uses-permission android:name="android\.permission\.USE_EXACT_ALARM"\s*\/>/g, '');
if (!manifest.includes(exactPermission)) {
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${exactPermission}`);
}
fs.writeFileSync(manifestPath, manifest);

// ── 2. Remove legacy custom notification sound ─────────────────────────
const rawDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'raw');
const soundPath = path.join(rawDir, 'dose_reminder.wav');
if (fs.existsSync(soundPath)) {
  fs.unlinkSync(soundPath);
  console.info('Removed legacy dose_reminder.wav (channel now uses system default sound).');
}

// ── 3. Install repository-owned TimedNotificationPublisher ─────────────
installTimedNotificationPublisherOverride();

console.info('Prepared Android exact-alarm permission + dose-reminder delivery override.');

/**
 * Copy the repository-owned TimedNotificationPublisher.java over the
 * Capacitor Local Notifications plugin source so the delivery-time channel
 * safeguard is compiled into the plugin AAR / app.
 *
 * Fails hard if the expected Capacitor source path is not present — a build
 * without this override would silently lose killed-process sound guarantees.
 */
function installTimedNotificationPublisherOverride() {
  const vendorPath = path.join(
    root,
    'native-android',
    'capacitor-local-notifications',
    'TimedNotificationPublisher.java'
  );
  if (!fs.existsSync(vendorPath)) {
    console.error(
      '[prepare-android] FATAL: missing repository-owned TimedNotificationPublisher at\n  ' +
        vendorPath
    );
    process.exit(1);
  }

  const relativePluginPath = path.join(
    'android',
    'src',
    'main',
    'java',
    'com',
    'capacitorjs',
    'plugins',
    'localnotifications',
    'TimedNotificationPublisher.java'
  );

  const destinations = [
    path.join(root, 'node_modules', '@capacitor', 'local-notifications', relativePluginPath),
  ];

  // Also overwrite any materialised copy under android/ (rare, but keep consistent).
  function walk(dir, depth = 0) {
    if (depth > 10 || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'TimedNotificationPublisher.java') {
        destinations.push(full);
      } else if (
        e.isDirectory() &&
        e.name !== 'build' &&
        e.name !== '.git' &&
        e.name !== 'node_modules'
      ) {
        walk(full, depth + 1);
      }
    }
  }
  walk(androidDir);

  const unique = [...new Set(destinations)];
  const existing = unique.filter((p) => fs.existsSync(p));

  // The primary required target is the Capacitor plugin under node_modules.
  const primary = path.join(
    root,
    'node_modules',
    '@capacitor',
    'local-notifications',
    relativePluginPath
  );
  if (!fs.existsSync(primary)) {
    console.error(
      '[prepare-android] FATAL: Capacitor Local Notifications Android source not found at\n  ' +
        primary +
        '\nRun npm install (or equivalent) then cap sync, then re-run this script.\n' +
        'Refusing to continue without the delivery-time channel override.'
    );
    process.exit(1);
  }

  const vendorSource = fs.readFileSync(vendorPath, 'utf8');
  // Sanity: the vendor file must identify itself as DrugTracker-owned.
  if (!vendorSource.includes('DrugTracker-owned delivery path')) {
    console.error(
      '[prepare-android] FATAL: vendor TimedNotificationPublisher.java is missing expected DrugTracker marker.'
    );
    process.exit(1);
  }

  for (const dest of existing) {
    fs.copyFileSync(vendorPath, dest);
    console.info(
      `[prepare-android] Installed dose-reminder delivery override → ${path.relative(root, dest)}`
    );
  }
}
