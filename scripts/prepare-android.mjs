import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Post-`cap sync` Android preparation for Drug Tracker.
 *
 * 1. Ensure SCHEDULE_EXACT_ALARM in AndroidManifest.xml
 * 2. Remove legacy dose_reminder.wav (v3 uses system default sound)
 * 3. Install repository-owned notification delivery sources:
 *    - TimedNotificationPublisher.java  (Capacitor 6.1.3 + delivery channel)
 *    - AppForegroundState.java          (process-local lifecycle flag)
 *    - MainActivity.java                (onResume/onPause → AppForegroundState)
 *
 * Whole-file copies only. No string/regex patching of dependency source.
 * Fails hard if required destinations are missing.
 *
 * Requires @capacitor/local-notifications exactly 6.1.3 (pinned in package.json).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
if (!fs.existsSync(androidDir)) {
  console.error('Android project not found. Run "npx cap add android" once.');
  process.exit(1);
}

// ── 1. Exact-alarm permission ──────────────────────────────────────────
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) {
  console.error('[prepare-android] FATAL: AndroidManifest.xml missing at', manifestPath);
  process.exit(1);
}
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

// ── 3. Install repository-owned native sources ─────────────────────────
const pluginJavaDir = path.join(
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
  'localnotifications'
);

const vendorDir = path.join(root, 'native-android', 'capacitor-local-notifications');
const appVendorDir = path.join(root, 'native-android', 'app');

const copies = [
  {
    src: path.join(vendorDir, 'TimedNotificationPublisher.java'),
    dest: path.join(pluginJavaDir, 'TimedNotificationPublisher.java'),
    marker: 'DrugTracker delivery-time dose-reminder channel selection',
  },
  {
    src: path.join(vendorDir, 'AppForegroundState.java'),
    dest: path.join(pluginJavaDir, 'AppForegroundState.java'),
    marker: 'Process-local foreground flag for DrugTracker',
  },
  {
    src: path.join(appVendorDir, 'MainActivity.java'),
    dest: path.join(
      androidDir,
      'app',
      'src',
      'main',
      'java',
      'app',
      'drugtracker',
      'MainActivity.java'
    ),
    marker: 'AppForegroundState',
  },
];

for (const { src, dest, marker } of copies) {
  if (!fs.existsSync(src)) {
    console.error('[prepare-android] FATAL: missing vendor source:', src);
    process.exit(1);
  }
  const body = fs.readFileSync(src, 'utf8');
  if (!body.includes(marker)) {
    console.error('[prepare-android] FATAL: vendor file missing expected marker:', src);
    process.exit(1);
  }
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    console.error(
      '[prepare-android] FATAL: destination directory missing (run cap sync first):\n  ' + destDir
    );
    process.exit(1);
  }
  // TimedNotificationPublisher must overwrite an existing Capacitor file.
  if (
    path.basename(dest) === 'TimedNotificationPublisher.java' &&
    !fs.existsSync(dest)
  ) {
    console.error(
      '[prepare-android] FATAL: Capacitor TimedNotificationPublisher.java not found at\n  ' +
        dest +
        '\nPin @capacitor/local-notifications@6.1.3, run npm install + cap sync, then re-run.'
    );
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.info(`[prepare-android] Installed ${path.relative(root, src)} → ${path.relative(root, dest)}`);
}

// ── 4. Phase 2: install auto-deduction native sources ──────────────────
const autoDeductionSrcDir = path.join(root, 'native-android', 'auto-deduction');
const autoDeductionDestDir = path.join(
  androidDir,
  'app',
  'src',
  'main',
  'java',
  'app',
  'drugtracker',
  'autodeduction'
);
const autoDeductionFiles = [
  'AutoDeductionContract.java',
  'AutoDeductionEventStore.java',
  'AutoDeductionScheduler.java',
  'AutoDeductionReceiver.java',
  'AutoDeductionPlugin.java',
];
if (!fs.existsSync(autoDeductionDestDir)) {
  fs.mkdirSync(autoDeductionDestDir, { recursive: true });
}
for (const file of autoDeductionFiles) {
  const src = path.join(autoDeductionSrcDir, file);
  const dest = path.join(autoDeductionDestDir, file);
  if (!fs.existsSync(src)) {
    console.error('[prepare-android] FATAL: missing auto-deduction source:', src);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.info(`[prepare-android] Installed ${path.relative(root, src)} → ${path.relative(root, dest)}`);
}

// ── 5. Phase 2: register AutoDeductionReceiver + RECEIVE_BOOT_COMPLETED ─
manifest = fs.readFileSync(manifestPath, 'utf8');
const bootPermission = '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />';
if (!manifest.includes(bootPermission)) {
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${bootPermission}`);
}

const receiverBlock = `        <receiver
            android:name="app.drugtracker.autodeduction.AutoDeductionReceiver"
            android:exported="false"
            android:enabled="true">
            <intent-filter>
                <action android:name="app.drugtracker.action.AUTO_DEDUCTION" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
            </intent-filter>
        </receiver>`;

if (!manifest.includes('app.drugtracker.autodeduction.AutoDeductionReceiver')) {
  if (manifest.includes('</application>')) {
    manifest = manifest.replace('</application>', `${receiverBlock}\n    </application>`);
  } else {
    console.error('[prepare-android] FATAL: </application> not found in AndroidManifest.xml');
    process.exit(1);
  }
}
fs.writeFileSync(manifestPath, manifest);
console.info('[prepare-android] Ensured AutoDeductionReceiver + RECEIVE_BOOT_COMPLETED in manifest.');

console.info('Prepared Android exact-alarm permission + dose-reminder delivery sources + auto-deduction.');
