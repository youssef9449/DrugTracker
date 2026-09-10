import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Medication,
  ConsumptionLog,
  PharmacySettings,
  Pharmacy,
  DEFAULT_PHARMACY_SETTINGS,
  calculateMedicationStatus,
  CustomSoundFile,
  MedicationStatus,
} from './types';
// Seed data — default 3 medications + 2 consumption logs shown on fresh
// install. The file lives at src/data/initialData.ts (relative path).
// See that file's header comment for the AI Studio cache-error
// troubleshooting note.
import { INITIAL_MEDICATIONS, INITIAL_LOGS } from './data/initialData';
import { AndroidBottomNav, ActiveTab } from './components/AndroidBottomNav';
import { AppHeader } from './components/AppHeader';
import { LowStockBanner } from './components/LowStockBanner';
import { MedicationCard } from './components/MedicationCard';
import { PharmacyShoppingView } from './components/PharmacyShoppingView';
import { PharmacyManagementView } from './components/PharmacyManagementView';
import { ConsumptionLogView } from './components/ConsumptionLogView';
import { AddMedicationModal } from './components/AddMedicationModal';
import { RefillModal } from './components/RefillModal';
import { AppSettingsModal } from './components/AppSettingsModal';
import { AndroidFab } from './components/AndroidFab';
import { EmptyState } from './components/EmptyState';
import { DoseAlarmModal } from './components/DoseAlarmModal';
import { UpdatePrompt } from './components/UpdatePrompt';
import { playSuccessChime } from './utils/sound';
import {
  saveGlobalCustomSound,
  loadGlobalCustomSound,
  deleteGlobalCustomSound,
} from './utils/audioStore';
import {
  requestNotificationPermission,
  sendMedicineAlert,
  sendCriticalStockAlert,
  sendTestAlertNotification,
  getNotificationPermission,
  getNotificationPermissionSync,
} from './utils/notifications';
import {
  getTodayDateString,
  syncAutoDailyDeductions,
  effectiveCurrentPills,
  settleDoseChange,
  settleAutoDeductToggle,
} from './utils/dateCalculations';
import { OrderItem } from './utils/whatsapp';
import { useDoseReminders } from './hooks/useDoseReminders';
import { useCriticalAlarmScheduler } from './hooks/useCriticalAlarmScheduler';
import { initNativeBridge, registerBackButtonHandler, cleanupNativeListeners } from './native';
import { migrateSchema } from './lib/migration';
import { getInitialTab } from './lib/initialTab';
import { Zap, ZapOff } from 'lucide-react';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_GLOBAL_AUTO_DEDUCT_KEY = 'android_med_tracker_auto_deduct_v1';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_PHARMACY_KEY = 'android_med_tracker_pharmacy_v2';
const SOUND_KEY = 'android_med_tracker_sound_v1';
// Font size preference: 'normal' or 'large'. Persisted so it survives
// app relaunch. Applied as a CSS class on the phone-frame container.
const FONT_SIZE_KEY = 'android_med_tracker_font_size_v1';
// Critical-stock alerts (the urgent "حرج" notifications) — user can
// toggle this on/off from the AppHeader. Default true (enabled by
// default — this is the headline feature of the app). The critical
// threshold itself is derived per-medication from warningThresholdDays
// via getCriticalThresholdDays() — see src/types.ts.
const CRITICAL_STOCK_ALERTS_KEY = 'android_med_tracker_critical_alerts_v1';

/**
 * Persist a JSON-serializable value to localStorage, returning a
 * descriptive error string on failure (M1: previously every write was
 * wrapped in `try { … } catch {}` which silently dropped data on quota
 * exhaustion — the caller now decides whether to surface the failure).
 *
 * Returns null on success, or a short Arabic error message on failure.
 */
function persistJson(key: string, value: unknown): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return null;
  } catch (err) {
    const reason =
      err instanceof DOMException && err.name === 'QuotaExceededError'
        ? 'مساحة التخزين ممتلئة'
        : 'تعذّر حفظ البيانات';
    console.warn(`[App] localStorage.setItem(${key}) failed:`, err);
    return reason;
  }
}

/** Persist a plain string value with the same error-surfacing contract. */
function persistString(key: string, value: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    localStorage.setItem(key, value);
    return null;
  } catch (err) {
    const reason =
      err instanceof DOMException && err.name === 'QuotaExceededError'
        ? 'مساحة التخزين ممتلئة'
        : 'تعذّر حفظ البيانات';
    console.warn(`[App] localStorage.setItem(${key}) failed:`, err);
    return reason;
  }
}

/**
 * Severity rank for MedicationStatus, used by the alert effect to
 * decide whether a status change is a worsening (fire) or an
 * improvement (don't fire, just update the tracker). Higher = worse.
 * Declared at module scope so it's stable across renders (no dep needed).
 */
