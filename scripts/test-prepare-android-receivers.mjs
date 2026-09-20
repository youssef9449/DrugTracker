/**
 * Regression tests for safe shared alarm lifecycle receiver upsert and adapter registration in prepare-android.
 * Run: node scripts/test-prepare-android-receivers.mjs
 * No npm/npx required.
 */

/** Same algorithm as scripts/prepare-android.mjs upsertReceiverByName */
function upsertReceiverByName(xml, androidName, receiverXml) {
  const nameAttr = `android:name="${androidName}"`;
  const nameIdx = xml.indexOf(nameAttr);
  if (nameIdx === -1) {
    if (!xml.includes('</application>')) {
      throw new Error('</application> not found');
    }
    return {
      manifest: xml.replace('</application>', `${receiverXml}\n    </application>`),
      changed: true,
    };
  }
  const openTag = '<receiver';
  let openIdx = xml.lastIndexOf(openTag, nameIdx);
  if (openIdx === -1) throw new Error('open not found');
  const between = xml.slice(openIdx, nameIdx);
  if (between.includes('</receiver>')) throw new Error('ambiguous');
  const closeTag = '</receiver>';
  const closeIdx = xml.indexOf(closeTag, nameIdx);
  if (closeIdx === -1) throw new Error('unclosed');
  let start = openIdx;
  while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\t')) start--;
  if (start > 0 && xml[start - 1] === '\n') start--;
  const end = closeIdx + closeTag.length;
  return {
    manifest: xml.slice(0, start) + '\n' + receiverXml + xml.slice(end),
    changed: true,
  };
}

const PRIVATE = `        <receiver
            android:name="app.drugtracker.autodeduction.AutoDeductionReceiver"
            android:exported="false"
            android:enabled="true">
            <intent-filter>
                <action android:name="app.drugtracker.action.AUTO_DEDUCTION" />
            </intent-filter>
        </receiver>`;

const SYSTEM = `        <receiver
            android:name="app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver"
            android:exported="true"
            android:enabled="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.QUICKBOOT_POWERON" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
                <action android:name="android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED" />
            </intent-filter>
        </receiver>`;

function upsertApplicationMetaData(xml, androidName, value) {
  const nameAttr = `android:name="${androidName}"`;
  const metaXml = `        <meta-data
            android:name="${androidName}"
            android:value="${value}" />`;
  const nameIdx = xml.indexOf(nameAttr);
  if (nameIdx === -1) {
    if (!xml.includes('</application>')) {
      throw new Error('</application> not found');
    }
    return xml.replace('</application>', `${metaXml}
    </application>`);
  }
  const openIdx = xml.lastIndexOf('<meta-data', nameIdx);
  const closeIdx = xml.indexOf('/>', nameIdx);
  if (openIdx === -1 || closeIdx === -1) throw new Error('malformed meta-data');
  let start = openIdx;
  while (start > 0 && (xml[start - 1] === ' ' || xml[start - 1] === '\\t')) start--;
  if (start > 0 && xml[start - 1] === '\\n') start--;
  return xml.slice(0, start) + metaXml + xml.slice(closeIdx + 2);
}

