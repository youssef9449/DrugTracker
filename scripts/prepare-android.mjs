import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * Post-cap-sync Android preparation for Drug Tracker.
 *
 * The repository-owned native Android source directories are the single
 * source of truth. Every Java production source in each owned feature
 * directory is copied into the generated Android project, and stale Java
 * files previously generated/copied into those owned destinations are removed.
 *
 * Manifest changes use a real XML DOM parser/serializer. Only elements owned
 * by this preparation step are replaced or removed; unrelated Capacitor
 * generated content remains in the document.
 *
 * Requires @capacitor/local-notifications exactly 6.1.3 (pinned in package.json).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'android');
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function fail(message, ...details) {
  console.error('[prepare-android] FATAL:', message, ...details);
  throw new Error(message);
}

function syncJavaSourceSet(sourceDir, destinationDir, label) {
  if (!fs.existsSync(sourceDir)) {
    fail('missing source directory for ' + label + ': ' + sourceDir);
  }

  const entries = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.java')) {
      fail(
        label +
          ' source directory contains an unsupported entry: ' +
          path.join(sourceDir, entry.name)
      );
    }
  }

  const sourceFiles = entries.map((entry) => entry.name);
  if (sourceFiles.length === 0) {
    fail('no Java production sources found for ' + label + ': ' + sourceDir);
  }

  fs.mkdirSync(destinationDir, { recursive: true });

  const sourceFileSet = new Set(sourceFiles);
  for (const entry of fs.readdirSync(destinationDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.java') && !sourceFileSet.has(entry.name)) {
      const stalePath = path.join(destinationDir, entry.name);
      fs.unlinkSync(stalePath);
      console.info(
        '[prepare-android] Removed stale ' +
          label +
          ' source ' +
          path.relative(root, stalePath)
      );
    }
  }

  for (const file of sourceFiles) {
    const src = path.join(sourceDir, file);
    const dest = path.join(destinationDir, file);
    fs.copyFileSync(src, dest);
    console.info(
      '[prepare-android] Installed ' +
        path.relative(root, src) +
        ' → ' +
        path.relative(root, dest)
    );
  }

  return sourceFiles;
}

function androidAttribute(element, localName) {
  return element.getAttributeNS(ANDROID_NS, localName);
}

function setAndroidAttribute(element, localName, value) {
  element.setAttributeNS(ANDROID_NS, 'android:' + localName, value);
}

function directChildren(parent, localName) {
  return Array.from(parent.children).filter((child) => child.localName === localName);
}

function namedDescendants(parent, localName, androidName) {
  return Array.from(parent.getElementsByTagName(localName)).filter(
    (element) => androidAttribute(element, 'name') === androidName
  );
}

function requireSingleOwnedDirectChild(parent, localName, androidName, label) {
  const matches = namedDescendants(parent, localName, androidName);
  if (matches.length > 1) {
    fail('duplicate owned ' + label + ' elements found for ' + androidName);
  }
  if (matches.length === 1 && matches[0].parentElement !== parent) {
    fail('owned ' + label + ' is not a direct child of its expected parent: ' + androidName);
  }
  return matches[0] || null;
}

function createAction(doc, actionName) {
  const action = doc.createElement('action');
  setAndroidAttribute(action, 'name', actionName);
  return action;
}

function createReceiver(doc, config) {
  const receiver = doc.createElement('receiver');
  setAndroidAttribute(receiver, 'name', config.androidName);
  setAndroidAttribute(receiver, 'exported', config.exported);
  setAndroidAttribute(receiver, 'enabled', 'true');

  const intentFilter = doc.createElement('intent-filter');
  for (const actionName of config.actions) {
    intentFilter.appendChild(createAction(doc, actionName));
  }
  receiver.appendChild(intentFilter);
  return receiver;
}

function upsertReceiver(application, doc, config) {
  const existing = requireSingleOwnedDirectChild(
    application,
    'receiver',
    config.androidName,
    'receiver'
  );
  const next = createReceiver(doc, config);
  if (existing) {
    application.replaceChild(next, existing);
  } else {
    application.appendChild(next);
  }
}

function removeReceiver(application, androidName) {
  const existing = requireSingleOwnedDirectChild(
    application,
    'receiver',
    androidName,
    'receiver'
  );
  if (existing) {
    application.removeChild(existing);
  }
}

