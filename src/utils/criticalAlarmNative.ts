import { Capacitor, registerPlugin } from '@capacitor/core';

interface CriticalStockPlugin {
  schedule(options: {
    medicationId: string;
    localDate: string;
    localTime: string;
    title: string;
    body: string;
    channelId: string;
    channelName: string;
    channelImportance: number;
    channelVisibility: number;
    smallIcon: string;
    autoCancel: boolean;
    ongoing: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  cancel(options: {
    medicationId: string;
  }): Promise<{
    ok: boolean;
    status?: 'SUCCESS' | 'ALREADY_ABSENT' | 'FAILED';
    error?: string;
  }>;
  verify(options: {
    medicationId: string;
  }): Promise<{
    ok: boolean;
    triggerAtEpochMs?: number;
  }>;
}

const CriticalStock = registerPlugin<CriticalStockPlugin>('CriticalStock');

function isAndroid(): boolean {
  try {
    return (
      typeof Capacitor !== 'undefined' && Capacitor.getPlatform() === 'android'
    );
  } catch {
    return false;
  }
}

function localDate(epochMs: number): string {
  const value = new Date(epochMs);
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

function localTime(epochMs: number): string {
  const value = new Date(epochMs);
  return [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
  ].join(':');
}

export async function scheduleCriticalAlarmNative(
  medId: string,
  medName: string,
  criticalDateMs: number,
  unit: string
): Promise<boolean> {
  if (!isAndroid()) return false;

  try {
    const result = await CriticalStock.schedule({
      medicationId: medId,
      localDate: localDate(criticalDateMs),
      localTime: localTime(criticalDateMs),
      title: `🚨 ${medName}: اقترب النفاد الحرج`,
      body: `مخزون "${medName}" دخل مرحلة النفاد الحرج (${unit}). يرجى التعبئة فوراً!`,
      channelId: 'low-stock',
      channelName: 'تنبيهات النفاذ',
      channelImportance: 4,
      channelVisibility: 1,
      smallIcon: 'ic_launcher',
      autoCancel: true,
      ongoing: false,
    });
    return result?.ok === true;
  } catch (error) {
    console.warn('[critical-alarm] schedule failed:', error);
    return false;
  }
}

export async function cancelCriticalAlarmNative(
  medId: string
): Promise<void> {
  if (!isAndroid()) return;
  try {
    await CriticalStock.cancel({ medicationId: medId });
  } catch (error) {
    console.warn('[critical-alarm] cancel failed:', error);
  }
}

export async function verifyCriticalAlarmPendingNative(
  medId: string,
  alarmTimeMs: number
): Promise<boolean> {
  if (!isAndroid()) return false;

  try {
    const result = await CriticalStock.verify({
      medicationId: medId,
    });
    return (
      result?.ok === true &&
      result.triggerAtEpochMs === alarmTimeMs
    );
  } catch {
    return false;
  }
}
