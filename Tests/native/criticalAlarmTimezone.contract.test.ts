import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Static regression: Critical alarm native timezone lifecycle sources
 * mirror AutoDeductionSystemReceiver goAsync pattern and are installed
 * via prepare-android.mjs.
 */
describe('Critical alarm TIMEZONE_CHANGED native lifecycle', () => {
  const root = path.resolve(__dirname, '../..');

  it('ships CriticalAlarmStore / Lifecycle / SystemReceiver / Plugin', () => {
    const dir = path.join(root, 'native-android/critical-alarm');
    for (const f of [
      'CriticalAlarmStore.java',
      'CriticalAlarmLifecycle.java',
      'CriticalAlarmSystemReceiver.java',
      'CriticalAlarmPlugin.java',
    ]) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
  });

  it('SystemReceiver handles TIMEZONE_CHANGED with goAsync', () => {
    const src = fs.readFileSync(
      path.join(root, 'native-android/critical-alarm/CriticalAlarmSystemReceiver.java'),
      'utf8'
    );
    expect(src).toContain('ACTION_TIMEZONE_CHANGED');
    expect(src).toContain('goAsync()');
  });

  it('Store persists local date/time metadata', () => {
    const src = fs.readFileSync(
      path.join(root, 'native-android/critical-alarm/CriticalAlarmStore.java'),
      'utf8'
    );
    expect(src).toContain('targetDate');
    expect(src).toContain('targetLocalTime');
    expect(src).toContain('fireAtMs');
    expect(src).toContain('timezoneId');
  });

  it('prepare-android installs and registers the receiver', () => {
    const prep = fs.readFileSync(path.join(root, 'scripts/prepare-android.mjs'), 'utf8');
    expect(prep).toContain('critical-alarm');
    expect(prep).toContain('CriticalAlarmSystemReceiver');
    expect(prep).toContain('TIMEZONE_CHANGED');
  });
});
