import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type {
  Medication,
  ConsumptionLog,
  PharmacySettings,
} from '../types';
import { DEFAULT_PHARMACY_SETTINGS } from '../types';
import {
  requestNotificationPermission,
  getNotificationPermission,
  getExactAlarmPermission,
} from '../utils/notifications';
import { initNativeBridge } from '../native';
import { migrateSchema } from '../lib/migration';
import { loadJson, loadString, persist } from '../utils/storage';
import { migrateMedicationsLegacySingleDose } from '../utils/legacySingleDoseMigration';
import {
  STORAGE_MEDS_KEY,
  STORAGE_LOGS_KEY,
  STORAGE_PHARMACY_KEY,
  STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
  STORAGE_AUTO_DEDUCT_PROMPTED_KEY,
  SOUND_KEY,
  NOTIFICATIONS_KEY,
  FONT_SIZE_KEY,
  CRITICAL_STOCK_ALERTS_KEY,
  COMPACT_VIEW_KEY,
} from '../constants/storageKeys';

export interface AppHydrationSetters {
  setMedications: Dispatch<SetStateAction<Medication[]>>;
  setLogs: Dispatch<SetStateAction<ConsumptionLog[]>>;
  setPharmacySettings: Dispatch<SetStateAction<PharmacySettings>>;
  setHydrated: Dispatch<SetStateAction<boolean>>;
  setIsFirstRun: Dispatch<SetStateAction<boolean>>;
  setIsAutoDeductPromptOpen: Dispatch<SetStateAction<boolean>>;
  setSoundEnabled: Dispatch<SetStateAction<boolean>>;
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>;
  setCriticalStockAlertsEnabled: Dispatch<SetStateAction<boolean>>;
  setExactAlarmEnabled: Dispatch<SetStateAction<boolean | null>>;
  setGlobalAutoDeductEnabled: Dispatch<SetStateAction<boolean>>;
  setFontScale: Dispatch<SetStateAction<'normal' | 'large'>>;
  setIsCompactView: Dispatch<SetStateAction<boolean>>;
}

/**
 * Client-side hydration: load persisted state, request permissions,
 * init native bridge, then flip hydrated=true.
 *
 * Ordering is intentional and must be preserved:
 * migrateSchema → read storage → legacy single-dose→doseSchedule migration
 * → Promise.all(permissions + initNativeBridge) → setHydrated(true) in finally.
 */