const STATUS_RANK: Record<MedicationStatus, number> = {
  sufficient: 0,
  warning: 1,
  critical: 2,
  out_of_stock: 3,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>(getInitialTab);

  // Deterministic-first render: we start from the seed defaults (no
  // localStorage / IndexedDB access during the initial render) and
  // hydrate from storage in a useEffect after mount. This is a Vite
  // client SPA (no SSR), so the real goal here is simply to avoid a
  // flash of stale seed data and to keep localStorage/IDB access out
  // of the module-evaluation path. `hydrated` flips true once the
  // hydration effect finishes, which gates the auto-deduction + alert
  // effects so they operate on the user's REAL saved state (not the
  // seed defaults) — see H8 in the audit fix.
  const [medications, setMedications] = useState<Medication[]>(INITIAL_MEDICATIONS);
  const [logs, setLogs] = useState<ConsumptionLog[]>(INITIAL_LOGS);
  const [pharmacySettings, setPharmacySettings] =
    useState<PharmacySettings>(DEFAULT_PHARMACY_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  // First-run detection: when no saved meds exist in localStorage, the
  // seed data is a demo — don't fire auto-deductions, notifications, or
  // alarms for it. Set during hydration.
  const [isFirstRun, setIsFirstRun] = useState(false);

  const [filter, setFilter] = useState<'all' | 'alerts' | 'sufficient'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsModalMode, setSettingsModalMode] = useState<'all' | 'pharmacy'>('all');
  const [activeOrderItems, setActiveOrderItems] = useState<OrderItem[] | undefined>();
  const [editingMedication, setEditingMedication] = useState<Medication | null>(null);
  const [refillMedication, setRefillMedication] = useState<Medication | null>(null);

  // Same deterministic-first pattern: defaults loaded on mount.
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(false);
  // Critical-stock alerts (the urgent "حرج" notifications) — default
  // true so the user gets alerts by default on first install (the
  // headline feature). The toggle in AppHeader lets them turn it off.
  // The critical THRESHOLD is derived per-medication from
  // warningThresholdDays via getCriticalThresholdDays() — not a fixed
  // pill count (see C3 in the audit fix).
  const [criticalStockAlertsEnabled, setCriticalStockAlertsEnabled] = useState<boolean>(true);
  const [globalAutoDeductEnabled, setGlobalAutoDeductEnabled] = useState<boolean>(true);
  // Global custom sound — shared across all notifications (not
  // per-medication). The user uploads it from the AppHeader. It is
  // persisted in IndexedDB (not localStorage) because the base64 data
  // URL can be up to ~2.7 MB and would blow the localStorage quota —
  // see C4 in the audit fix.
  const [globalCustomSound, setGlobalCustomSound] = useState<CustomSoundFile | null>(null);

  const [isPhoneFrame, setIsPhoneFrame] = useState(true);
  // Font size toggle: 'normal' (default) or 'large'. Persisted to
  // localStorage and applied as a CSS class on the phone-frame.
  const [fontScale, setFontScale] = useState<'normal' | 'large'>('normal');
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  const { alarmingMedication, dismissAlarm, snoozeAlarm, testAlarm } = useDoseReminders({
    medications,
    soundEnabled,
    notificationsEnabled,
    // #24: pass hydrated so the polling effect doesn't fire phantom
    // alarms for seed medications before the user's real saved state
    // is loaded from localStorage/IndexedDB.
    hydrated: hydrated && !isFirstRun,
    globalCustomSound,
  });

  // #21: register a back-button handler that closes the top modal
  // instead of exiting the app. The handler returns true (modal was
  // closed, don't exit) or false (no modal open, exit). Re-registers
  // whenever any modal state changes so the handler always reads the
  // latest values.
  useEffect(() => {
    registerBackButtonHandler(() => {
      if (alarmingMedication) { dismissAlarm(); return true; }
      if (isAddModalOpen) { setIsAddModalOpen(false); setEditingMedication(null); return true; }
      if (refillMedication) { setRefillMedication(null); return true; }
      if (isSettingsModalOpen) { setIsSettingsModalOpen(false); return true; }
      return false;
    });
  }, [alarmingMedication, isAddModalOpen, refillMedication, isSettingsModalOpen, dismissAlarm]);

  // #38: on unmount, remove all Capacitor listeners so duplicate
  // listeners don't accumulate across HMR re-initializations.
  useEffect(() => {
    return () => {
      cleanupNativeListeners().catch(() => {});
    };
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Hydration: load persisted state from localStorage / IndexedDB
  // AFTER mount. This effect runs only on the client and replaces
  // the default values with whatever the user previously saved.
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    // M11: run schema migration first so any future key-shape changes
    // are applied before we read the (possibly migrated) keys.
    migrateSchema();

    try {
      const savedMeds = localStorage.getItem(STORAGE_MEDS_KEY);
      if (savedMeds) {
        const parsed = JSON.parse(savedMeds);
        // #15: accept an empty array here (don't gate on
        // parsed.length > 0). Otherwise, when the user deletes all
        // medications, the persisted "[]" is ignored on next launch,
        // the seed INITIAL_MEDICATIONS stays in state, and the
        // hydration-gated persistence effect overwrites the user's
        // "[]" with the seed meds — the empty-meds state is lost.
        if (Array.isArray(parsed)) setMedications(parsed);
      } else {
        // First-ever open: no saved meds. The seed data is a demo —
        // flag it so the auto-deduction + alert + reminder effects
        // don't fire ghost notifications/alarms for seed meds.
        setIsFirstRun(true);
      }
    } catch (err) {
      console.warn('[App] failed to load saved medications:', err);
    }

    try {
      const savedLogs = localStorage.getItem(STORAGE_LOGS_KEY);
      if (savedLogs) {
        const parsed = JSON.parse(savedLogs);
        if (Array.isArray(parsed)) setLogs(parsed);
      }
    } catch (err) {
      console.warn('[App] failed to load saved logs:', err);
    }

    try {
      const savedPharmacy = localStorage.getItem(STORAGE_PHARMACY_KEY);
      if (savedPharmacy) {
        const parsed = JSON.parse(savedPharmacy);
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
      }
    } catch (err) {
      console.warn('[App] failed to load saved pharmacy settings:', err);
    }

    try {
      setSoundEnabled(localStorage.getItem(SOUND_KEY) !== 'false');
    } catch (err) {
      console.warn('[App] failed to load sound flag:', err);
    }

    try {
      const savedFont = localStorage.getItem(FONT_SIZE_KEY);
      if (savedFont === 'large') setFontScale('large');
    } catch (err) {
      console.warn('[App] failed to load font size:', err);
    }

    try {
      // Critical-stock alerts default to true. We persist as
      // 'true'/'false' string. Default true means: if the user has
      // never touched the toggle, they get the alerts.
      const stored = localStorage.getItem(CRITICAL_STOCK_ALERTS_KEY);
      setCriticalStockAlertsEnabled(stored !== 'false');
    } catch (err) {
      console.warn('[App] failed to load critical-alerts flag:', err);
    }

    try {
      const storedAutoDeduct = localStorage.getItem(STORAGE_GLOBAL_AUTO_DEDUCT_KEY);
      setGlobalAutoDeductEnabled(storedAutoDeduct !== 'false');
    } catch (err) {
      console.warn('[App] failed to load auto-deduct flag:', err);
    }

    // Global custom sound is persisted in IndexedDB (not localStorage)
    // because its base64 data URL can be several MB — see C4. The load
    // is async; we set `hydrated` after it resolves so the
    // auto-deduction + alert effects wait for the real saved state.
    loadGlobalCustomSound()
      .then((file) => {
        if (file && file.dataUrl) {
          setGlobalCustomSound(file);
        }
      })
      .catch((err) => {
        console.warn('[App] loadGlobalCustomSound failed:', err);
      })
      .finally(() => {
        setHydrated(true);
      });

    // Initialize the in-app notifications flag from a SYNC snapshot
    // of the current permission state. On web this is
    // Notification.permission; on native (Capacitor), the permission
    // state is async-only, so we default to 'default' and let the
    // async getNotificationPermission() call below update it.
    //
    // Note: this is intentionally a sync snapshot — the React state
    // needs to be set during the first render so the bell icon
    // shows the correct initial state. A second pass below (the
    // async getNotificationPermission) updates it once the native
    // permission state is known.
    setNotificationsEnabled(
      getNotificationPermissionSync() === 'granted'
    );

    // Initialize the Capacitor native bridge (status bar color, back
    // button). No-op on the web — see src/native.ts.
    initNativeBridge().catch((err) => {
      console.warn('[App] Native bridge init failed:', err);
    });

    // On native (Capacitor), get the real async permission state
    // and update the in-app flag if it differs from the sync
    // snapshot above.
    getNotificationPermission()
      .then((perm) => {
        setNotificationsEnabled(perm === 'granted');
      })
      .catch((err) => {
        console.warn('[App] getNotificationPermission failed:', err);
      });

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
    if (getNotificationPermissionSync() === 'default') {
      requestNotificationPermission()
        .then((granted) => {
          setNotificationsEnabled(granted);
        })
        .catch((err) => {
          console.warn('[App] Auto-request notification permission failed:', err);
        });
    }
  }, []);

  // showToast is defined with useCallback BEFORE the persistence
  // effects so those effects can surface write failures (M1: previously
  // every catch was empty and a quota-exceeded write silently dropped
  // data). Stabilizing it via useCallback also keeps the persistence
  // effects from re-subscribing on every render.
  const showToast = useCallback((message: string) => {
    const id = Date.now();
    setToast({ id, message });
    setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 4000);
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Persistence effects (M1): each write goes through persistJson /
  // persistString, which log the failure and return a short Arabic
  // error message. We surface that message via a toast so the user
  // knows their data wasn't saved (instead of silently dropping it).
  // A per-effect "already warned" ref avoids spamming toasts on every
  // re-render that re-attempts the same failing write.
  // ─────────────────────────────────────────────────────────────
  const warnedMedsRef = useRef(false);
  useEffect(() => {
    // H8-adjacent: do NOT persist until hydration has loaded the saved
    // state. Otherwise on the first mount we'd write the seed
    // INITIAL_MEDICATIONS to localStorage, briefly overwriting the
    // user's real data before the hydration effect's setMedications
    // re-render arrives — a crash in that window would lose data.
    if (!hydrated) return;
    const err = persistJson(STORAGE_MEDS_KEY, medications);
    if (err && !warnedMedsRef.current) {
      warnedMedsRef.current = true;
      showToast(`${err} — قد لا يتم حفظ تعديلاتك على الأدوية.`);
    } else if (!err) {
      warnedMedsRef.current = false;
    }
  }, [medications, showToast, hydrated]);

  const warnedLogsRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    const err = persistJson(STORAGE_LOGS_KEY, logs);
    if (err && !warnedLogsRef.current) {
      warnedLogsRef.current = true;
      showToast(`${err} — قد لا يتم حفظ سجل الاستهلاك.`);
    } else if (!err) {
      warnedLogsRef.current = false;
    }
  }, [logs, showToast, hydrated]);

  // M12: pharmacy settings are written via a 400ms debounce so rapid
  // toggles of the 30/60-day duration (which calls onUpdateSettings on
  // every click) don't fire a localStorage write per click. The last
  // value within the debounce window wins.
  const warnedPharmacyRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    const handle = window.setTimeout(() => {
      const err = persistJson(STORAGE_PHARMACY_KEY, pharmacySettings);
      if (err && !warnedPharmacyRef.current) {
        warnedPharmacyRef.current = true;
        showToast(`${err} — قد لا يتم حفظ إعدادات الصيدلية.`);
      } else if (!err) {
        warnedPharmacyRef.current = false;
      }
    }, 400);
    return () => window.clearTimeout(handle);
  }, [pharmacySettings, showToast, hydrated]);

  const warnedSoundRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    const err = persistString(SOUND_KEY, String(soundEnabled));
    if (err && !warnedSoundRef.current) {
      warnedSoundRef.current = true;
      showToast(`${err} — قد لا يتم حفظ تفضيل الصوت.`);
    } else if (!err) {
      warnedSoundRef.current = false;
    }
  }, [soundEnabled, showToast, hydrated]);

  // Persist font size preference so it survives app relaunch, and toggle root scaling.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('font-scale-large', fontScale === 'large');
    }
    if (!hydrated) return;
    const err = persistString(FONT_SIZE_KEY, fontScale);
    if (err) {
      console.warn('[App] failed to persist font size:', err);
    }
  }, [fontScale, hydrated]);

  const warnedCriticalRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    const err = persistString(CRITICAL_STOCK_ALERTS_KEY, String(criticalStockAlertsEnabled));
    if (err && !warnedCriticalRef.current) {
      warnedCriticalRef.current = true;
      showToast(`${err} — قد لا يتم حفظ تفضيل تنبيه النفاذ الحرج.`);
    } else if (!err) {
      warnedCriticalRef.current = false;
    }
  }, [criticalStockAlertsEnabled, showToast, hydrated]);

  const warnedAutoDeductRef = useRef(false);
  useEffect(() => {
    if (!hydrated) return;
    const err = persistString(STORAGE_GLOBAL_AUTO_DEDUCT_KEY, String(globalAutoDeductEnabled));
    if (err && !warnedAutoDeductRef.current) {
      warnedAutoDeductRef.current = true;
      showToast(`${err} — قد لا يتم حفظ تفضيل الخصم التلقائي.`);
    } else if (!err) {
      warnedAutoDeductRef.current = false;
    }
  }, [globalAutoDeductEnabled, showToast, hydrated]);

  // Persist global custom sound to IndexedDB (C4: storing the base64
  // data URL in localStorage risked blowing the ~5 MB quota and silently
  // dropping other state; IndexedDB has a much larger quota).
  // Gated on `hydrated` so we don't `deleteGlobalCustomSound()` on mount
  // (when globalCustomSound is null) BEFORE the async loadGlobalCustomSound
  // in the hydration effect has had a chance to read the saved value.
  useEffect(() => {
    if (!hydrated) return;
    if (globalCustomSound) {
      saveGlobalCustomSound(globalCustomSound).catch((err) => {
        console.warn('[App] saveGlobalCustomSound failed:', err);
      });
    } else {
      deleteGlobalCustomSound().catch((err) => {
        console.warn('[App] deleteGlobalCustomSound failed:', err);
      });
    }
  }, [globalCustomSound, hydrated]);

  // ─────────────────────────────────────────────────────────────
  // Auto-deduction: runs ONCE per session, AFTER hydration completes
  // (so it operates on the user's REAL saved medications, not the
  // seed defaults). This fixes H8, where the old `[]`-dep effect ran
  // during the mount pass with stale (default) data and silently
  // skipped deductions for returning users.
  //
  // This effect only deducts + logs. Alerting is handled by a
  // separate effect below that watches `medications` + the permission
  // flags, so it fires with the correct `notificationsEnabled` value
  // (which is resolved async after mount).
  // ─────────────────────────────────────────────────────────────
  const deductedRef = useRef(false);
  useEffect(() => {
    if (!hydrated || deductedRef.current) return;
    // First-run: don't auto-deduct or fire notifications for seed data.
    if (isFirstRun) {
      deductedRef.current = true;
      return;
    }
    deductedRef.current = true;

    if (!globalAutoDeductEnabled) {
      return;
    }

    const today = getTodayDateString();
    const result = syncAutoDailyDeductions(medications, today);

    if (result.newLogs.length > 0) {
      setMedications(result.updatedMeds);
      setLogs((prev) => [...result.newLogs, ...prev]);
      const totalPills = result.deductedSummary.reduce((sum, item) => sum + item.pillsDeducted, 0);
      showToast(`تم الخصم التلقائي للاستهلاك: خصم ${totalPills} قرص لمرور الأيام.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // ─────────────────────────────────────────────────────────────
  // Alert effect: watches the (post-deduction) medications array and
  // the notification flags, and fires a notification the FIRST time a
  // medication WORSENS — using the per-medication critical threshold
  // DERIVED from warningThresholdDays (C3), and a stable notification
  // id keyed by med.id (H6 — no more collisions between same-named
  // medications).
  //
  // We track the last-alerted status per med in a ref and compare
  // severity ranks (out_of_stock > critical > warning > sufficient).
  // We only fire when the new status is STRICTLY WORSE than the
  // previously-alerted one — so a partial refill that improves a med
  // from critical→warning does NOT fire a spurious "warning" alert.
  // When a med improves to 'sufficient', we clear the tracker so the
  // next crossing alerts again. When notifications are toggled off,
  // we clear the tracker so re-enabling fires for current alertable
  // meds again.
  // ─────────────────────────────────────────────────────────────
  const lastAlertedStatusRef = useRef<Map<string, MedicationStatus>>(new Map());
  useEffect(() => {
    if (!hydrated) return;
    // First-run: don't fire ghost notifications for seed data.
    if (isFirstRun) return;

    // When notifications are off, reset the tracker so the next time
    // they're turned on, current alertable meds fire again.
    if (!notificationsEnabled) {
      lastAlertedStatusRef.current.clear();
      return;
    }

    const tracker = lastAlertedStatusRef.current;
    for (const med of medications) {
      const { status, daysLeft } = calculateMedicationStatus(med);
      // The dynamic balance — what the user actually has right now, not
      // the stale stored snapshot. Used in the notification body text so
      // it stays correct even if the app was closed for many days.
      const effPills = effectiveCurrentPills(med);
      const prev = tracker.get(med.id);

      // Med is healthy → clear its tracker so the next worsening alerts.
      if (status === 'sufficient') {
        tracker.delete(med.id);
        continue;
      }

      // Already alerted for this exact (or a worse) status → don't
      // re-fire. `prev` records the worst status we've already alerted
      // for; if the new status is the same or better, skip.
      if (prev !== undefined && STATUS_RANK[status] <= STATUS_RANK[prev]) {
        // Update the tracker if the status improved (so a later
        // worsening from the new, better baseline fires again).
        if (STATUS_RANK[status] < STATUS_RANK[prev]) {
          tracker.set(med.id, status);
        }
        continue;
      }

      // New med (prev undefined) OR status strictly worsened → fire the
      // appropriate alert(s) for the new status.
      if (status === 'out_of_stock') {
        if (criticalStockAlertsEnabled) {
          sendCriticalStockAlert(med.id, med.name, 0, 0, med.unit || 'قرص');
        }
        // Also send the general low-stock alert so it appears as its
        // own drawer entry (different notification id).
        sendMedicineAlert(med.id, med.name, 0, 0);
      } else if (status === 'critical') {
        if (criticalStockAlertsEnabled) {
          sendCriticalStockAlert(med.id, med.name, daysLeft, effPills, med.unit || 'قرص');
        }
        // Critical is a subset of the warning window — also send the
        // general alert (separate drawer entry, less urgent wording).
        sendMedicineAlert(med.id, med.name, daysLeft, effPills);
      } else if (status === 'warning') {
        sendMedicineAlert(med.id, med.name, daysLeft, effPills);
      }

      tracker.set(med.id, status);
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled, hydrated, isFirstRun]);

  // ─────────────────────────────────────────────────────────────
  // One-shot critical-alarm scheduling — extracted into a hook for
  // testability + race protection. See useCriticalAlarmScheduler.ts
  // for the full doc (boot persistence, reschedule triggers, stale-
  // async generation guard, edge cases). The hook handles:
  //   - scheduling a one-shot alarm at each med's projected critical
  //     date
  //   - cancel + reschedule when any of the 6 trigger fields change
  //   - cancel for deleted meds
  //   - cancel all when the user opts out of either flag
  //   - per-med generation guard so an older async effect cannot
  //     recreate a stale alarm after a newer state or after deletion
  // ─────────────────────────────────────────────────────────────
  useCriticalAlarmScheduler({
    medications,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
  });

  const handleRestoreDose = (medicationId: string, reason: string) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    const today = getTodayDateString();
    const restoredAmount = med.dailyDose;
    // Settle the snapshot at the current effective balance (deduct the
    // elapsed days at the OLD dose), then add the restored dose on top.
    // This makes the restore semantically: "skip today's dose, add it
    // back to the live balance" — which is what the user expects.
    const effPills = effectiveCurrentPills(med, today);
    const newSnapshot = effPills + restoredAmount;
    setMedications((prev) =>
      prev.map((m) =>
        m.id === medicationId
          ? {
              ...m,
              currentPills: newSnapshot,
              lastSyncDate: today,
            }
          : m
      )
    );
    setLogs((prev) => [
      {
        id: 'restore-' + Date.now(),
        medicationId: med.id,
        medicationName: med.name,
        type: 'skipped_day',
        amount: restoredAmount,
        date: today,
        timestamp: new Date().toISOString(),
        description: `استرجاع جرعة (${reason}) (+${restoredAmount} ${med.unit})`,
      },
      ...prev,
    ]);
    if (soundEnabled) playSuccessChime();
  };

  const handleConfirmRefill = (medicationId: string, addedPills: number) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    const today = getTodayDateString();
    // Settle the snapshot at the current effective balance (deduct the
    // elapsed days at the OLD dose), then add the refill amount on top.
    // This way the new snapshot starts projecting from today with the
    // fresh supply — clean, no retroactive consumption of the new pills.
    const effPills = effectiveCurrentPills(med, today);
    const newSnapshot = effPills + addedPills;
    setMedications((prev) =>
      prev.map((m) =>
        m.id === medicationId
          ? {
              ...m,
              currentPills: newSnapshot,
              lastSyncDate: today,
            }
          : m
      )
    );
    setLogs((prev) => [
      {
        id: 'refill-' + Date.now(),
        medicationId: med.id,
        medicationName: med.name,
        type: 'refill',
        amount: addedPills,
        date: today,
        timestamp: new Date().toISOString(),
        description: `شراء وتعبئة مخزون (+${addedPills} ${med.unit})`,
      },
      ...prev,
    ]);
    if (soundEnabled) playSuccessChime();
  };

  const handleToggleAutoDeduct = (medicationId: string) => {
    // Settle the snapshot at the live effective balance before the new
    // auto-deduction state takes effect. This handles BOTH transitions:
    //   - true → false: deduct the elapsed period at the OLD active
    //     rate, then flip OFF. Without this, the displayed balance
    //     would jump back up to the stale snapshot value the moment
    //     the flag flips (because effectiveCurrentPills returns
    //     currentPills unchanged when autoDeduct is false), undoing
    //     all consumption since lastSyncDate.
    //   - false → true: keep currentPills unchanged (the user wasn't
    //     consuming during the frozen period), bump lastSyncDate=today
    //     so the new auto-deduction starts fresh from today. Without
    //     the lastSyncDate bump, enabling auto-deduction would
    //     retroactively deduct daysPassed*dailyDose for the frozen
    //     period.
    //
    // IMPORTANT: the settle calculation + all side effects (setLogs,
    // showToast) must run OUTSIDE the setMedications updater. React
    // updater functions must be pure — React may invoke them more than
    // once in Strict Mode (which would create duplicate settlement
    // logs and duplicate toasts). We compute the settle result once
    // here, fire the side effects once, and pass the result into the
    // updater as a closure value (which the updater only READS).
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;

    const today = getTodayDateString();
    // `autoDeductEnabled` defaults to true when undefined, so the
    // effective current state is `!== false`. To toggle OFF from the
    // default-true (undefined) state we must set false explicitly.
    // #27: the previous `!m.autoDeductEnabled` formulation no-oped
    // for the undefined case because `!undefined === true` — the
    // first click on a med with autoDeductEnabled===undefined kept
    // it ON. `med.autoDeductEnabled === false` correctly maps:
    //   undefined → false (turn OFF the default-true)
    //   true      → false (turn OFF)
    //   false     → true  (turn ON)
    const newState = med.autoDeductEnabled === false;
    const { updatedMed, log: settleLog } = settleAutoDeductToggle(
      med,
      newState,
      today
    );

    // Side effect 1: persist the settlement consumption log (if any
    // pills were deducted during the true→false transition). Runs
    // OUTSIDE the medications updater so Strict Mode double-invoke
    // can't duplicate the log.
    if (settleLog) {
      setLogs((prevLogs) => [settleLog, ...prevLogs]);
    }
    // Side effect 2: toast the toggle result. Also outside the updater.
    showToast(
      newState ? `تم تفعيل الخصم التلقائي لـ "${med.name}"` : `تم إيقاف الخصم التلقائي مؤقتاً لـ "${med.name}"`
    );

    // Updater: pure — only reads `updatedMed` from the closure and
    // returns the new medications array. No side effects inside.
    setMedications((prev) =>
      prev.map((m) => (m.id === medicationId ? updatedMed : m))
    );
  };

  const handleToggleGlobalAutoDeduct = () => {
    const next = !globalAutoDeductEnabled;
    setGlobalAutoDeductEnabled(next);
    const today = getTodayDateString();

    if (!next) {
      // Turning OFF: settle all medications at their current effective balance
      let totalDeducted = 0;
      const newLogs: ConsumptionLog[] = [];
      const settledMeds = medications.map((med) => {
        const { updatedMed, log } = settleAutoDeductToggle(med, false, today);
        if (log) {
          newLogs.push(log);
          totalDeducted += Math.abs(log.amount);
        }
        return updatedMed;
      });

      setMedications(settledMeds);
      if (newLogs.length > 0) {
        setLogs((prev) => [...newLogs, ...prev]);
      }

      showToast(
        totalDeducted > 0
          ? `تم إيقاف الخصم التلقائي لجميع الأدوية (تمت تسوية خصم ${totalDeducted} قرص للأيام السابقة).`
          : 'تم إيقاف الخصم التلقائي لجميع الأدوية ⏸️ (المخزون ثابت الآن)'
      );
    } else {
      // Turning ON: reactivate all medications, resetting lastSyncDate to today
      const reactivatedMeds = medications.map((med) => {
        const { updatedMed } = settleAutoDeductToggle(med, true, today);
        return updatedMed;
      });

      setMedications(reactivatedMeds);
      showToast('تم تفعيل الخصم التلقائي اليومي لجميع الأدوية ⚡');
    }

    if (soundEnabled) playSuccessChime();
  };

  const handleSaveMedication = (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => {
    if (editId) {
      // Settlement: if the user is changing the dailyDose, we MUST NOT
      // just apply the new dose going forward from lastSyncDate — that
      // would retroactively apply the new rate to all days that
      // actually consumed at the OLD rate. Instead, settle the period
      // [lastSyncDate, today] at the OLD dose first, then apply the
      // new dose from today forward.
      const existing = medications.find((m) => m.id === editId);
      const today = getTodayDateString();
      const isDoseChanging =
        existing && medData.dailyDose !== existing.dailyDose;
      if (existing && isDoseChanging) {
        const { updatedMed, log } = settleDoseChange(
          existing,
          medData.dailyDose,
          today
        );
        // Merge the settled med with the rest of the form data (name,
        // category, reminder settings, etc.) — but keep the settled
        // currentPills + lastSyncDate (don't let the form overwrite them).
        setMedications((prev) =>
          prev.map((m) =>
            m.id === editId
              ? {
                  ...m,
                  ...medData,
                  // Override medData.currentPills + lastSyncDate with
                  // the settled values. medData.currentPills in edit
                  // mode equals initialData.currentPills (the input is
                  // disabled), but settleDoseChange may have reduced it
                  // for the elapsed days at the old dose — we MUST use
                  // that reduced value, not the form's disabled-input
                  // echo of the pre-edit snapshot.
                  currentPills: updatedMed.currentPills,
                  lastSyncDate: updatedMed.lastSyncDate,
                }
              : m
          )
        );
        // Log the settlement consumption if any pills were deducted.
        if (log) {
          setLogs((prev) => [log, ...prev]);
        }
      } else {
        // No dose change (or new med): just save normally.
        setMedications((prev) => prev.map((m) => (m.id === editId ? { ...m, ...medData } : m)));
      }
      showToast(
        medData.reminderEnabled
          ? `تم حفظ "${medData.name}" مع تذكير يومي الساعة ${medData.reminderTime}`
          : `تم تعديل بيانات "${medData.name}" بنجاح`
      );
    } else {
      const newMed: Medication = {
        ...medData,
        id: 'med-' + Date.now(),
        createdAt: new Date().toISOString(),
        lastSyncDate: getTodayDateString(),
        autoDeductEnabled: globalAutoDeductEnabled,
      };
      setMedications((prev) => [newMed, ...prev]);
      showToast(
        newMed.reminderEnabled
          ? `تمت إضافة "${newMed.name}" مع تنبيه الساعة ${newMed.reminderTime}`
          : `تمت إضافة "${newMed.name}"، وسيحسب استهلاكه تلقائياً`
      );
    }
    if (soundEnabled) playSuccessChime();
    setEditingMedication(null);
  };

  const handleSavePharmacySettings = (newSettings: PharmacySettings) => {
    setPharmacySettings(newSettings);
    showToast(
      settingsModalMode === 'pharmacy'
        ? 'تم حفظ إعدادات الصيدلية بنجاح!'
        : 'تم حفظ الإعدادات بنجاح!'
    );
    if (soundEnabled) playSuccessChime();
  };

  const handleSavePharmacy = (pharmacy: Pharmacy) => {
    setPharmacySettings((prev) => {
      const pharmacies = prev.pharmacies || [];
      const exists = pharmacies.some((item) => item.id === pharmacy.id);
      return {
        ...prev,
        pharmacies: exists ? pharmacies.map((item) => item.id === pharmacy.id ? pharmacy : item) : [...pharmacies, pharmacy],
        selectedPharmacyId: prev.selectedPharmacyId || pharmacy.id,
      };
    });
  };

  const handleDeletePharmacy = (id: string) => {
    setPharmacySettings((prev) => {
      const pharmacies = (prev.pharmacies || []).filter((item) => item.id !== id);
      return { ...prev, pharmacies, selectedPharmacyId: prev.selectedPharmacyId === id ? pharmacies[0]?.id || '' : prev.selectedPharmacyId };
    });
    showToast('تم حذف الصيدلية.');
  };

  const handleDeleteMedication = (id: string) => {
    const med = medications.find((m) => m.id === id);
    if (!med) return;
    setMedications((prev) => prev.filter((m) => m.id !== id));
    showToast(`تم حذف "${med.name}" من القائمة`);
  };

  const handleToggleNotifications = async () => {
    if (!notificationsEnabled) {
      let pushAllowed = false;
      try {
        const currentPerm = await getNotificationPermission();
        if (currentPerm === 'granted') {
          pushAllowed = true;
        } else if (currentPerm === 'default') {
          pushAllowed = await requestNotificationPermission();
        }
      } catch (err) {
        console.warn('[App] Notification permission error:', err);
      }

      // Always turn on in-app notifications so in-app chimes,
      // dose alarm dialogs, and stock depletion tracking function properly.
      setNotificationsEnabled(true);
      if (soundEnabled) {
        playSuccessChime();
      }

      if (pushAllowed) {
        sendTestAlertNotification(globalCustomSound).catch(() => void 0);
        showToast('تم تفعيل إشعارات الهاتف والتنبيهات الصوتية بنجاح 🔔 (تم إرسال إشعار تجريبي)');
      } else {
        showToast('تم تفعيل التنبيهات والأصوات داخل التطبيق بنجاح 🔔 (لإشعارات الهاتف بالخلفية اسمح بها في إعدادات المتصفح)');
      }
    } else {
      setNotificationsEnabled(false);
      showToast('تم إيقاف التنبيهات داخل التطبيق 🔕');
    }
  };

  const handleSendTestNotification = async () => {
    if (soundEnabled) {
      playSuccessChime();
    }
    try {
      await sendTestAlertNotification(globalCustomSound);
      showToast('تم إرسال إشعار تجريبي وتشغيل صوت التنبيه بنجاح! 🔔');
    } catch (err) {
      console.warn('[App] Failed to send test alert notification:', err);
      showToast('تم تشغيل صوت التنبيه التجريبي بنجاح! 🔔');
    }
  };


  const handleTakeDoseFromAlarm = (med: Medication) => {
    // Consume-pill feature: actually subtract the dose from the balance,
    // mark the med as consumed today (blocks auto-deduction), and log it.
    const today = getTodayDateString();
    // Use the dynamic balance for the dose-amount calculation: if the
    // app was closed for many days, the effective balance may already
    // be 0, in which case the consume action is a no-op.
    const effPills = effectiveCurrentPills(med, today);
    const doseAmount = Math.min(med.dailyDose, effPills);
    if (doseAmount > 0) {
      // The settle delta: deduct from the stored snapshot, not from
      // effPills. If the snapshot is 60 but effPills is 42 (18 days
      // elapsed), we want to deduct doseAmount AND reset lastSyncDate
      // to today — effectively re-settling the snapshot at the live
      // balance minus the consumed dose. The cleanest way is to
      // subtract doseAmount from effPills and set that as the new
      // snapshot, with lastSyncDate = today.
      const newSnapshot = Math.max(0, effPills - doseAmount);
      setMedications((prev) =>
        prev.map((m) =>
          m.id === med.id
            ? {
                ...m,
                currentPills: newSnapshot,
                lastConsumedDate: today,
                lastSyncDate: today,
              }
            : m
        )
      );
      setLogs((prev) => [
        {
          id: 'consume-' + Date.now(),
          medicationId: med.id,
          medicationName: med.name,
          type: 'dose_taken',
          amount: -doseAmount,
          date: today,
          timestamp: new Date().toISOString(),
          description: `تناول جرعة من التنبيه (-${doseAmount} ${med.unit})`,
        },
        ...prev,
      ]);
    }
    dismissAlarm();
    showToast(`تم تسجيل جرعة "${med.name}" (-${doseAmount} ${med.unit}). لن يتم الخصم التلقائي اليوم.`);
    if (soundEnabled) playSuccessChime();
  };

  const handleSnoozeFromAlarm = (med: Medication) => {
    snoozeAlarm(10);
    showToast(`تم تأجيل تنبيه "${med.name}" عشر دقائق`);
  };

  // Consume-pill feature: manually consume a dose from the card.
  // Subtracts dailyDose from currentPills, marks the med as consumed
  // today (blocks auto-deduction for today), creates a dose_taken log.
  const handleConsumeDose = (medicationId: string) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    const today = getTodayDateString();
    // If already consumed today, don't double-consume.
    if (med.lastConsumedDate === today) {
      showToast(`تم تناول جرعة "${med.name}" اليوم بالفعل.`);
      return;
    }
    // Use the dynamic balance for the dose-amount calculation: if the
    // app was closed for many days, the effective balance may already
    // be 0, in which case the consume action is a no-op.
    const effPills = effectiveCurrentPills(med, today);
    const doseAmount = Math.min(med.dailyDose, effPills);
    if (doseAmount <= 0) return;
    // Re-settle the snapshot at (effPills - doseAmount), with
    // lastSyncDate = today. This matches the behavior in
    // handleTakeDoseFromAlarm.
    const newSnapshot = Math.max(0, effPills - doseAmount);
    setMedications((prev) =>
      prev.map((m) =>
        m.id === medicationId
          ? {
              ...m,
              currentPills: newSnapshot,
              lastConsumedDate: today,
              lastSyncDate: today,
            }
          : m
      )
    );
    setLogs((prev) => [
      {
        id: 'consume-' + Date.now(),
        medicationId: med.id,
        medicationName: med.name,
        type: 'dose_taken',
        amount: -doseAmount,
        date: today,
        timestamp: new Date().toISOString(),
        description: `تناول جرعة يدوياً (-${doseAmount} ${med.unit})`,
      },
      ...prev,
    ]);
    showToast(`تم تناول جرعة "${med.name}" (-${doseAmount} ${med.unit}). لن يتم الخصم التلقائي اليوم.`);
    if (soundEnabled) playSuccessChime();
  };

  const filteredMedications = useMemo(() => {
    return medications.filter((med) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = med.name.toLowerCase().includes(q);
        const matchCat = med.category?.toLowerCase().includes(q) || false;
        const matchNotes = med.notes?.toLowerCase().includes(q) || false;
        if (!matchName && !matchCat && !matchNotes) return false;
      }
      const { status } = calculateMedicationStatus(med);
      if (filter === 'alerts') return status === 'out_of_stock' || status === 'critical' || status === 'warning';
      if (filter === 'sufficient') return status === 'sufficient';
      return true;
    });
  }, [medications, searchQuery, filter]);

  const alertsCount = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    }).length;
  }, [medications]);

  const sufficientCount = useMemo(() => {
    return medications.filter((m) => calculateMedicationStatus(m).status === 'sufficient').length;
  }, [medications]);

  const totalPillsCount = useMemo(() => {
    // Sum the DYNAMIC balances, not the stored snapshots, so the count
    // shown in the UI header / total reflects the projected live state.
    return medications.reduce((acc, m) => acc + effectiveCurrentPills(m), 0);
  }, [medications]);

  const openAdd = () => {
    setEditingMedication(null);
    setIsAddModalOpen(true);
  };

  return (
    <div
      dir="rtl"
      className="min-h-screen bg-slate-900 text-slate-800 flex items-center justify-center p-0 md:p-6 font-sans selection:bg-teal-200"
    >
      <div
        className={`w-full bg-slate-100 flex flex-col transition-all duration-300 relative ${
          isPhoneFrame
            ? 'max-w-md h-[100dvh] md:h-[860px] md:max-h-[92vh] md:rounded-[42px] md:border-8 md:border-slate-800 md:shadow-2xl overflow-hidden'
            : 'max-w-4xl min-h-screen md:min-h-[90vh] md:rounded-3xl md:border md:border-slate-300 md:shadow-xl overflow-hidden'
        } ${fontScale === 'large' ? 'font-scale-large' : ''}`}
      >
        {/* NOTE: AndroidStatusBar (a fake "time + wifi + battery" bar
            that was previously rendered here) was removed because the
            real OS status bar already shows that info on actual
            Android devices — the in-app fake version was redundant
            and ate vertical space. The Capacitor StatusBar plugin
            (configured in capacitor.config.ts + initialized in
            src/native.ts) sets the OS status bar color to teal-800
            and overlays the WebView when running as an APK, so the
            app's content starts directly under AppHeader. */}
        <AppHeader
          activeTab={activeTab}
          filter={filter}
          onFilterChange={setFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          alertsCount={alertsCount}
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          criticalStockAlertsEnabled={criticalStockAlertsEnabled}
          onToggleCriticalStockAlerts={() => {
            const next = !criticalStockAlertsEnabled;
            setCriticalStockAlertsEnabled(next);
            if (next && !notificationsEnabled) {
              setNotificationsEnabled(true);
            }
            if (soundEnabled) playSuccessChime();
            showToast(
              next
                ? 'تم تفعيل تنبيهات النفاذ الحرج ⚠️ (إشعار فوري عند اقتراب نفاد أي دواء أو نفاذه — حسب إعداد كل دواء)'
                : 'تم إيقاف تنبيهات النفاذ الحرج'
            );
          }}
          isPhoneFrame={isPhoneFrame}
          onTogglePhoneFrame={() => setIsPhoneFrame(!isPhoneFrame)}
          onOpenSettings={() => {
            setSettingsModalMode('all');
            setIsSettingsModalOpen(true);
          }}
          fontScale={fontScale}
          onToggleFontScale={() => {
            const next = fontScale === 'normal' ? 'large' : 'normal';
            setFontScale(next);
            showToast(next === 'large' ? 'تم تكبير حجم الخط' : 'تم إرجاع حجم الخط للطبيعي');
          }}
        />

        <main className="flex-1 overflow-y-auto pb-24 relative">
          {activeTab === 'stock' && (
            <div>
              {filter === 'all' && (
                <div>
                  <div
                    className={`mx-4 mt-3 p-3 rounded-2xl flex items-center justify-between text-xs shadow-xs border transition-colors ${
                      globalAutoDeductEnabled
                        ? 'bg-teal-50 border-teal-200/90'
                        : 'bg-amber-50/80 border-amber-200/90'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-7 h-7 rounded-xl text-white flex items-center justify-center shrink-0 ${
                          globalAutoDeductEnabled ? 'bg-teal-600' : 'bg-amber-600'
                        }`}
                      >
                        {globalAutoDeductEnabled ? (
                          <Zap className="w-4 h-4" />
                        ) : (
                          <ZapOff className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900 block text-[11px]">
                            {globalAutoDeductEnabled
                              ? 'الخصم التلقائي اليومي نشط'
                              : 'الخصم التلقائي اليومي متوقف'}
                          </span>
                          <span
                            className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                              globalAutoDeductEnabled
                                ? 'bg-teal-100 text-teal-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {globalAutoDeductEnabled ? 'مفعّل' : 'متوقف'}
                          </span>
                        </div>
                        <p
                          className={`text-[10px] ${
                            globalAutoDeductEnabled ? 'text-teal-800' : 'text-amber-800'
                          }`}
                        >
                          {globalAutoDeductEnabled
                            ? 'يتم احتساب الجرعات بمرور الأيام لتحديث رصيدك وموعد النفاذ بدقة.'
                            : 'تم إيقاف خصم الجرعات تلقائياً. المخزون الحالي ثابت.'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => {
                          setSettingsModalMode('all');
                          setIsSettingsModalOpen(true);
                        }}
                        className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition ${
                          globalAutoDeductEnabled
                            ? 'text-teal-700 hover:text-teal-900 bg-teal-100/70'
                            : 'text-amber-800 hover:text-amber-950 bg-amber-200/70'
                        }`}
                      >
                        الإعدادات
                      </button>
                      <button
                        onClick={() => setActiveTab('logs')}
                        className="text-[11px] font-bold text-teal-700 hover:text-teal-900 bg-teal-100/70 px-2.5 py-1 rounded-lg"
                      >
                        عرض السجل
                      </button>
                    </div>
                  </div>
                  <div className="mx-4 mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
                      <span className="text-[10px] text-slate-500 block">إجمالي الأدوية</span>
                      <span className="text-base font-extrabold font-mono text-slate-800">{medications.length}</span>
                    </div>
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
                      <span className="text-[10px] text-slate-500 block">المخزون الكلي</span>
                      <span className="text-base font-extrabold font-mono text-teal-800">{totalPillsCount}</span>
                    </div>
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
                      <span className="text-[10px] text-slate-500 block">حالة المخزون</span>
                      <div className="flex items-center justify-center gap-1.5 mt-0.5 text-[11px]">
                        <span className="text-emerald-700 font-bold font-mono">{sufficientCount} آمن</span>
                        <span className="text-slate-300">•</span>
                        <span className={`font-mono font-bold ${alertsCount > 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                          {alertsCount} ناقص
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {filter === 'alerts' && (
                <LowStockBanner medications={medications} onNavigateToShopping={() => setActiveTab('shopping')} />
              )}

              <div className="p-4 space-y-3">
                {filteredMedications.length === 0 ? (
                  <EmptyState
                    hasSearch={Boolean(searchQuery.trim())}
                    onClearSearch={() => setSearchQuery('')}
                    filter={filter}
                    onFilterChange={setFilter}
                    onOpenAddModal={openAdd}
                  />
                ) : (
                  filteredMedications.map((med) => (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      viewFilter={filter}
                      onOpenRefill={setRefillMedication}
                      onEdit={(m) => {
                        setEditingMedication(m);
                        setIsAddModalOpen(true);
                      }}
                      onDelete={handleDeleteMedication}
                      onToggleAutoDeduct={handleToggleAutoDeduct}
                      onNavigateToShopping={() => setActiveTab('shopping')}
                      onTriggerAlarm={testAlarm}
                      onConsumeDose={handleConsumeDose}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'shopping' && (
            <PharmacyShoppingView
              medications={medications}
              settings={pharmacySettings}
              onUpdateSettings={setPharmacySettings}
              onOpenSettings={(orderItems) => {
                setActiveOrderItems(orderItems);
                setSettingsModalMode('pharmacy');
                setIsSettingsModalOpen(true);
              }}
              onConfirmRefill={handleConfirmRefill}
              showToast={showToast}
            />
          )}

          {activeTab === 'pharmacies' && (
            <PharmacyManagementView
              pharmacies={pharmacySettings.pharmacies || []}
              onSave={handleSavePharmacy}
              onDelete={handleDeletePharmacy}
              showToast={showToast}
            />
          )}

          {activeTab === 'logs' && (
            <ConsumptionLogView
              medications={medications}
              logs={logs}
              onRestoreDose={handleRestoreDose}
              showToast={showToast}
            />
          )}
        </main>

        {activeTab === 'stock' && <AndroidFab onOpenAddModal={openAdd} />}
        <AndroidBottomNav activeTab={activeTab} onTabChange={setActiveTab} alertsCount={alertsCount} />

        {toast && (
          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 max-w-[90%] px-4 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-2xl shadow-xl text-center">
            {toast.message}
          </div>
        )}

        {/* M10: service-worker "new version available" banner. Renders
            only in production (the SW is registered only in prod —
            see src/main.tsx) and only when a new SW is actually waiting. */}
        <UpdatePrompt />
      </div>

      <AddMedicationModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingMedication(null);
        }}
        onSave={handleSaveMedication}
        initialData={editingMedication}
      />
      <RefillModal
        medication={refillMedication}
        isOpen={Boolean(refillMedication)}
        onClose={() => setRefillMedication(null)}
        onConfirmRefill={handleConfirmRefill}
      />
      <AppSettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => {
          setIsSettingsModalOpen(false);
          setActiveOrderItems(undefined);
        }}
        mode={settingsModalMode}
        settings={pharmacySettings}
        medications={medications}
        activeOrderItems={activeOrderItems}
        onSaveSettings={handleSavePharmacySettings}
        soundEnabled={soundEnabled}
        onToggleSound={() => setSoundEnabled(!soundEnabled)}
        globalCustomSound={globalCustomSound}
        notificationsEnabled={notificationsEnabled}
        onToggleNotifications={handleToggleNotifications}
        criticalStockAlertsEnabled={criticalStockAlertsEnabled}
        autoDeductEnabled={globalAutoDeductEnabled}
        onToggleAutoDeduct={handleToggleGlobalAutoDeduct}
        onToggleCriticalStockAlerts={() => {
          const next = !criticalStockAlertsEnabled;
          setCriticalStockAlertsEnabled(next);
          if (next && !notificationsEnabled) {
            setNotificationsEnabled(true);
          }
          if (soundEnabled) playSuccessChime();
          showToast(
            next
              ? 'تم تفعيل تنبيهات النفاذ الحرج ⚠️ (إشعار فوري عند اقتراب نفاد أي دواء أو نفاذه — حسب إعداد كل دواء)'
              : 'تم إيقاف تنبيهات النفاذ الحرج'
          );
        }}
        onSendTestNotification={handleSendTestNotification}
        onSetGlobalCustomSound={(file) => {
          setGlobalCustomSound(file);
          if (file) {
            import('./utils/sound')
              .then((m) => m.playNotificationSound('custom', file))
              .catch(() => void 0);
            showToast(`تم تعيين "${file.fileName}" كصوت مخصص لكل الأدوية`);
          } else {
            showToast('تم إزالة الصوت المخصص');
          }
        }}
      />
      <DoseAlarmModal
        isOpen={Boolean(alarmingMedication)}
        medication={alarmingMedication}
        onTakeDose={handleTakeDoseFromAlarm}
        onSnooze={handleSnoozeFromAlarm}
        onDismiss={dismissAlarm}
      />
    </div>
  );
}
