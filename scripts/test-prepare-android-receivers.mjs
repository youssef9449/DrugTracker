/**
 * Regression tests for structural Android manifest preparation.
 *
 * Run: node scripts/test-prepare-android-receivers.mjs
 * No npm/npx invocation is required by this script itself.
 */

import { JSDOM } from 'jsdom';
import { prepareAndroidManifest } from './prepare-android.mjs';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

function countName(xml, name) {
  const needle = 'android:name="' + name + '"';
  return xml.split(needle).length - 1;
}

function androidAttribute(element, localName) {
  return element.getAttributeNS(ANDROID_NS, localName);
}

function parse(xml) {
  const dom = new JSDOM(xml, { contentType: 'application/xml' });
  const document = dom.window.document;
  assert(
    document.documentElement?.localName === 'manifest',
    'prepared document must have a manifest root'
  );
  return document;
}

const base = [
  '<?xml version="1.0"?>',
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android">',
  '    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />',
  '    <uses-permission android:name="com.example.OTHER_PERMISSION" />',
  '    <application android:label="Drug Tracker">',
  '        <receiver android:name="com.other.ReceiverA" android:exported="false" />',
  '        <receiver android:exported="true" android:name="com.other.ReceiverB">',
  '            <intent-filter>',
  '                <action android:name="android.intent.action.BOOT_COMPLETED" />',
  '            </intent-filter>',
  '        </receiver>',
  '        <receiver',
  '            android:name="app.drugtracker.autodeduction.AutoDeductionReceiver"',
  '            android:exported="true"',
  '            android:enabled="true">',
  '            <intent-filter>',
  '                <action android:name="stale.action" />',
  '            </intent-filter>',
  '            <intent-filter>',
  '                <action android:name="android.intent.action.BOOT_COMPLETED" />',
  '            </intent-filter>',
  '        </receiver>',
  '        <receiver android:name="app.drugtracker.autodeduction.AutoDeductionSystemReceiver" />',
  '        <receiver android:name="app.drugtracker.criticalstock.CriticalStockSystemReceiver" />',
  '        <receiver android:name="app.drugtracker.dosereminder.DoseReminderSystemReceiver" />',
  '        <receiver android:name="com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher" />',
  '        <receiver android:name="app.drugtracker.alarmruntime.ExactAlarmSystemReceiver" />',
  '        <activity android:name="app.drugtracker.MainActivity" />',
  '        <meta-data android:value="keep-me" android:name="com.example.UNRELATED" />',
  '        <meta-data',
  '            android:name="app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS"',
  '            android:value="stale.value" />',
  '    </application>',
  '</manifest>',
].join('\n');

const prepared = prepareAndroidManifest(base);
const secondPass = prepareAndroidManifest(prepared);

assert(prepared === secondPass, 'preparation must be idempotent');

assert(
  countName(prepared, 'android.permission.SCHEDULE_EXACT_ALARM') === 1,
  'SCHEDULE_EXACT_ALARM must exist exactly once'
);
assert(
  countName(prepared, 'android.permission.RECEIVE_BOOT_COMPLETED') === 1,
  'RECEIVE_BOOT_COMPLETED must exist exactly once'
);
assert(
  !prepared.includes('android.permission.USE_EXACT_ALARM'),
  'legacy USE_EXACT_ALARM must be removed'
);
assert(
  prepared.includes('com.example.OTHER_PERMISSION'),
  'unrelated manifest permission must be preserved'
);
assert(
  prepared.includes('com.other.ReceiverA') &&
    prepared.includes('com.other.ReceiverB'),
  'unrelated receivers must be preserved'
);
assert(
  prepared.includes('app.drugtracker.MainActivity'),
  'unrelated Capacitor activity must be preserved'
);
assert(
  prepared.includes('com.example.UNRELATED'),
  'unrelated application metadata must be preserved'
);

assert(
  countName(
    prepared,
    'app.drugtracker.autodeduction.AutoDeductionReceiver'
  ) === 1,
  'private AutoDeductionReceiver must exist exactly once'
);
assert(
  prepared.includes('app.drugtracker.action.AUTO_DEDUCTION'),
  'private AutoDeductionReceiver must have only its canonical action'
);
assert(
  !prepared.includes('stale.action'),
  'owned receiver contents must replace stale actions'
);