export function useAppHydration(setters: AppHydrationSetters): void {
  const {
    setMedications,
    setLogs,
    setPharmacySettings,
    setHydrated,
    setIsFirstRun,
    setIsAutoDeductPromptOpen,
    setSoundEnabled,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setExactAlarmEnabled,
    setGlobalAutoDeductEnabled,
    setFontScale,
    setIsCompactView,
  } = setters;

  useEffect(() => {
    // M11: run schema migration first so any future key-shape changes
    // are applied before we read the (possibly migrated) keys.
    migrateSchema();

    // Medications — use loadJson (silent fallback). The "first run"
    // detection distinguishes "no key set" (null) from "empty array
    // explicitly saved" (loadJson returns []).
    const savedMedsRaw = localStorage.getItem(STORAGE_MEDS_KEY);
    const autoDeductPromptedRaw = localStorage.getItem(STORAGE_AUTO_DEDUCT_PROMPTED_KEY);
    if (savedMedsRaw === null) {
      // First-ever open: no saved meds. The seed data is a demo —
      // flag it so the auto-deduction + alert + reminder effects
      // don't fire ghost notifications/alarms for seed meds.
      setIsFirstRun(true);
      if (autoDeductPromptedRaw === null) {
        setIsAutoDeductPromptOpen(true);
      }
    } else {
      // #15: accept an empty array here (don't gate on length > 0).
      // Otherwise, when the user deletes all medications, the persisted
      // "[]" is ignored on next launch, the seed INITIAL_MEDICATIONS
      // stays in state, and the hydration-gated persistence effect
      // overwrites the user's "[]" with the seed meds.
      const parsed = loadJson<Medication[] | null>(STORAGE_MEDS_KEY, null);
      if (Array.isArray(parsed)) {
        // Issue #268: materialize explicit doseSchedule for legacy single-dose
        // meds before hydrated gates Exact scheduling.
        const { medications: migrated, changed } =
          migrateMedicationsLegacySingleDose(parsed);
        setMedications(migrated);
        if (changed) {
          persist(STORAGE_MEDS_KEY, migrated, { json: true });
        }
      }
    }

    // Logs
    const savedLogs = loadJson<ConsumptionLog[] | null>(STORAGE_LOGS_KEY, null);
    if (Array.isArray(savedLogs)) setLogs(savedLogs);

    // Pharmacy settings — custom parsing for the legacy customerCode/
    // pharmacyName shim, so we read the raw object via loadJson then
    // post-process.
    const parsed = loadJson<Partial<PharmacySettings> & { pharmacies?: unknown } | null>(
      STORAGE_PHARMACY_KEY,
      null
    );
    if (parsed && typeof parsed === 'object') {
      // Clear legacy default customerCode ('14739') and legacy default pharmacyName ('الصيدلية')
      const loadedCustomerCode =
        parsed.customerCode === '14739' ? '' : (parsed.customerCode || '');
      const loadedPharmacyName =
        parsed.pharmacyName === 'الصيدلية' ? '' : (parsed.pharmacyName || '');
      const legacyPharmacy = loadedPharmacyName || loadedCustomerCode || parsed.pharmacyPhone
        ? [{
            id: 'pharmacy-legacy',
            name: loadedPharmacyName || 'صيدلية محفوظة',
            phone: parsed.pharmacyPhone || '',
            customerCode: loadedCustomerCode,
          }]
        : [];
      const pharmacies = Array.isArray(parsed.pharmacies) ? parsed.pharmacies : legacyPharmacy;
      setPharmacySettings({
        ...DEFAULT_PHARMACY_SETTINGS,
        ...parsed,
        customerCode: loadedCustomerCode,
        pharmacyName: loadedPharmacyName,
        pharmacies,
        selectedPharmacyId: parsed.selectedPharmacyId || pharmacies[0]?.id || '',
      });
    }

    // Sound flag — persisted as 'true'/'false' string; default true.
    setSoundEnabled(loadString(SOUND_KEY, 'true') !== 'false');

    // Notifications flag — persisted as 'true'/'false' string if user explicitly set it.
    const savedNotifications = loadString(NOTIFICATIONS_KEY, '');
    if (savedNotifications === 'true' || savedNotifications === 'false') {
      setNotificationsEnabled(savedNotifications === 'true');
    }

    // Font size — persisted as 'normal'/'large' string.
    if (loadString(FONT_SIZE_KEY, 'normal') === 'large') setFontScale('large');

    // Critical-stock alerts — default true (persisted as 'true'/'false').
    setCriticalStockAlertsEnabled(loadString(CRITICAL_STOCK_ALERTS_KEY, 'true') !== 'false');

    // Global auto-deduct — default true.
    setGlobalAutoDeductEnabled(loadString(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, 'true') !== 'false');

    // Compact view preference for All Medications
    if (loadString(COMPACT_VIEW_KEY, 'false') === 'true') {
      setIsCompactView(true);
    }

    // Initialize the in-app notifications flag from the async permission
    // state if no preference has been explicitly saved yet by the user.
    // Also check exact-alarm permission (Android 12+) and run native
    // bridge initialization (notification channels, listeners).
    //
    // Hydration MUST complete only AFTER all three settle so the
    // scheduler effects never run before Android notification channels
    // exist. Previously initNativeBridge ran fire-and-forget alongside
    // the permission Promise.all, which allowed hydrated===true while
    // channel creation was still in flight.
    //
    // Each task catches its own errors so a single failure cannot
    // prevent the others from completing, and .finally still marks
    // the app ready (matching the previous fault-tolerant policy).
    Promise.all([
      getNotificationPermission()
        .then((perm) => {
          if (localStorage.getItem(NOTIFICATIONS_KEY) === null) {
            setNotificationsEnabled(perm === 'granted');

            // Auto-request notification permission on the FIRST app open
            // after install. The browser only shows the permission prompt
            // when the permission state is 'default' (user hasn't been asked
            // yet). Once the user grants or denies, the browser remembers
            // the decision and won't re-show the prompt. If the user denied
            // permission, this becomes a no-op; the bell button in
            // AppHeader then takes the user to OS settings to re-enable.
            //
            // Auto-requesting on mount is recommended by the Web Push API
            // spec because it ensures the prompt shows after the user has
            // had a chance to see the app's value (which is now true on
            // first open, since the user has just installed it).
            //
            // On Android 13+ (Capacitor), this triggers the OS
            // POST_NOTIFICATIONS permission dialog via
            // LocalNotifications.requestPermissions(). On older Android,
            // this is a no-op (notifications allowed by default).
            if (perm === 'default') {
              requestNotificationPermission()
                .then((granted) => {
                  if (localStorage.getItem(NOTIFICATIONS_KEY) === null) {
                    setNotificationsEnabled(granted);
                  }
                })
                .catch((err) => {
                  console.warn('[App] Auto-request notification permission failed:', err);
                });
            }
          }
        })
        .catch((err) => {
          console.warn('[App] getNotificationPermission failed:', err);
        }),
      getExactAlarmPermission()
        .then((state) => {
          setExactAlarmEnabled(state === 'granted');
        })
        .catch((err) => {
          console.warn('[App] getExactAlarmPermission failed:', err);
        }),
      // Native bridge: status bar, back button, notification channels,
      // and listeners. No-op on web — see src/native.ts. Included in
      // Promise.all so setHydrated cannot race ahead of channel setup.
      initNativeBridge().catch((err) => {
        console.warn('[App] Native bridge init failed:', err);
      }),
    ]).finally(() => {
      setHydrated(true);
    });
  }, []);

}