function upsertMetaData(application, doc, androidName, value) {
  const existing = requireSingleOwnedDirectChild(
    application,
    'meta-data',
    androidName,
    'meta-data'
  );
  const next = doc.createElement('meta-data');
  setAndroidAttribute(next, 'name', androidName);
  setAndroidAttribute(next, 'value', value);
  if (existing) {
    application.replaceChild(next, existing);
  } else {
    application.appendChild(next);
  }
}

function requireSinglePermission(manifest, permissionName) {
  const matches = directChildren(manifest, 'uses-permission').filter(
    (element) => androidAttribute(element, 'name') === permissionName
  );
  if (matches.length > 1) {
    fail('duplicate uses-permission entries found for ' + permissionName);
  }
  return matches[0] || null;
}

function ensurePermission(manifest, doc, permissionName, application) {
  if (requireSinglePermission(manifest, permissionName)) return;
  const permission = doc.createElement('uses-permission');
  setAndroidAttribute(permission, 'name', permissionName);
  manifest.insertBefore(permission, application);
}

function removePermission(manifest, permissionName) {
  const existing = requireSinglePermission(manifest, permissionName);
  if (existing) {
    manifest.removeChild(existing);
  }
}

export function prepareAndroidManifest(xml) {
  let dom;
  try {
    dom = new JSDOM(xml, { contentType: 'application/xml' });
  } catch (error) {
    throw new Error(
      'AndroidManifest.xml could not be parsed: ' +
        (error instanceof Error ? error.message : String(error))
    );
  }

  try {
    const doc = dom.window.document;
    if (!doc.documentElement || doc.documentElement.localName !== 'manifest') {
      fail('AndroidManifest.xml root element must be <manifest>');
    }
    if (doc.getElementsByTagName('parsererror').length > 0) {
      fail('AndroidManifest.xml is malformed');
    }

    const applicationNodes = directChildren(doc.documentElement, 'application');
    if (applicationNodes.length !== 1) {
      fail(
        'AndroidManifest.xml must contain exactly one direct <application> element; found ' +
          applicationNodes.length
      );
    }
    const application = applicationNodes[0];
    const manifest = doc.documentElement;

    ensurePermission(
      manifest,
      doc,
      'android.permission.SCHEDULE_EXACT_ALARM',
      application
    );
    ensurePermission(
      manifest,
      doc,
      'android.permission.RECEIVE_BOOT_COMPLETED',
      application
    );
    removePermission(manifest, 'android.permission.USE_EXACT_ALARM');

    upsertReceiver(application, doc, {
      androidName: 'app.drugtracker.autodeduction.AutoDeductionReceiver',
      exported: 'false',
      actions: ['app.drugtracker.action.AUTO_DEDUCTION'],
    });
    upsertReceiver(application, doc, {
      androidName: 'app.drugtracker.dosereminder.DoseReminderAlarmReceiver',
      exported: 'false',
      actions: [
        'app.drugtracker.action.DOSE_REMINDER_ALARM',
        'app.drugtracker.action.DOSE_REMINDER_SNOOZE',
      ],
    });
    upsertReceiver(application, doc, {
      androidName: 'app.drugtracker.criticalstock.CriticalStockAlarmReceiver',
      exported: 'false',
      actions: ['app.drugtracker.action.CRITICAL_STOCK_ALARM'],
    });
    upsertReceiver(application, doc, {
      androidName: 'app.drugtracker.notificationruntime.NotificationRuntimeActionReceiver',
      exported: 'false',
      actions: ['app.drugtracker.notificationruntime.ACTION'],
    });
    upsertReceiver(application, doc, {
      androidName: 'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver',
      exported: 'true',
      actions: [
        'android.intent.action.BOOT_COMPLETED',
        'android.intent.action.QUICKBOOT_POWERON',
        'android.intent.action.TIMEZONE_CHANGED',
        'android.intent.action.TIME_SET',
        'android.intent.action.TIMEZONE_OFFSET_CHANGED',
        'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
      ],
    });

    removeReceiver(
      application,
      'app.drugtracker.autodeduction.AutoDeductionSystemReceiver'
    );
    removeReceiver(
      application,
      'app.drugtracker.criticalstock.CriticalStockSystemReceiver'
    );
    removeReceiver(
      application,
      'app.drugtracker.dosereminder.DoseReminderSystemReceiver'
    );
    removeReceiver(
      application,
      'com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher'
    );
    removeReceiver(
      application,
      'app.drugtracker.alarmruntime.ExactAlarmSystemReceiver'
    );

    upsertMetaData(
      application,
      doc,
      'app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS',
      'app.drugtracker.autodeduction.AutoDeductionAlarmFeature,app.drugtracker.criticalstock.CriticalStockAlarmAdapter,app.drugtracker.alarmruntime.DoseReminderAlarmFeature'
    );

    return new dom.window.XMLSerializer().serializeToString(doc);
  } finally {
    dom.window.close();
  }
}

