/**
 * Seed data for النغنغ (Drug Tracker).
 *
 * This module is imported by `src/App.tsx`:
 *     import { getInitialMedications, getInitialLogs } from './data/initialData';
 *
 * It provides the default 3 medications + 2 consumption logs that
 * appear on a fresh install (before the user has saved anything to
 * localStorage). Once the user adds / edits medications, the state
 * is persisted in localStorage (`android_med_tracker_items_v2`)
 * and this file is no longer used as the source of truth.
 *
 * #102: these are factory functions (not module-load `const` arrays) so
 * the timestamps are computed at first access, not at module load. A
 * long-running dev session that crosses midnight previously kept stale
 * "today" values; now each call gets the current date.
 *
 * NOTE: if AI Studio's preview shows an error like
 *     Failed to resolve import "./data/initialData" from "src/App.tsx"
 * it is a stale-cache issue in AI Studio's preview server, not a
 * real bug — this file is tracked in the repo (verified via
 * `git ls-files src/data/initialData.ts`). A hard reload
 * (Ctrl+Shift+R) clears the cache and resolves the error.
 */
import { Medication, ConsumptionLog } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';

export function getInitialMedications(): Medication[] {
  const today = getTodayDateString();
  const nowIso = new Date().toISOString();
  return [
    {
      id: 'med-1',
      name: 'كونكور 5 مجم (Concor)',
      currentPills: 4,
      dailyDose: 1,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'teal',
      category: 'ضغط الدم',
      notes: 'قرص صباحاً بعد الإفطار',
      createdAt: nowIso,
      lastSyncDate: today,
      autoDeductEnabled: true,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
      reminderEnabled: true,
      reminderTime: '09:00',
      notificationSound: 'gentle_bell',
    },
    {
      id: 'med-2',
      name: 'جلوكوفاج 500 مجم (Glucophage)',
      currentPills: 2,
      dailyDose: 2,
      unit: 'قرص',
      warningThresholdDays: 5,
      colorTag: 'rose',
      category: 'السكري',
      notes: 'قرص مع الغداء وقرص مع العشاء',
      createdAt: nowIso,
      lastSyncDate: today,
      autoDeductEnabled: true,
      stripsPerBox: 5,
      pillsPerStrip: 10,
      packageSize: 50,
      reminderEnabled: true,
      reminderTime: '14:00',
      notificationSound: 'marimba',
    },
    {
      id: 'med-3',
      name: 'فيتامين د (Vitamin D3)',
      currentPills: 28,
      dailyDose: 1,
      unit: 'كبسولة',
      warningThresholdDays: 7,
      colorTag: 'amber',
      category: 'فيتامينات',
      notes: 'كبسولة يومياً بعد وجبة دسمة',
      createdAt: nowIso,
      lastSyncDate: today,
      autoDeductEnabled: true,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
      reminderEnabled: true,
      reminderTime: '21:00',
      notificationSound: 'harp',
    },
  ];
}

export function getInitialLogs(): ConsumptionLog[] {
  const today = getTodayDateString();
  const nowIso = new Date().toISOString();
  return [
    {
      id: 'log-init-1',
      medicationId: 'med-1',
      medicationName: 'كونكور 5 مجم (Concor)',
      type: 'auto_daily',
      amount: -1,
      date: today,
      timestamp: nowIso,
      description: 'خصم استهلاك اليوم تلقائياً (-1 قرص)',
    },
    {
      id: 'log-init-2',
      medicationId: 'med-2',
      medicationName: 'جلوكوفاج 500 مجم (Glucophage)',
      type: 'auto_daily',
      amount: -2,
      date: today,
      timestamp: nowIso,
      description: 'خصم استهلاك اليوم تلقائياً (-2 قرص)',
    },
  ];
}
