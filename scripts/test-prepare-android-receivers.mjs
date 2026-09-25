/**
 * Regression tests for the structural Android manifest preparation contract.
 *
 * Run: node scripts/test-prepare-android-receivers.mjs
 * No npm/npx invocation is required by this script itself.
 */

import { prepareAndroidManifest } from './prepare-android.mjs';

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exit(1);
  }
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function androidAttribute(element, localName) {
  return element.getAttributeNS(ANDROID_NS, localName);
}

function parse(xml) {
  const parser = new DOMParser();
  const document = parser.parseFromString(xml, 'application/xml');
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
  '        <meta-data android:value="keep-me" android:name="com.example.UNRELATED" />',
  '        <receiver android:exported="false" android:name="com.other.ReceiverBefore">',
  '            <intent-filter>',
  '                <action android:name="com.other.BEFORE" />',
  '            </intent-filter>',
  '        </receiver>',
  '        <receiver',
  '            android:enabled="true"',
  '            android:name="app.drugtracker.autodeduction.AutoDeductionReceiver"',
  '            android:exported="true">',
  '            <intent-filter>',
  '                <action android:name="stale.action" />',
  '            </intent-filter>',
  '        </receiver>',
  '        <receiver android:name="com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher" />',
  '        <receiver android:name="com.other.ReceiverAfter" android:exported="false" />',
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
  count(prepared, 'android.permission.SCHEDULE_EXACT_ALARM') === 1,
  'SCHEDULE_EXACT_ALARM must exist exactly once'
);
assert(
  count(prepared, 'android.permission.RECEIVE_BOOT_COMPLETED') === 1,
  'RECEIVE_BOOT_COMPLETED must exist exactly once'
);
assert(
  !prepared.includes('android.permission.USE_EXACT_ALARM'),
  'legacy USE_EXACT_ALARM must be removed'
);
assert(
  count(
    prepared,
    'app.drugtracker.autodeduction.AutoDeductionReceiver'
  ) === 1,
  'Auto receiver must exist exactly once'
);
assert(
  prepared.includes('app.drugtracker.action.AUTO_DEDUCTION'),
  'Auto receiver action must be canonical'
);
assert(
  !prepared.includes('stale.action'),
  'owned receiver contents must be replaced, not merged with stale content'
);
assert(
  prepared.includes('com.other.ReceiverBefore') &&
    prepared.includes('com.other.ReceiverAfter'),
  'unrelated receivers must be preserved'
);
assert(
  prepared.includes('com.example.UNRELATED'),
  'unrelated application metadata must be preserved'
);
assert(
  !prepared.includes('com.capacitorjs.plugins.localnotifications.TimedNotificationPublisher'),
  'obsolete generated notification receiver must be removed'
);
assert(
  prepared.includes(
    'app.drugtracker.notificationruntime.NotificationRuntimeActionReceiver'
  ),
  'notification action receiver must be present'
);
assert(
  prepared.includes(
    'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver'
  ),
  'shared system lifecycle receiver must be present'
);
assert(
  prepared.includes(
    'app.drugtracker.autodeduction.AutoDeductionAlarmFeature,app.drugtracker.criticalstock.CriticalStockAlarmAdapter,app.drugtracker.alarmruntime.DoseReminderAlarmFeature'
  ),
  'exact-alarm feature adapter metadata must be canonical'
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
  'Auto receiver exported value must be canonical'
);
assert(
  androidAttribute(autoReceiver, 'enabled') === 'true',
  'Auto receiver enabled value must be canonical'
);

let malformedRejected = false;
try {
  prepareAndroidManifest('<manifest><application></manifest>');
} catch {
  malformedRejected = true;
}
assert(malformedRejected, 'malformed manifest must fail explicitly');

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
assert(duplicateRejected, 'duplicate owned receiver must fail explicitly');

console.log(
  'Android manifest preparation verification passed: structural updates, reordered attributes/elements, cleanup, malformed-input rejection, and idempotency are covered.'
);