export function prepareAndroidProject() {
  if (!fs.existsSync(androidDir)) {
    fail(
      'Android project not found. Generate the clean Capacitor Android project before preparation.'
    );
  }
  if (!fs.existsSync(manifestPath)) {
    fail('AndroidManifest.xml missing at ' + manifestPath);
  }

  const manifest = fs.readFileSync(manifestPath, 'utf8');

  const legacySoundPath = path.join(
    root,
    'android',
    'app',
    'src',
    'main',
    'res',
    'raw',
    'dose_reminder.wav'
  );
  if (fs.existsSync(legacySoundPath)) {
    fs.unlinkSync(legacySoundPath);
    console.info(
      'Removed legacy dose_reminder.wav (notification runtime uses channel defaults).'
    );
  }

  const legacyNotificationJavaDir = path.join(
    androidDir,
    'app',
    'src',
    'main',
    'java',
    'com',
    'capacitorjs',
    'plugins',
    'localnotifications'
  );
  for (const file of [
    'TimedNotificationPublisher.java',
    'DoseReminderRecurrenceStore.java',
    'AppForegroundState.java',
  ]) {
    const legacyPath = path.join(legacyNotificationJavaDir, file);
    if (fs.existsSync(legacyPath)) {
      fs.unlinkSync(legacyPath);
      console.info(
        '[prepare-android] Removed obsolete generated source ' +
          path.relative(root, legacyPath)
      );
    }
  }

  const mainActivitySource = path.join(root, 'native-android', 'app', 'MainActivity.java');
  const mainActivityDestination = path.join(
    androidDir,
    'app',
    'src',
    'main',
    'java',
    'app',
    'drugtracker',
    'MainActivity.java'
  );
  if (!fs.existsSync(mainActivitySource)) {
    fail('missing repository-owned MainActivity source: ' + mainActivitySource);
  }
  fs.copyFileSync(mainActivitySource, mainActivityDestination);
  console.info(
    '[prepare-android] Installed ' +
      path.relative(root, mainActivitySource) +
      ' → ' +
      path.relative(root, mainActivityDestination)
  );

  syncJavaSourceSet(
    path.join(root, 'native-android', 'notification-runtime'),
    path.join(
      androidDir,
      'app',
      'src',
      'main',
      'java',
      'app',
      'drugtracker',
      'notificationruntime'
    ),
    'notification-runtime'
  );
  syncJavaSourceSet(
    path.join(root, 'native-android', 'alarm-runtime'),
    path.join(
      androidDir,
      'app',
      'src',
      'main',
      'java',
      'app',
      'drugtracker',
      'alarmruntime'
    ),
    'alarm-runtime'
  );
  syncJavaSourceSet(
    path.join(root, 'native-android', 'auto-deduction'),
    path.join(
      androidDir,
      'app',
      'src',
      'main',
      'java',
      'app',
      'drugtracker',
      'autodeduction'
    ),
    'auto-deduction'
  );
  syncJavaSourceSet(
    path.join(root, 'native-android', 'dose-reminder'),
    path.join(
      androidDir,
      'app',
      'src',
      'main',
      'java',
      'app',
      'drugtracker',
      'dosereminder'
    ),
    'dose-reminder'
  );
  syncJavaSourceSet(
    path.join(root, 'native-android', 'critical-stock'),
    path.join(
      androidDir,
      'app',
      'src',
      'main',
      'java',
      'app',
      'drugtracker',
      'criticalstock'
    ),
    'critical-stock'
  );

  fs.writeFileSync(manifestPath, prepareAndroidManifest(manifest));
  console.info(
    '[prepare-android] Ensured private Auto/Dose/Critical receivers + private notification action receiver + shared DrugTrackerAlarmSystemReceiver.'
  );
  console.info(
    'Prepared Android exact-alarm runtime + shared notification runtime + Auto/Dose/Critical feature boundaries.'
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    prepareAndroidProject();
  } catch {
    process.exitCode = 1;
  }
}
