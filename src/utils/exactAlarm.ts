import { Capacitor, registerPlugin } from '@capacitor/core';

interface ExactAlarmRuntimePlugin {
  canScheduleExactAlarms(): Promise<{ granted: boolean }>;
  openSettings(): Promise<{ opened: boolean; error?: string }>;
}

const ExactAlarmRuntime = registerPlugin<ExactAlarmRuntimePlugin>(
  'ExactAlarmRuntime'
);

function isAndroid(): boolean {
  try {
    return typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export async function getExactAlarmPermission(): Promise<
  'granted' | 'denied' | 'unsupported'
> {
  if (!isAndroid()) return 'granted';
  try {
    const result = await ExactAlarmRuntime.canScheduleExactAlarms();
    return result?.granted === true ? 'granted' : 'denied';
  } catch (error) {
    console.warn('[exact-alarm] capability check failed:', error);
    return 'unsupported';
  }
}

export async function openExactAlarmSettings(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    const result = await ExactAlarmRuntime.openSettings();
    return result?.opened === true;
  } catch (error) {
    console.warn('[exact-alarm] openSettings failed:', error);
    return false;
  }
}

export async function canScheduleExactAlarms(): Promise<boolean> {
  return (await getExactAlarmPermission()) === 'granted';
}