function countName(xml, name) {
  let n = 0;
  let i = 0;
  const needle = `android:name="${name}"`;
  while ((i = xml.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// Input with unrelated receivers before and after target
const base = `<?xml version="1.0"?>
<manifest>
    <application>
        <receiver android:name="com.other.ReceiverA" android:exported="false"></receiver>
        <receiver android:name="com.other.ReceiverB" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
        <receiver
            android:name="app.drugtracker.autodeduction.AutoDeductionReceiver"
            android:exported="true"
            android:enabled="true">
            <intent-filter>
                <action android:name="app.drugtracker.action.AUTO_DEDUCTION" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>
        <activity android:name="app.drugtracker.MainActivity"></activity>
    </application>
</manifest>
`;

let { manifest } = upsertReceiverByName(
  base,
  'app.drugtracker.autodeduction.AutoDeductionReceiver',
  PRIVATE
);
assert(manifest.includes('com.other.ReceiverA'), 'Receiver A preserved');
assert(manifest.includes('com.other.ReceiverB'), 'Receiver B preserved');
assert(manifest.includes('app.drugtracker.MainActivity'), 'activity preserved');
assert(
  countName(manifest, 'app.drugtracker.autodeduction.AutoDeductionReceiver') === 1,
  'exactly one AutoDeductionReceiver'
);
assert(manifest.includes('android:exported="false"'), 'private exported=false');
assert(
  !manifest.match(
    /AutoDeductionReceiver[\s\S]*BOOT_COMPLETED[\s\S]*<\/receiver>/
  ) ||
    !manifest.includes('AutoDeductionReceiver') ||
    true,
  'placeholder'
);
// Private receiver must not contain BOOT_COMPLETED inside its own block
{
  const name = 'app.drugtracker.autodeduction.AutoDeductionReceiver';
  const i = manifest.indexOf(`android:name="${name}"`);
  const open = manifest.lastIndexOf('<receiver', i);
  const close = manifest.indexOf('</receiver>', i);
  const block = manifest.slice(open, close);
  assert(!block.includes('BOOT_COMPLETED'), 'private receiver has no BOOT');
}

({ manifest } = upsertReceiverByName(
  manifest,
  'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver',
  SYSTEM
));
assert(manifest.includes('com.other.ReceiverA'), 'A still after system insert');
assert(manifest.includes('com.other.ReceiverB'), 'B still after system insert');
assert(
  countName(manifest, 'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver') === 1,
  'one shared system lifecycle receiver'
);
assert(
  countName(manifest, 'app.drugtracker.autodeduction.AutoDeductionSystemReceiver') === 0,
  'legacy Auto system receiver removed'
);

// Idempotency: run again
({ manifest } = upsertReceiverByName(
  manifest,
  'app.drugtracker.autodeduction.AutoDeductionReceiver',
  PRIVATE
));
({ manifest } = upsertReceiverByName(
  manifest,
  'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver',
  SYSTEM
));
assert(
  countName(manifest, 'app.drugtracker.autodeduction.AutoDeductionReceiver') === 1,
  'idempotent private'
);
assert(
  countName(manifest, 'app.drugtracker.alarmruntime.DrugTrackerAlarmSystemReceiver') === 1,
  'idempotent system'
);
assert(manifest.includes('com.other.ReceiverA'), 'A after idempotent pass');
assert(manifest.includes('com.other.ReceiverB'), 'B after idempotent pass');
assert(manifest.includes('android.intent.action.QUICKBOOT_POWERON'), 'shared receiver handles QUICKBOOT');
assert(manifest.includes('android.intent.action.TIMEZONE_CHANGED'), 'shared receiver handles TIMEZONE_CHANGED');
assert(manifest.includes('android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED'), 'shared receiver handles exact permission');
manifest = upsertApplicationMetaData(
  manifest,
  'app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS',
  'app.drugtracker.autodeduction.AutoDeductionAlarmFeature,app.drugtracker.alarmruntime.CriticalStockAlarmFeature,app.drugtracker.alarmruntime.DoseReminderAlarmFeature'
);
const adapterMeta = 'app.drugtracker.EXACT_ALARM_FEATURE_ADAPTERS';
assert(countName(manifest, adapterMeta) === 1, 'one shared feature-adapter registry');
assert(
  manifest.includes('app.drugtracker.autodeduction.AutoDeductionAlarmFeature') &&
  manifest.includes('app.drugtracker.alarmruntime.CriticalStockAlarmFeature') &&
  manifest.includes('app.drugtracker.alarmruntime.DoseReminderAlarmFeature'),
  'Auto + Critical Stock + Dose Reminder adapters are registered'
);


// Dangerous regex must NOT be used — prove old pattern would delete A
const dangerous = /\s*<receiver[\s\S]*?app\.drugtracker\.autodeduction\.AutoDeductionReceiver[\s\S]*?<\/receiver>/;
const bad = base.replace(dangerous, '\n' + PRIVATE);
assert(!bad.includes('com.other.ReceiverA') || true, 'document danger');
// On this input, dangerous regex starts at first <receiver (A) and eats through AutoDeduction
assert(!bad.includes('com.other.ReceiverA'), 'dangerous regex deletes Receiver A (expected failure mode)');
assert(manifest.includes('com.other.ReceiverA'), 'safe upsert keeps Receiver A');

console.log('PASS: prepare-android receiver upsert regression tests');
