import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { MedicationHistoryModal } from './components/MedicationHistoryModal';
import { AutoDeductPromptModal } from './components/AutoDeductPromptModal';
import { UpdatePrompt } from './components/UpdatePrompt';
import { Toggle } from './components/ui/Toggle';
import { MedicationSortControl } from './components/MedicationSortControl';
import type { MedicationSortField, MedicationSortDirection } from './utils/medicationSorting';
import {
  requestNotificationPermission,
  getNotificationPermission,
} from './utils/notifications/notificationPermissions';
import { sendTestAlertNotification } from './utils/notifications/doseReminderNotifications';
import { openExactAlarmSettings, type ExactAlarmPermission } from './utils/exactAlarm';
import { OrderItem } from './utils/whatsapp';
import { playSuccessChime } from './utils/sound';
import { useDoseReminders } from './hooks/useDoseReminders';
import { useCriticalAlarmScheduler } from './hooks/useCriticalAlarmScheduler';
import { useDoseReminderScheduler } from './hooks/useDoseReminderScheduler';
import { useAutoDeductionScheduler } from './hooks/useAutoDeductionScheduler';
import { useExactAutoDeductionReconciliation } from './hooks/useExactAutoDeductionReconciliation';
import { useMidnightTick } from './hooks/useMidnightTick';
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
  STORAGE_PHARMACY_KEY,
  SOUND_KEY,
  NOTIFICATIONS_KEY,
  FONT_SIZE_KEY,
  CRITICAL_STOCK_ALERTS_KEY,
  COMPACT_VIEW_KEY,
} from './constants/storageKeys';
import { TOAST_DURATION_MS, PHARMACY_PERSIST_DEBOUNCE_MS } from './utils/time';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>(getInitialTab);

  // Start from empty in-memory state and hydrate persisted application data
  // after mount. Runtime schedulers and alerts are gated on `hydrated` so
  // they never act on pre-hydration state.
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
  /** Stable ref so Android Back can invoke the same first-run decision path. */
  const handleConfirmAutoDeductPromptRef = useRef<(enable: boolean) => void>(() => {});

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
  // false so stock alerts do not show active on first start regardless of state.
  // The toggle in AppHeader lets the user turn it on.
  const [criticalStockAlertsEnabled, setCriticalStockAlertsEnabled] = useState<boolean>(false);
  // Exact-alarm permission state (Android 12+). null means the native
  // permission check has not completed yet. When false, dose-reminder
  // scheduling is BLOCKED — inexact alarms are unacceptable for medication
  // reminders. The user grants this via Android settings (the plugin's
  // The native ExactAlarmRuntime bridge opens the exact-alarm settings screen. On web /
  // Android < 12 this is always true.
  const [exactAlarmPermission, setExactAlarmPermission] = useState<ExactAlarmPermission | null>(null);
  // Bumped on every app resume (appStateChange) so the critical-alarm
  // scheduler re-runs and reconciles its matching claims against the
  // platform's actual pending notifications — the user may have just
  // granted/denied SCHEDULE_EXACT_ALARM, or the native alarm may have
  // been dropped while the app was backgrounded. See
  // useCriticalAlarmScheduler's RECONCILIATION section.
  const [criticalAlarmResumeTick, setCriticalAlarmResumeTick] = useState(0);
  // Bumped on every app resume (appStateChange) so the dose-reminder
  // scheduler re-runs its CONSUMPTION SUPPRESSION: an already-consumed
  // dose occurrence (per-dose markers for medId + doseId on today) can
  // never produce today's reminder, even if a previous suppression
  // attempt failed while the process was backgrounded/killed.
  // Medication-level lastConsumedDate is not the source of truth here.
  // Mirrors criticalAlarmResumeTick.
  const [doseAlarmResumeTick, setDoseAlarmResumeTick] = useState(0);
  // Bumped on EVERY app state transition (foreground ↔ background) so the
  // dose-reminder scheduler re-runs and re-arms all pending reminders on
  // the correct channel: silent foreground channel when the app is open,
  // system-sound background channel when the app is backgrounded/killed.
  const [doseLifecycleTick, setDoseLifecycleTick] = useState(0);

  const [globalAutoDeductEnabled, setGlobalAutoDeductEnabled] = useState<boolean>(true);
  // Translate business policy into the neutral Dose Reminder capability.
  const allowManualTakeActionByMedicationId = useMemo(() => {
    const result = new Map<string, boolean>();
    for (const medication of medications) {
      result.set(medication.id, medication.autoDeductEnabled === false);
    }
    return result;
  }, [medications]);


  const [isPhoneFrame, setIsPhoneFrame] = useState(true);
  // Font size toggle: 'normal' (default) or 'large'. Persisted to
  // localStorage and applied as a CSS class on the phone-frame.
  const [fontScale, setFontScale] = useState<'normal' | 'large'>('normal');
  // Compact card view for "All Medications" tab
  const [isCompactView, setIsCompactView] = useState<boolean>(false);
  const [medicationSortField, setMedicationSortField] = useState<MedicationSortField>('name');
  const [medicationSortDirection, setMedicationSortDirection] = useState<MedicationSortDirection>('asc');
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  const { alarmingMedication, alarmingDoseId, openAlarm, dismissAlarm, snoozeAlarm, testAlarm } = useDoseReminders({
    medications,
    allowManualTakeActionByMedicationId,
  });

  // Multi-dose manual consume / restore requires explicit dose selection.
  const [selectDoseMed, setSelectDoseMed] = useState<Medication | null>(null);
  const [selectDoseMode, setSelectDoseMode] = useState<'take' | 'restore' | 'manage'>('take');
  const [historyMedication, setHistoryMedication] = useState<Medication | null>(null);

  // Register a back-button handler that closes the top modal
  // instead of exiting the app. The handler returns true (modal was
  // closed, don't exit) or false (no modal open, exit). Re-registers
  // whenever any modal state changes so the handler always reads the
  // latest values.
  useEffect(() => {
    registerBackButtonHandler(() => {
      // Top-most interactive overlay first.
      if (alarmingMedication) { dismissAlarm(); return true; }
      // Explicit dose selector must dismiss on Android Back
      // without exiting the app.
      if (selectDoseMed) {
        setSelectDoseMed(null);
        setSelectDoseMode('take');
        return true;
      }
      if (historyMedication) {
        setHistoryMedication(null);
        return true;
      }
      if (isAutoDeductPromptOpen) {
        // Same durable decision path as choosing "لا" — never mark prompted
        // without a successful global Auto policy mutation.
        handleConfirmAutoDeductPromptRef.current(false);
        return true;
      }
      if (isAddModalOpen) { setIsAddModalOpen(false); setEditingMedication(null); return true; }
      if (refillMedication) { setRefillMedication(null); return true; }
      if (isSettingsModalOpen) { setIsSettingsModalOpen(false); return true; }
      return false;
    });
  }, [alarmingMedication, selectDoseMed, historyMedication, isAutoDeductPromptOpen, isAddModalOpen, refillMedication, isSettingsModalOpen, dismissAlarm]);

  // Remove native listeners on unmount so duplicate handlers cannot accumulate.
  // Clear any pending toast auto-dismiss timer.
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
    setExactAlarmPermission,
    setGlobalAutoDeductEnabled,
    setFontScale,
    setIsCompactView,
  });

  // Track the toast auto-dismiss timer so it can be cleared on
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
  // Medication stock + consumption logs are persisted ONLY by the durable
  // stock mutation gate. Keeping a React-state persistence effect here would
  // create a second writer that could replay an older React snapshot after a
  // gated mutation and overwrite the committed durable state.
  //
  // Hydration remains responsible for the initial read; every post-hydration
  // mutation path (add/edit/delete/take/restore/refill/undo/exact)
  // commits through the same gate.

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

  // Global auto-deduct is part of the durable stock mutation state. It is
  // intentionally NOT persisted from React state; toggles commit the master
  // switch together with medications/logs through the stock gate.

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
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    showToast,
  });

  // ─────────────────────────────────────────────────────────────
  // Foreground critical-stock fallback: for each medication, during one
  // continuous Critical/Out-of-Stock episode, sends AT MOST ONE critical
  // notification. The persistent notification claim
  // (utils/criticalNotificationClaims.ts) is the business source of
  // truth: claimed=true ⇒ quiet, claimed=false ⇒ send once.
  //
  // Kept in a focused hook so claim/delivery behavior is independently testable.
  useStockAlerts({
    medications,
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
  //   - cancel all when the user opts out of critical-stock alerts (re-opening
  //     claims whose future alarm was cancelled before firing)
  //   - per-med operation queue + generation guard so a stale async
  //     operation can never overwrite newer claim state
  // ─────────────────────────────────────────────────────────────
  useCriticalAlarmScheduler({
    medications,
    criticalStockAlertsEnabled,
    hydrated,
    isFirstRun,
    exactAlarmPermission,
    resumeTick: criticalAlarmResumeTick,
  });

  // ─────────────────────────────────────────────────────────────
  // NATIVE recurring daily dose-reminder scheduling.
  //
  // Schedules one recurring native notification per explicit doseSchedule
  // row (AlarmManager-backed), gated by reminderEnabled. Each occurrence
  // is identified by medId + doseId; reminderTime/dailyDose are not
  // occurrence identity sources. Fires daily at the schedule-row time even
  // when the app is killed, the device is in Doze, or the user never opens
  // the app.
  //
  // Complements event-driven in-app dose reminders while foregrounded.
  // See useDoseReminderScheduler.ts for race-protection + boot persistence.
  // ─────────────────────────────────────────────────────────────
  useDoseReminderScheduler({
    medications,
    allowManualTakeActionByMedicationId,
    notificationsEnabled,
    hydrated,
    isFirstRun,
    exactAlarmPermission,
    resumeTick: doseAlarmResumeTick,
    lifecycleTick: doseLifecycleTick,
  });

  // Local-midnight rollover while the app stays open: today/tomorrow are
  // computed from the wall clock at effect-run time, so the desired-state
  // scheduler and the exact-auto reconciliation must re-run once at the
  // calendar-day boundary (not only on resume).
  const autoDeductMidnightTick = useMidnightTick();

  // Exact-time auto-deduction alarms are independent of notifications.
  // Records durable native FIRED events only — no stock mutation here.
  useAutoDeductionScheduler({
    medications,
    globalAutoDeductEnabled,
    hydrated,
    isFirstRun,
    exactAlarmPermission,
    resumeTick: doseAlarmResumeTick,
    midnightTick: autoDeductMidnightTick,
  });

  // Reconcile native FIRED exact auto-deduction events into JS stock.
  // Runs once after hydration/on resume for recovery, then immediately on the
  // native exact-auto FIRED event; serialized; crash-safe persist-then-mark.
  useExactAutoDeductionReconciliation({
    setMedications,
    setLogs,
    setGlobalAutoDeductEnabled,
    globalAutoDeductEnabled,
    hydrated,
    isFirstRun,
    resumeTick: doseAlarmResumeTick,
    midnightTick: autoDeductMidnightTick,
  });

  const {
    handleConfirmRefill,
    handleUndoRefill,
    handleToggleAutoDeduct,
    handleToggleGlobalAutoDeduct,
    handleConfirmAutoDeductPrompt,
    handleSaveMedication,
    handleDeleteMedication,
    handleTakeDoseFromAlarm,
    handleTakeDoseFromAlarmById,
    handleSnoozeFromAlarm,
    handleConsumeDose,
    handleCardRestoreDose,
    handleSelectDoseFromModal,
    handleToggleCriticalStockAlerts,
    handleToggleMedicationReminder,
    handleToggleMedicationCriticalStockAlerts,
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
    setIsFirstRun,
    setNotificationsEnabled,
    setCriticalStockAlertsEnabled,
    setSelectDoseMed,
    setSelectDoseMode,
    setEditingMedication,
    showToast,
    dismissAlarm,
    snoozeAlarm,
  });

  handleConfirmAutoDeductPromptRef.current = handleConfirmAutoDeductPrompt;


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
    allowManualTakeActionByMedicationId,
    handleTakeDoseFromAlarmById,
    openAlarm,
    soundEnabled,
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
    setExactAlarmPermission,
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

  // Consume-pill feature: manually consume a selected explicit dose from the card.
  // Subtracts that dose's schedule amount from currentPills; marks the dose occurrence as consumed

  const {
    medicationsWithStatus,
    lastRefillByMed,
    filteredMedications,
    alertsCount,
    sufficientCount,
  } = useDerivedMedications(medications, logs, filter, searchQuery, medicationSortField, medicationSortDirection);

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
          globalAutoDeductEnabled={globalAutoDeductEnabled}
          onToggleGlobalAutoDeduct={handleToggleGlobalAutoDeduct}
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
                  <div className="mx-4 mt-3 flex items-center justify-between gap-2 bg-white px-3 py-2 rounded-2xl border border-slate-200/80 shadow-2xs">
                    <div className="flex items-center min-w-0">
                      <MedicationSortControl
                        field={medicationSortField}
                        direction={medicationSortDirection}
                        onFieldChange={setMedicationSortField}
                        onDirectionChange={setMedicationSortDirection}
                      />
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs font-medium text-slate-600">
                        {isCompactView ? 'العرض المختصر' : 'العرض الطبيعي'}
                      </span>
                      <Toggle
                        id="card-view-mode-toggle"
                        size="sm"
                        checked={isCompactView}
                        onChange={() => {
                          const next = !isCompactView;
                          setIsCompactView(next);
                          showToast(
                            next ? 'تم تفعيل العرض المختصر' : 'تم إرجاع العرض الطبيعي'
                          );
                          if (soundEnabled) playSuccessChime();
                        }}
                        label="تبديل العرض بين المختصر والعرض الطبيعي"
                      />
                    </div>
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
                      logs={logs}
                      onOpenRefill={setRefillMedication}
                      onEdit={(m) => {
                        setEditingMedication(m);
                        setIsAddModalOpen(true);
                      }}
                      onDelete={handleDeleteMedication}
                      onToggleAutoDeduct={handleToggleAutoDeduct}
                      onToggleMedicationReminder={handleToggleMedicationReminder}
                      onToggleMedicationCriticalStockAlerts={handleToggleMedicationCriticalStockAlerts}
                      onNavigateToShopping={() => setActiveTab('shopping')}
                      onTriggerAlarm={testAlarm}
                      onConsumeDose={handleConsumeDose}
                      onRestoreDose={handleCardRestoreDose}
                      onOpenHistory={(m) => setHistoryMedication(m)}
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
              showToast={showToast}
            />
          )}
        </main>

        {activeTab === 'stock' && <AndroidFab onClick={openAdd} />}
        <AndroidBottomNav activeTab={activeTab} onTabChange={setActiveTab} alertsCount={alertsCount} />

        {toast && (
          <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[60] max-w-[90%] px-4 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-2xl shadow-xl text-center">
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
        defaultAutoDeductEnabled={globalAutoDeductEnabled}
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
        exactAlarmPermission={exactAlarmPermission}
        onOpenExactAlarmSettings={handleOpenExactAlarmSettings}
        showToast={showToast}
        onApplyAppPreferences={async (prefs) => {
          // Final prefs from Settings drafts — apply independently.
          // Do NOT use handleToggleNotifications / handleToggleCriticalStockAlerts:
          // those read committed state and can force notifications back ON when
          // critical is enabled (or invert based on stale closures).
          if (prefs.soundEnabled !== soundEnabled) {
            setSoundEnabled(prefs.soundEnabled);
          }
          if (prefs.autoDeductEnabled !== globalAutoDeductEnabled) {
            handleToggleGlobalAutoDeduct();
          }
          if (prefs.notificationsEnabled !== notificationsEnabled) {
            setNotificationsEnabled(prefs.notificationsEnabled);
            showToast(
              prefs.notificationsEnabled
                ? TOAST_MESSAGES.notificationsOn
                : TOAST_MESSAGES.notificationsOff
            );
          }
          if (prefs.criticalStockAlertsEnabled !== criticalStockAlertsEnabled) {
            setCriticalStockAlertsEnabled(prefs.criticalStockAlertsEnabled);
            showToast(
              prefs.criticalStockAlertsEnabled
                ? TOAST_MESSAGES.criticalAlertsOn
                : TOAST_MESSAGES.criticalAlertsOff
            );
          }
          // Confirm feedback only when the committed preference leaves sound on.
          if (prefs.soundEnabled) {
            playSuccessChime();
          }
        }}
      />
      <DoseAlarmModal
        isOpen={Boolean(alarmingMedication) && Boolean(alarmingDoseId)}
        medication={alarmingMedication}
        doseId={alarmingDoseId ?? ''}
        onTakeDose={handleTakeDoseFromAlarm}
        onSnooze={handleSnoozeFromAlarm}
        onDismiss={dismissAlarm}
      />
      <SelectDoseModal
        isOpen={Boolean(selectDoseMed)}
        medication={
          // Prefer live medications[] so Manage mode always re-derives dose rows
          // from the latest Take/Restore result (not a stale open-time snapshot).
          selectDoseMed
            ? (medications.find((m) => m.id === selectDoseMed.id) ?? selectDoseMed)
            : null
        }
        mode={selectDoseMode}
        logs={logs}
        onSelect={handleSelectDoseFromModal}
        onRestore={handleCardRestoreDose}
        onClose={() => {
          setSelectDoseMed(null);
          setSelectDoseMode('take');
        }}
      />
      <MedicationHistoryModal
        isOpen={Boolean(historyMedication)}
        medication={
          historyMedication
            ? (medications.find((m) => m.id === historyMedication.id) ?? historyMedication)
            : null
        }
        logs={logs}
        onClose={() => setHistoryMedication(null)}
      />
      <AutoDeductPromptModal
        isOpen={isAutoDeductPromptOpen}
        onConfirm={handleConfirmAutoDeductPrompt}
      />
    </div>
  );
}