for (const legacy of [
  'app.drugtracker.autodeduction.AutoDeductionSystemReceiver',
  'app.drugtracker.criticalstock.CriticalStockSystemReceiver',
  'app.drugtracker.dosereminder.DoseReminderSystemReceiver',
  'com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher',
  'app.drugtracker.alarmruntime.ExactAlarmSystemReceiver',
]) {
  assert(
    !prepared.includes(legacy),
    'obsolete receiver must be removed: ' + legacy
  );
}

assert(
  countName(
    prepared,
    'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver'
  ) === 1,
  'shared system lifecycle receiver must exist exactly once'
);
for (const action of [
  'android.intent.action.BOOT_COMPLETED',
  'android.intent.action.QUICKBOOT_POWERON',
  'android.intent.action.TIMEZONE_CHANGED',
  'android.intent.action.TIME_SET',
  'android.intent.action.TIMEZONE_OFFSET_CHANGED',
  'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED',
]) {
  assert(
    prepared.includes(action),
    'shared system lifecycle receiver must contain ' + action
  );
}

assert(
  countName(
    prepared,
    'app.drugtracker.notificationruntime.NotificationRuntimeActionReceiver'
  ) === 1,
  'notification action receiver must exist exactly once'
);

const adapterMeta =
  'app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS';
assert(
  countName(prepared, adapterMeta) === 1,
  'exact-alarm feature adapter registry must exist exactly once'
);
assert(
  prepared.includes(
    'app.drugtracker.autodeduction.AutoDeductionAlarmFeature,app.drugtracker.criticalstock.CriticalStockAlarmAdapter,app.drugtracker.alarmruntime.DoseReminderAlarmFeature'
  ),
  'Auto + Critical Stock + Dose Reminder adapters must be registered'
);
assert(
  !prepared.includes('app.drugtracker.alarmruntime.CriticalStockAlarmFeature'),
  'obsolete shared CriticalStockAlarmFeature registry must not be introduced'
);

const document = parse(prepared);
const application = Array.from(document.documentElement.children).find(
  (child) => child.localName === 'application'
);
assert(application, 'application must remain a direct manifest child');

const autoReceiver = Array.from(application.children).find(
  (child) =>
    child.localName === 'receiver' &&
    androidAttribute(child, 'name') ===
      'app.drugtracker.autodeduction.AutoDeductionReceiver'
);
assert(autoReceiver, 'Auto receiver must remain structurally addressable');
assert(
  androidAttribute(autoReceiver, 'exported') === 'false',
  'Auto receiver must be private'
);
assert(
  androidAttribute(autoReceiver, 'enabled') === 'true',
  'Auto receiver must be enabled'
);
assert(
  !Array.from(autoReceiver.getElementsByTagName('action')).some(
    (action) =>
      androidAttribute(action, 'name') ===
      'android.intent.action.BOOT_COMPLETED'
  ),
  'private Auto receiver must not own BOOT_COMPLETED delivery'
);

const systemReceiver = Array.from(application.children).find(
  (child) =>
    child.localName === 'receiver' &&
    androidAttribute(child, 'name') ===
      'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver'
);
assert(systemReceiver, 'system lifecycle receiver must remain structurally addressable');
assert(
  androidAttribute(systemReceiver, 'exported') === 'true',
  'system lifecycle receiver must be exported for system broadcasts'
);

let malformedRejected = false;
try {
  prepareAndroidManifest('<manifest><application></manifest>');
} catch {
  malformedRejected = true;
}
assert(malformedRejected, 'malformed manifest must fail explicitly');

let namespaceRejected = false;
try {
  prepareAndroidManifest(
    '<manifest><application /></manifest>'
  );
} catch {
  namespaceRejected = true;
}
assert(namespaceRejected, 'missing Android namespace must fail explicitly');

let duplicateRejected = false;
try {
  prepareAndroidManifest(
    base.replace(
      '</application>',
      '<receiver android:name="app.drugtracker.autodeduction.AutoDeductionReceiver" />' +
        '</application>'
    )
  );
} catch {
  duplicateRejected = true;
}
assert(
  duplicateRejected,
  'duplicate owned receiver must fail explicitly'
);

console.log(
  'PASS: structural Android manifest preparation, lifecycle receiver ownership, cleanup, malformed-input rejection, and idempotency'
);
