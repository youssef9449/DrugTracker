import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Medication,
  ConsumptionLog,
  PharmacySettings,
  DEFAULT_PHARMACY_SETTINGS,
} from './types';
// NOTE: the app previously seeded 3 demo medications + 2 consumption
// logs on a fresh install (src/data/initialData.ts). That seed data
// showed up the moment the app was installed, which the user did not
// want — a fresh install should start with an empty inventory and let
// the user add their own medications. The seed functions are kept in
// initialData.ts only for the existing regression test that asserts
// they DON'T appear on a fresh run; they are no longer used as the
// initial state here.
import { AndroidBottomNav, ActiveTab } from './components/AndroidBottomNav';
import { AppHeader } from './components/AppHeader';
import { LowStockBanner } from './components/LowStockBanner';
import { MedicationCard } from './components/MedicationCard';
import { PharmacyShoppingView } from './components/PharmacyShoppingView';
import { PharmacyManagementView } from './components/PharmacyManagementView';
import { UserDataManagementView } from './components/UserDataManagementView';
import { ConsumptionLogView } from './components/ConsumptionLogView';
import { AddMedicationModal } from './components/AddMedicationModal';
import { RefillModal } from './components/RefillModal';
import { AppSettingsModal } from './components/AppSettingsModal';
import { AndroidFab } from './components/AndroidFab';
import { EmptyState } from './components/EmptyState';
import { DoseAlarmModal } from './components/DoseAlarmModal';
import { SelectDoseModal } from './components/SelectDoseModal';
import { AutoDeductPromptModal } from './components/AutoDeductPromptModal';
import { UpdatePrompt } from './components/UpdatePrompt';
import { Toggle } from './components/ui/Toggle';
import {
  requestNotificationPermission,
  sendTestAlertNotification,
  getNotificationPermission,
  openExactAlarmSettings,
} from './utils/notifications';
import { OrderItem } from './utils/whatsapp';
import { playSuccessChime } from './utils/sound';
import { useDoseReminders } from './hooks/useDoseReminders';
import { useCriticalAlarmScheduler } from './hooks/useCriticalAlarmScheduler';
import { useDoseReminderScheduler } from './hooks/useDoseReminderScheduler';
import { useAutoDeductionScheduler } from './hooks/useAutoDeductionScheduler';
import { useExactAutoDeductionReconciliation } from './hooks/useExactAutoDeductionReconciliation';
import { usePersistentEffect } from './hooks/usePersistentEffect';
import { useStockAlerts } from './hooks/useStockAlerts';
import { useAppHydration } from './hooks/useAppHydration';
import { useStartupAutoDeduction } from './hooks/useStartupAutoDeduction';
import { useMedicationHandlers } from './hooks/useMedicationHandlers';
import { usePharmacyUserHandlers } from './hooks/usePharmacyUserHandlers';
import { useNativeActionHandlers } from './hooks/useNativeActionHandlers';
import { useDerivedMedications } from './hooks/useDerivedMedications';
import {
  registerBackButtonHandler,
  cleanupNativeListeners,
} from './native';
import { getInitialTab } from './lib/initialTab';
import { persist } from './utils/storage';
import { TOAST_MESSAGES, PERSIST_FAILURE_MESSAGES } from './constants/uiStrings';
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
} from './constants/storageKeys';
import { TOAST_DURATION_MS, PHARMACY_PERSIST_DEBOUNCE_MS } from './utils/time';
import { Zap, ZapOff } from 'lucide-react';

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
  //
  // A fresh install starts with an EMPTY inventory — no seed/demo
  // medications or logs. The user adds their own medications via the
  // "إضافة دواء" button. (Previously the app seeded 3 demo meds + 2
  // logs from src/data/initialData.ts on first run; that behavior was
  // removed because users saw demo drugs they never entered.) Once the
  // user saves anything, state is persisted to localStorage and this
  // initial value is irrelevant (the hydration effect overwrites it
  // with the saved value before any side-effect runs).
  const [medications, setMedications] = useState<Medication[]>([]);
  const [logs, setLogs] = useState<ConsumptionLog[]>([]);
  const [pharmacySettings, setPharmacySettings] =
    useState<PharmacySettings>(DEFAULT_PHARMACY_SETTINGS);
  const [hydrated, setHydrated] = useState(false);
  // First-run detection: when no saved meds exist in localStorage, the
  // seed data is a demo — don't fire auto-deductions, notifications, or
  // alarms for it. Set during hydration.
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [isAutoDeductPromptOpen, setIsAutoDeductPromptOpen] = useState(false);

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
  // Exact-alarm permission state (Android 12+). null means the native
  // permission check has not completed yet. When false, dose-reminder
  // scheduling is BLOCKED — inexact alarms are unacceptable for medication
  // reminders. The user grants this via Android settings (the plugin's
  // changeExactNotificationSetting opens the settings screen). On web /
  // Android < 12 this is always true.
  const [exactAlarmEnabled, setExactAlarmEnabled] = useState<boolean | null>(null);
  // Bumped on every app resume (appStateChange) so the critical-alarm
  // scheduler re-runs and reconciles its matching claims against the
  // platform's actual pending notifications — the user may have just
  // granted/denied SCHEDULE_EXACT_ALARM, or the native alarm may have
  // been dropped while the app was backgrounded. See
  // useCriticalAlarmScheduler's RECONCILIATION section.
  const [criticalAlarmResumeTick, setCriticalAlarmResumeTick] = useState(0);
  // Bumped on every app resume (appStateChange) so the dose-reminder
  // scheduler re-runs its CONSUMPTION SUPPRESSION: an already-consumed
  // dose (lastConsumedDate === today) can never produce today's
  // reminder, even if a previous suppression attempt failed while the
  // process was backgrounded/killed. Mirrors criticalAlarmResumeTick.
  const [doseAlarmResumeTick, setDoseAlarmResumeTick] = useState(0);
  // Bumped on EVERY app state transition (foreground ↔ background) so the
  // dose-reminder scheduler re-runs and re-arms all pending reminders on
  // the correct channel: silent foreground channel when the app is open,
  // system-sound background channel when the app is backgrounded/killed.
  const [doseLifecycleTick, setDoseLifecycleTick] = useState(0);
  const [globalAutoDeductEnabled, setGlobalAutoDeductEnabled] = useState<boolean>(true);

  const [isPhoneFrame, setIsPhoneFrame] = useState(true);
  // Font size toggle: 'normal' (default) or 'large'. Persisted to
  // localStorage and applied as a CSS class on the phone-frame.
  const [fontScale, setFontScale] = useState<'normal' | 'large'>('normal');
  // Compact card view for "All Medications" tab
  const [isCompactView, setIsCompactView] = useState<boolean>(false);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  const { alarmingMedication, alarmingDoseId, openAlarm, dismissAlarm, snoozeAlarm, testAlarm } = useDoseReminders({
    medications,
    globalAutoDeductEnabled,
  });

  // Phase 3A: multi-dose manual consume / restore requires explicit dose selection.
  const [selectDoseMed, setSelectDoseMed] = useState<Medication | null>(null);
  const [selectDoseMode, setSelectDoseMode] = useState<'take' | 'restore' | 'manage'>('take');

  // #21: register a back-button handler that closes the top modal
  // instead of exiting the app. The handler returns true (modal was
  // closed, don't exit) or false (no modal open, exit). Re-registers
  // whenever any modal state changes so the handler always reads the
  // latest values.
  useEffect(() => {
    registerBackButtonHandler(() => {
      // Top-most interactive overlay first.
      if (alarmingMedication) { dismissAlarm(); return true; }
      // Phase 3A: explicit dose selector must dismiss on Android Back
      // without exiting the app.
      if (selectDoseMed) {
        setSelectDoseMed(null);
        setSelectDoseMode('take');
        return true;
      }
      if (isAutoDeductPromptOpen) {
        setIsAutoDeductPromptOpen(false);
        persist(STORAGE_AUTO_DEDUCT_PROMPTED_KEY, 'true', { json: false });
        return true;
      }
      if (isAddModalOpen) { setIsAddModalOpen(false); setEditingMedication(null); return true; }
      if (refillMedication) { setRefillMedication(null); return true; }
      if (isSettingsModalOpen) { setIsSettingsModalOpen(false); return true; }
      return false;
    });
  }, [alarmingMedication, selectDoseMed, isAutoDeductPromptOpen, isAddModalOpen, refillMedication, isSettingsModalOpen, dismissAlarm]);

  // #38: on unmount, remove all Capacitor listeners so duplicate
  // listeners don't accumulate across HMR re-initializations. Also
  // #113: clear any pending toast auto-dismiss timer.
  useEffect(() => {
    return () => {
      cleanupNativeListeners()?.catch?.(() => {});
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  useAppHydration({
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
  });

  // #113: track the toast auto-dismiss timer so it can be cleared on
  // unmount (prevents a setToast-after-unmount warning / leak).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // showToast is defined with useCallback BEFORE the persistence
  // effects so those effects can surface write failures (M1: previously
  // every catch was empty and a quota-exceeded write silently dropped
  // data). Stabilizing it via useCallback also keeps the persistence
  // effects from re-subscribing on every render.
  const showToast = useCallback((message: string) => {
    const id = Date.now();
    setToast({ id, message });
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
      toastTimerRef.current = null;
    }, TOAST_DURATION_MS);
  }, []);

  // ─────────────────────────────────────────────────────────────
  // Persistence effects (M1): each write goes through the
  // usePersistentEffect hook (utils/storage.ts + hooks/usePersistentEffect.ts),
  // which surfaces quota failures via a one-shot toast so the user
  // knows their data wasn't saved (instead of silently dropping it).
  // A per-key "already warned" ref inside the hook avoids spamming
  // toasts on every re-render that re-attempts the same failing write.
  //
  // All effects are gated on `hydrated` so the first mount does NOT
  // write the seed defaults (which would briefly overwrite the user's
  // real data before the hydration effect's setState arrives).
  // ─────────────────────────────────────────────────────────────
  usePersistentEffect({
    storageKey: STORAGE_MEDS_KEY,
    value: medications,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.meds,
    showToast,
  });

  usePersistentEffect({
    storageKey: STORAGE_LOGS_KEY,
    value: logs,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.logs,
    showToast,
  });

  // M12: pharmacy settings are written via a 400ms debounce so rapid
  // toggles of the 30/60-day duration (which calls onUpdateSettings on
  // every click) don't fire a localStorage write per click. The last
  // value within the debounce window wins.
  usePersistentEffect({
    storageKey: STORAGE_PHARMACY_KEY,
    value: pharmacySettings,
    enabled: hydrated,
    debounceMs: PHARMACY_PERSIST_DEBOUNCE_MS,
    failureMessage: PERSIST_FAILURE_MESSAGES.pharmacy,
    showToast,
  });

  usePersistentEffect({
    storageKey: SOUND_KEY,
    value: String(soundEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.sound,
    showToast,
  });

  usePersistentEffect({
    storageKey: NOTIFICATIONS_KEY,
    value: String(notificationsEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.notifications,
    showToast,
  });

  // Persist font size preference so it survives app relaunch, and toggle root scaling.
  // This effect stays inline (not collapsed into usePersistentEffect) because it
  // has a CSS-class side effect that must run BEFORE the hydrated gate (so the
  // class is applied on first render even before hydration completes), and it
  // uses console.warn (not toast) on failure.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('font-scale-large', fontScale === 'large');
    }
    if (!hydrated) return;
    const err = persist(FONT_SIZE_KEY, fontScale, { json: false });
    if (err) {
      console.warn('[App] failed to persist font size:', err);
    }
  }, [fontScale, hydrated]);

  usePersistentEffect({
    storageKey: CRITICAL_STOCK_ALERTS_KEY,
    value: String(criticalStockAlertsEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.critical,
    showToast,
  });

  usePersistentEffect({
    storageKey: STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
    value: String(globalAutoDeductEnabled),
    json: false,
    enabled: hydrated,
    failureMessage: PERSIST_FAILURE_MESSAGES.autoDeduct,
    showToast,
  });

  usePersistentEffect({
    storageKey: COMPACT_VIEW_KEY,
    value: String(isCompactView),
    json: false,
    enabled: hydrated,
    failureMessage: 'تعذر حفظ خيار العرض',
    showToast,
  });


  useStartupAutoDeduction({
    hydrated,
    isFirstRun,
    globalAutoDeductEnabled,
    setMedications,
    setLogs,
    showToast,
  });

  // ─────────────────────────────────────────────────────────────
  // Foreground critical-stock fallback: for each medication, during one
  // continuous Critical/Out-of-Stock episode, sends AT MOST ONE critical
  // notification. The persistent notification claim
  // (utils/criticalNotificationClaims.ts) is the business source of
  // truth: claimed=true ⇒ quiet, claimed=false ⇒ send once.
  //
  // Extracted into useStockAlerts for testability (#87).
  useStockAlerts({
    medications,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
  });

  // ─────────────────────────────────────────────────────────────
  // One-shot critical-alarm scheduling — the native EXECUTOR for the
  // critical notification claim. Extracted into a hook for testability
  // + race protection. See useCriticalAlarmScheduler.ts for the full
  // doc (boot persistence, reschedule triggers, per-med operation
  // queue + generation guard). The hook handles:
  //   - scheduling a one-shot alarm at each sufficient med's projected
  //     critical date and persisting claim=true only after success
  //   - cancel + reschedule when any of the 6 trigger fields change
  //   - cancel for deleted meds
  //   - cancel all when the user opts out of either flag (re-opening
  //     claims whose future alarm was cancelled before firing)
  //   - per-med operation queue + generation guard so a stale async
  //     operation can never overwrite newer claim state
  // ─────────────────────────────────────────────────────────────
  useCriticalAlarmScheduler({
    medications,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
    resumeTick: criticalAlarmResumeTick,
  });

  // ─────────────────────────────────────────────────────────────
  // NATIVE recurring daily dose-reminder scheduling.
  //
  // Schedules a recurring native notification (AlarmManager-backed) for
  // each medication with reminderEnabled + reminderTime, so the dose
  // reminder fires EVERY DAY at the configured time — even when the app
  // is killed, the device is in Doze, or the user never opens the app.
  //
  // This complements the in-app polling in useDoseReminders (which only
  // fires the DoseAlarmModal + chime while the app is in the foreground).
  // See useDoseReminderScheduler.ts for the race-protection + boot-
  // persistence details.
  // ─────────────────────────────────────────────────────────────
  useDoseReminderScheduler({
    medications,
    notificationsEnabled,
    hydrated,
    isFirstRun,
    globalAutoDeductEnabled,
    exactAlarmEnabled,
    resumeTick: doseAlarmResumeTick,
    lifecycleTick: doseLifecycleTick,
  });

  // Phase 2: exact-time auto-deduction alarms (independent of notifications).
  // Records durable native FIRED events only — no stock mutation here.
  useAutoDeductionScheduler({
    medications,
    globalAutoDeductEnabled,
    hydrated,
    isFirstRun,
    exactAlarmEnabled,
    resumeTick: doseAlarmResumeTick,
  });

  // Phase 3: reconcile native FIRED exact auto-deduction events into JS stock.
  // Runs after hydration and on resume; serialized; crash-safe persist-then-mark.
  useExactAutoDeductionReconciliation({
    setMedications,
    setLogs,
    globalAutoDeductEnabled,
    hydrated,
    isFirstRun,
    resumeTick: doseAlarmResumeTick,
  });

  const {
    handleRestoreDose,
    handleConfirmRefill,
    handleUndoRefill,
    handleToggleAutoDeduct,
    handleToggleGlobalAutoDeduct,
    handleConfirmAutoDeductPrompt,
    handleSaveMedication,
    handleDeleteMedication,
    handleTakeDoseFromAlarm,
    handleSnoozeFromAlarm,
    handleConsumeDose,
    handleCardRestoreDose,
    handleSelectDoseFromModal,
    handleToggleCriticalStockAlerts,
  } = useMedicationHandlers({
    medications,
    logs,
    soundEnabled,
    globalAutoDeductEnabled,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    selectDoseMode,
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    setIsAutoDeductPromptOpen,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setSelectDoseMed,
    setSelectDoseMode,
    setEditingMedication,
    showToast,
    dismissAlarm,
    snoozeAlarm,
  });

  const {
    handleSavePharmacySettings,
    handleSavePharmacy,
    handleDeletePharmacy,
    handleSaveUserContact,
    handleDeleteUserContact,
    handleSaveUserAddress,
    handleDeleteUserAddress,
    userContacts,
    userAddresses,
  } = usePharmacyUserHandlers({
    soundEnabled,
    settingsModalMode,
    pharmacySettings,
    setPharmacySettings,
    showToast,
  });

  const handleToggleNotifications = async () => {
    if (!notificationsEnabled) {
      // Turning ON: must obtain notification permission first.
      // If the user denies, do NOT activate the toggle — show a failure
      // message so the user knows the permission wasn't granted.
      let pushAllowed = false;
      try {
        const currentPerm = await getNotificationPermission();
        if (currentPerm === 'granted') {
          pushAllowed = true;
        } else if (currentPerm === 'default') {
          pushAllowed = await requestNotificationPermission();
        }
        // If currentPerm === 'denied', the OS won't re-show the prompt —
        // pushAllowed stays false and the toggle does NOT activate.
      } catch (err) {
        console.warn('[App] Notification permission error:', err);
      }

      if (!pushAllowed) {
        // Permission denied (or error) → do NOT activate the toggle.
        // Show a clear failure message instead of falsely claiming
        // notifications are on.
        showToast(TOAST_MESSAGES.notificationsPermissionDenied);
        return;
      }

      // Permission granted → activate the toggle. No test notification
      // is sent here — the user only asked to toggle notifications on,
      // not to test them. The test notification is available separately
      // in the AppSettingsModal ('تجربة إشعار وتنبيه صوتي الآن').
      setNotificationsEnabled(true);
      if (soundEnabled) {
        playSuccessChime();
      }
      showToast(TOAST_MESSAGES.notificationsOn);
    } else {
      // Turning OFF.
      setNotificationsEnabled(false);
      showToast(TOAST_MESSAGES.notificationsOff);
    }
  };

  const handleSendTestNotification = async () => {
    if (soundEnabled) {
      playSuccessChime();
    }
    try {
      await sendTestAlertNotification();
      showToast(TOAST_MESSAGES.testNotificationSent);
    } catch (err) {
      console.warn('[App] Failed to send test alert notification:', err);
      showToast('تعذّر إرسال الإشعار التجريبي');
    }
  };



  useNativeActionHandlers({
    medications,
    handleTakeDoseFromAlarm,
    openAlarm,
    soundEnabled,
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
    setExactAlarmEnabled,
  });

  const handleOpenExactAlarmSettings = () => {
    openExactAlarmSettings()
      .then((opened) => {
        if (!opened) {
          showToast('إعدادات المنبهات الدقيقة غير متاحة على هذا الجهاز');
        }
      })
      .catch(() => void 0);
  };

  // Consume-pill feature: manually consume a dose from the card.
  // Subtracts dailyDose from currentPills, marks the med as consumed

  const {
    medicationsWithStatus,
    lastRefillByMed,
    filteredMedications,
    alertsCount,
    sufficientCount,
  } = useDerivedMedications(medications, logs, filter, searchQuery);

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
          onToggleCriticalStockAlerts={handleToggleCriticalStockAlerts}
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
                    className={`mx-4 mt-2 px-3 py-2 rounded-xl shadow-2xs border transition-all duration-200 ${
                      globalAutoDeductEnabled
                        ? 'bg-teal-50/90 border-teal-200/90'
                        : 'bg-amber-50/90 border-amber-200/90'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-6 h-6 rounded-lg text-white flex items-center justify-center shrink-0 ${
                          globalAutoDeductEnabled ? 'bg-teal-600' : 'bg-amber-600'
                        }`}
                      >
                        {globalAutoDeductEnabled ? (
                          <Zap className="w-3.5 h-3.5" />
                        ) : (
                          <ZapOff className="w-3.5 h-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-slate-900 block text-[11px] leading-tight">
                            {globalAutoDeductEnabled
                              ? 'الخصم التلقائي نشط'
                              : 'الخصم التلقائي متوقف'}
                          </span>
                          <span
                            className={`text-[9.5px] px-1.5 py-0.2 rounded-full font-bold ${
                              globalAutoDeductEnabled
                                ? 'bg-teal-100 text-teal-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {globalAutoDeductEnabled ? 'مفعّل' : 'متوقف'}
                          </span>
                        </div>
                        <p
                          className={`text-[9.5px] leading-tight mt-0.5 truncate ${
                            globalAutoDeductEnabled ? 'text-teal-800' : 'text-amber-800'
                          }`}
                        >
                          {globalAutoDeductEnabled
                            ? 'يُخصم تلقائياً عند ميعاد كل جرعة.'
                            : 'المخزون ثابت — لا خصم تلقائي.'}
                        </p>
                      </div>
                      <label
                        htmlFor="toggle-global-auto-deduct"
                        className="flex items-center gap-2 cursor-pointer select-none shrink-0"
                      >
                        <Toggle
                          id="toggle-global-auto-deduct"
                          checked={globalAutoDeductEnabled}
                          onChange={handleToggleGlobalAutoDeduct}
                          label="تبديل الخصم التلقائي لجميع الأدوية"
                          size="sm"
                          color="teal"
                        />
                      </label>
                    </div>
                  </div>
                  <div className="mx-4 mt-2 grid grid-cols-2 items-stretch gap-2 text-center text-xs">
                    <div className="bg-white px-2.5 py-1.5 rounded-xl border border-slate-200/80 shadow-2xs h-full flex flex-col justify-center">
                      <span className="text-[9.5px] text-slate-500 block leading-tight">إجمالي الأدوية</span>
                      <div className="h-5 flex items-center justify-center mt-0.5">
                        <span className="text-sm font-bold font-mono text-slate-800 leading-none">{medications.length}</span>
                      </div>
                    </div>
                    <div className="bg-white px-2.5 py-1.5 rounded-xl border border-slate-200/80 shadow-2xs h-full flex flex-col justify-center">
                      <span className="text-[9.5px] text-slate-500 block leading-tight">حالة المخزون</span>
                      <div className="h-5 flex items-center justify-center gap-1.5 mt-0.5 text-[10.5px] leading-none font-mono font-bold">
                        <span className="text-emerald-700">{sufficientCount} آمن</span>
                        <span className="text-slate-300">•</span>
                        <span className={alertsCount > 0 ? 'text-rose-600' : 'text-slate-500'}>
                          {alertsCount} ناقص
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* View mode toggle: compact vs detailed cards */}
                  <div className="mx-4 mt-3 flex items-center justify-between bg-white px-3 py-2 rounded-2xl border border-slate-200/80 shadow-2xs">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-800">قائمة الأدوية</span>
                      {/* Only surface a count here when it adds information the
                          "إجمالي الأدوية" stat card above doesn't already give —
                          i.e. an active search is narrowing the list. Otherwise
                          this badge would just repeat the same total number. */}
                      {searchQuery.trim() && filteredMedications.length !== medications.length && (
                        <span
                          className="text-[11px] px-2 py-0.5 rounded-full bg-teal-100 text-teal-700 font-mono font-bold"
                          aria-label={`${filteredMedications.length} نتيجة بحث من إجمالي ${medications.length}`}
                        >
                          {filteredMedications.length} نتيجة
                        </span>
                      )}
                    </div>

                    <label
                      htmlFor="toggle-compact-view"
                      className="flex items-center gap-2 cursor-pointer select-none"
                    >
                      <span className="text-xs font-medium text-slate-700">
                        {isCompactView ? 'عرض مختصر' : 'عرض تفصيلي'}
                      </span>
                      <Toggle
                        id="toggle-compact-view"
                        checked={isCompactView}
                        onChange={() => {
                          const next = !isCompactView;
                          setIsCompactView(next);
                          showToast(
                            next
                              ? 'تم تفعيل العرض المختصر (شبكة)'
                              : 'تم تفعيل العرض التفصيلي'
                          );
                        }}
                        label="تبديل العرض بين المختصر (شبكة) والتفصيلي"
                        size="sm"
                        color="teal"
                      />
                    </label>
                  </div>
                </div>
              )}

              {filter === 'alerts' && (
                <LowStockBanner medicationsWithStatus={medicationsWithStatus} onNavigateToShopping={() => setActiveTab('shopping')} />
              )}

              <div
                className={
                  isCompactView && filter === 'all'
                    ? 'p-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3'
                    : 'p-3 space-y-2'
                }
              >
                {filteredMedications.length === 0 ? (
                  <div className="col-span-full">
                  <EmptyState
                    hasSearch={Boolean(searchQuery.trim())}
                    onClearSearch={() => setSearchQuery('')}
                    filter={filter}
                    onFilterChange={setFilter}
                    onOpenAddModal={openAdd}
                  />
                  </div>
                ) : (
                  filteredMedications.map((med) => (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      viewFilter={filter}
                      isCompact={isCompactView}
                      globalAutoDeductEnabled={globalAutoDeductEnabled}
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
                      onRestoreDose={handleCardRestoreDose}
                      lastRefillQuantity={(() => {
                        const lastRefill = lastRefillByMed.get(med.id);
                        return lastRefill && lastRefill.amount > 0 ? lastRefill.amount : undefined;
                      })()}
                      onUndoRefill={() => handleUndoRefill(med.id)}
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
              showToast={showToast}
              onOpenUserContactsSettings={() => setActiveTab('user-data')}
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

          {activeTab === 'user-data' && (
            <UserDataManagementView
              contacts={userContacts}
              addresses={userAddresses}
              onSaveContact={handleSaveUserContact}
              onDeleteContact={handleDeleteUserContact}
              onSaveAddress={handleSaveUserAddress}
              onDeleteAddress={handleDeleteUserAddress}
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

        {activeTab === 'stock' && <AndroidFab onClick={openAdd} />}
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
        notificationsEnabled={notificationsEnabled}
        criticalStockAlertsEnabled={criticalStockAlertsEnabled}
        autoDeductEnabled={globalAutoDeductEnabled}
        onSendTestNotification={handleSendTestNotification}
        exactAlarmEnabled={exactAlarmEnabled}
        onOpenExactAlarmSettings={handleOpenExactAlarmSettings}
        onApplyAppPreferences={async (prefs) => {
          // Commit drafts only after Save — closing the modal without Save
          // leaves parent state (and persistence) unchanged.
          if (prefs.soundEnabled !== soundEnabled) {
            setSoundEnabled(prefs.soundEnabled);
          }
          if (prefs.autoDeductEnabled !== globalAutoDeductEnabled) {
            handleToggleGlobalAutoDeduct();
          }
          if (prefs.notificationsEnabled !== notificationsEnabled) {
            if (prefs.notificationsEnabled) {
              await handleToggleNotifications();
            } else {
              setNotificationsEnabled(false);
              showToast(TOAST_MESSAGES.notificationsOff);
            }
          }
          if (prefs.criticalStockAlertsEnabled !== criticalStockAlertsEnabled) {
            await handleToggleCriticalStockAlerts();
          }
          // Confirm feedback only when the committed preference leaves sound on.
          if (prefs.soundEnabled) {
            playSuccessChime();
          }
        }}
      />
      <DoseAlarmModal
        isOpen={Boolean(alarmingMedication)}
        medication={alarmingMedication}
        doseId={alarmingDoseId}
        onTakeDose={handleTakeDoseFromAlarm}
        onSnooze={handleSnoozeFromAlarm}
        onDismiss={dismissAlarm}
      />
      <SelectDoseModal
        isOpen={Boolean(selectDoseMed)}
        medication={selectDoseMed}
        mode={selectDoseMode}
        globalAutoDeductEnabled={globalAutoDeductEnabled}
        onSelect={handleSelectDoseFromModal}
        onRestore={handleCardRestoreDose}
        onClose={() => {
          setSelectDoseMed(null);
          setSelectDoseMode('take');
        }}
      />
      <AutoDeductPromptModal
        isOpen={isAutoDeductPromptOpen}
        onConfirm={handleConfirmAutoDeductPrompt}
      />
    </div>
  );
}
