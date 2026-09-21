import { Capacitor, registerPlugin } from '@capacitor/core';

interface CriticalStockPlugin {
  schedule(options: {
    medicationId: string;
    medicationName: string;
    unit: string;
    triggerAtEpochMs: number;
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
    alarmTimeMs: number;
  }): Promise<{ ok: boolean }>;
  listScheduled(): Promise<{ ids: string[] }>;
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
      medicationName: medName,
      unit,
      triggerAtEpochMs: criticalDateMs,
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
      alarmTimeMs,
    });
    return result?.ok === true;
  } catch {
    return false;
  }
}

export async function listScheduledCriticalMedicationIdsNative(): Promise<
  string[]
> {
  if (!isAndroid()) return [];
  try {
    const result = await CriticalStock.listScheduled();
    return Array.isArray(result?.ids) ? result.ids : [];
  } catch {
    return [];
  }
}
