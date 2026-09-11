import { CriticalTransitionState, ScheduledCriticalAlarmRecord, ScheduledCriticalAlarmStatus } from '../types';
import { loadJson, saveJson } from './storage';

export const CRITICAL_TRANSITION_STORAGE_KEY = 'android_med_tracker_critical_transition_v1';
export const SCHEDULED_CRITICAL_STORAGE_KEY = 'android_med_tracker_scheduled_critical_v1';
export const LEGACY_CRITICAL_NOTIFIED_KEY = 'android_med_tracker_critical_notified_v2';

/**
 * Load the persistent critical transition state map:
 * { [medId]: { transitionKey, enteredAt, notificationSent } }
 *
 * Falls back to migrating any existing legacy v2 notified keys if v1 is empty.
 */
export function loadCriticalTransitions(): Record<string, CriticalTransitionState> {
  const v1 = loadJson<Record<string, CriticalTransitionState>>(CRITICAL_TRANSITION_STORAGE_KEY, {});
  if (v1 && typeof v1 === 'object' && Object.keys(v1).length > 0) {
    return v1;
  }

  // Backward compatibility / migration from legacy v2 notified map
  const legacy = loadJson<Record<string, string>>(LEGACY_CRITICAL_NOTIFIED_KEY, {});
  if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) {
    const migrated: Record<string, CriticalTransitionState> = {};
    for (const [id, key] of Object.entries(legacy)) {
      if (typeof key === 'string' && key) {
        migrated[id] = {
          transitionKey: key,
          enteredAt: Date.now(),
          notificationSent: true,
        };
      }
    }
    return migrated;
  }

  return {};
}

/**
 * Save the persistent critical transition state map.
 */
export function saveCriticalTransitions(transitions: Record<string, CriticalTransitionState>): void {
  saveJson(CRITICAL_TRANSITION_STORAGE_KEY, transitions);
  const legacyMap: Record<string, string> = {};
  for (const [id, state] of Object.entries(transitions)) {
    if (state.notificationSent) {
      legacyMap[id] = state.transitionKey;
    }
  }
  saveJson(LEGACY_CRITICAL_NOTIFIED_KEY, legacyMap);
}

/**
 * Load the persistent scheduled critical alarm records:
 * { [medId]: { transitionKey, alarmTime, status: 'NOT_SCHEDULED' | 'SCHEDULED' | 'DELIVERED' } }
 *
 * Normalizes legacy records that might have lacked the `status` field.
 */
export function loadScheduledCriticalAlarms(): Record<string, ScheduledCriticalAlarmRecord> {
  const raw = loadJson<Record<string, Partial<ScheduledCriticalAlarmRecord>>>(SCHEDULED_CRITICAL_STORAGE_KEY, {});
  const normalized: Record<string, ScheduledCriticalAlarmRecord> = {};
  if (!raw || typeof raw !== 'object') return normalized;

  for (const [id, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    const transitionKey = typeof rec.transitionKey === 'string' ? rec.transitionKey : `crit_${id}_${rec.alarmTime || 0}`;
    const alarmTime = typeof rec.alarmTime === 'number' ? rec.alarmTime : 0;
    const status: ScheduledCriticalAlarmStatus =
      rec.status === 'SCHEDULED' || rec.status === 'DELIVERED' || rec.status === 'NOT_SCHEDULED'
        ? rec.status
        : (alarmTime > 0 ? 'SCHEDULED' : 'NOT_SCHEDULED');
    normalized[id] = { transitionKey, alarmTime, status };
  }
  return normalized;
}

/**
 * Save the persistent scheduled critical alarm records.
 */
export function saveScheduledCriticalAlarms(records: Record<string, ScheduledCriticalAlarmRecord>): void {
  saveJson(SCHEDULED_CRITICAL_STORAGE_KEY, records);
}

/**
 * Generate a stable transition key representing a critical episode for a medication.
 */
export function generateCriticalTransitionKey(medId: string, timestamp: number = Date.now()): string {
  return `crit_${medId}_${timestamp}`;
}
