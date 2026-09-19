/**
 * Seed data for Drug Tracker..
 *
 * This module is imported by `src/App.tsx`:
 *     import { getInitialMedications, getInitialLogs } from './data/initialData';
 *
 * It provides the default 3 medications that appear on a fresh install
 * (before the user has saved anything to localStorage). Seed logs are
 * intentionally empty — legacy auto_daily automatic-deduction seed logs
 * were removed in Issue #269 (Exact Auto uses occurrence-based exact_auto
 * logs produced at runtime, not day-based seed data). Once the user adds / edits medications, the state
 * is persisted in localStorage (`android_med_tracker_items_v2`)
 * and this file is no longer used as the source of truth.
 *
 * #102: these are factory functions (not module-load `const` arrays) so
 * the timestamps are computed at first access, not at module load. A
 * long-running dev session that crosses midnight previously kept stale
 * "today" values; now each call gets the current date.
 *
 * Both functions accept an optional `todayStr` parameter so the caller
 * can share a single date snapshot. Medications use it for lastSyncDate;
 * getInitialLogs returns an empty collection (Issue #269).
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

export function getInitialMedications(todayStr: string = getTodayDateString()): Medication[] {
  const today = todayStr;
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
    },
  ];
}

/**
 * Fresh installs start with no consumption logs.
 * Issue #269: do not seed legacy auto_daily automatic-deduction logs.
 * Exact Auto produces exact_auto occurrence logs at runtime only.
 */
export function getInitialLogs(_todayStr: string = getTodayDateString()): ConsumptionLog[] {
  return [];
}
