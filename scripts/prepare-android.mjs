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
    src: path.join(vendorDir, 'DoseReminderRecurrenceStore.java'),
    dest: path.join(pluginJavaDir, 'DoseReminderRecurrenceStore.java'),
    marker: 'DoseReminderRecurrenceStore',
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

// ── 4. Phase 2: install shared exact-alarm runtime + Auto Deduction sources ──
const alarmRuntimeSrcDir = path.join(root, 'native-android', 'alarm-runtime');
const alarmRuntimeDestDir = path.join(
  androidDir,
  'app',
  'src',
  'main',
  'java',
  'app',
  'drugtracker',
  'alarmruntime'
);
const alarmRuntimeFiles = [
  'ExactAlarmContract.java',
  'ExactAlarmOperationLock.java',
  'ExactAlarmStore.java',
  'ExactAlarmRuntime.java',
  'ExactAlarmLifecycle.java',
  'DrugTrackerAlarmSystemReceiver.java',
  'ExactAlarmFeatureAdapter.java',
];
if (!fs.existsSync(alarmRuntimeDestDir)) {
  fs.mkdirSync(alarmRuntimeDestDir, { recursive: true });
}
for (const file of alarmRuntimeFiles) {
  const src = path.join(alarmRuntimeSrcDir, file);
  const dest = path.join(alarmRuntimeDestDir, file);
  if (!fs.existsSync(src)) {
    console.error('[prepare-android] FATAL: missing alarm-runtime source:', src);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.info('[prepare-android] Installed ' + path.relative(root, src) + ' → ' + path.relative(root, dest));
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
  'AutoDeductionLifecycle.java',
  'AutoDeductionAlarmFeature.java',
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

// ── 4b. Dose reminder native query plugin (re-arm evidence bridge) ─────
const doseReminderSrcDir = path.join(root, 'native-android', 'dose-reminder');
const doseReminderDestDir = path.join(
  androidDir,
  'app',
  'src',
  'main',
  'java',
  'app',
  'drugtracker',
  'dosereminder'
);
const doseReminderFiles = ['DoseReminderPlugin.java'];
if (!fs.existsSync(doseReminderDestDir)) {
  fs.mkdirSync(doseReminderDestDir, { recursive: true });
}
for (const file of doseReminderFiles) {
  const src = path.join(doseReminderSrcDir, file);
  const dest = path.join(doseReminderDestDir, file);
  if (!fs.existsSync(src)) {
    console.error('[prepare-android] FATAL: missing dose-reminder source:', src);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.info(`[prepare-android] Installed ${path.relative(root, src)} → ${path.relative(root, dest)}`);
}

// ── 5. Register private feature delivery + one shared system lifecycle receiver ─
manifest = fs.readFileSync(manifestPath, 'utf8');
const bootPermission = '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />';
if (!manifest.includes(bootPermission)) {
  manifest = manifest.replace(/(<manifest\b[^>]*>)/, `$1\n    ${bootPermission}`);
}

/**
 * Replace or insert a single <receiver> whose android:name matches exactly.
 * Scans for the unique name attribute, then expands outward to the enclosing
 * <receiver>...</receiver> without crossing other receiver elements.
 * Returns { manifest, changed }.
 */
function upsertReceiverByName(xml, androidName, receiverXml) {
  const nameAttr = `android:name="${androidName}"`;
  const nameIdx = xml.indexOf(nameAttr);
  if (nameIdx === -1) {
    if (!xml.includes('</application>')) {
      console.error('[prepare-android] FATAL: </application> not found in AndroidManifest.xml');
      process.exit(1);
    }
    return {
      manifest: xml.replace('</application>', `${receiverXml}\n    </application>`),
      changed: true,
    };
  }
  // Walk backward to the nearest <receiver that starts this element.
  const openTag = '<receiver';
  let openIdx = xml.lastIndexOf(openTag, nameIdx);
  if (openIdx === -1) {
    console.error('[prepare-android] FATAL: could not find <receiver opening for', androidName);
    process.exit(1);
  }
  // Ensure no other </receiver> sits between openIdx and nameIdx (malformed guard).
  const between = xml.slice(openIdx, nameIdx);
  if (between.includes('</receiver>')) {
    console.error('[prepare-android] FATAL: ambiguous receiver block for', androidName);
    process.exit(1);
  }
  const closeTag = '</receiver>';
  const closeIdx = xml.indexOf(closeTag, nameIdx);
  if (closeIdx === -1) {
    console.error('[prepare-android] FATAL: unclosed <receiver for', androidName);
    process.exit(1);
  }
  // Include any leading whitespace/newline before the open tag for clean replace.
  let start = openIdx;
  while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\t')) start--;
  if (start > 0 && xml[start - 1] === '\n') start--;
  const end = closeIdx + closeTag.length;
  const next = xml.slice(0, start) + '\n' + receiverXml + xml.slice(end);
  return { manifest: next, changed: true };
}

// Private alarm delivery — explicit PendingIntent only; not externally invocable.
const privateAlarmReceiver = `        <receiver
            android:name="app.drugtracker.autodeduction.AutoDeductionReceiver"
            android:exported="false"
            android:enabled="true">
            <intent-filter>
                <action android:name="app.drugtracker.action.AUTO_DEDUCTION" />
            </intent-filter>
        </receiver>`;

// System lifecycle is owned by the shared exact-alarm runtime.
// exported=true is required for system-delivered broadcasts on API 31+.
const systemLifecycleReceiver = `        <receiver
            android:name="app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver"
            android:exported="true"
            android:enabled="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED" />
            </intent-filter>
        </receiver>`;

function removeReceiverByName(xml, androidName) {
  const nameAttr = `android:name="${androidName}"`;
  const nameIdx = xml.indexOf(nameAttr);
  if (nameIdx === -1) return xml;
  const openIdx = xml.lastIndexOf('<receiver', nameIdx);
  if (openIdx === -1) return xml;
  const closeTag = '</receiver>';
  const closeIdx = xml.indexOf(closeTag, nameIdx);
  if (closeIdx === -1) {
    console.error('[prepare-android] FATAL: unclosed <receiver for', androidName);
    process.exit(1);
  }
  let start = openIdx;
  while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\t')) start--;
  if (start > 0 && xml[start - 1] === '\n') start--;
  return xml.slice(0, start) + xml.slice(closeIdx + closeTag.length);
}

function upsertApplicationMetaData(xml, androidName, value) {
  const nameAttr = `android:name="${androidName}"`;
  const metaXml = `        <meta-data
            android:name="${androidName}"
            android:value="${value}" />`;
  const nameIdx = xml.indexOf(nameAttr);
  if (nameIdx === -1) {
    if (!xml.includes('</application>')) {
      console.error('[prepare-android] FATAL: </application> not found in AndroidManifest.xml');
      process.exit(1);
    }
    return xml.replace('</application>', `${metaXml}\n    </application>`);
  }
  const openIdx = xml.lastIndexOf('<meta-data', nameIdx);
  const closeIdx = xml.indexOf('/>', nameIdx);
  if (openIdx === -1 || closeIdx === -1) {
    console.error('[prepare-android] FATAL: malformed <meta-data for', androidName);
    process.exit(1);
  }
  let start = openIdx;
  while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\t')) start--;
  if (start > 0 && xml[start - 1] === '\n') start--;
  return xml.slice(0, start) + metaXml + xml.slice(closeIdx + 2);
}

({ manifest } = upsertReceiverByName(
  manifest,
  'app.drugtracker.autodeduction.AutoDeductionReceiver',
  privateAlarmReceiver
));
({ manifest } = removeReceiverByName(
  manifest,
  'app.drugtracker.autodeduction.AutoDeductionSystemReceiver'
));
({ manifest } = removeReceiverByName(
  manifest,
  'app.drugtracker.alarmruntime.ExactAlarmSystemReceiver'
));
({ manifest } = upsertReceiverByName(
  manifest,
  'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver',
  systemLifecycleReceiver
));
manifest = upsertApplicationMetaData(
  manifest,
  'app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS',
  'app.drugtracker.autodeduction.AutoDeductionAlarmFeature,app.drugtracker.alarmruntime.CriticalStockAlarmFeature,app.drugtracker.alarmruntime.DoseReminderAlarmFeature'
);

fs.writeFileSync(manifestPath, manifest);
console.info(
  '[prepare-android] Ensured private AutoDeductionReceiver + shared DrugTrackerAlarmSystemReceiver (lifecycle adapters: Auto, Critical Stock, Dose Reminder).'
);
console.info('Prepared Android exact-alarm permission + shared alarm runtime + dose-reminder delivery sources + auto-deduction.');