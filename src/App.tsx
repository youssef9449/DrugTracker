import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Medication,
  ConsumptionLog,
  PharmacySettings,
  DEFAULT_PHARMACY_SETTINGS,
} from './types';
import { AppHeader } from './components/AppHeader';
import { AppTabContent } from './components/AppTabContent';
import { AndroidBottomNav } from './components/AndroidBottomNav';
import type { ActiveTab } from './components/AndroidBottomNav';
import { AddMedicationModal } from './components/AddMedicationModal';
import { RefillModal } from './components/RefillModal';
import { AppSettingsModal } from './components/AppSettingsModal';
import { AndroidFab } from './components/AndroidFab';
import { DoseAlarmModal } from './components/DoseAlarmModal';
import { SelectDoseModal } from './components/SelectDoseModal';
import { MedicationHistoryModal } from './components/MedicationHistoryModal';
import { AutoDeductPromptModal } from './components/AutoDeductPromptModal';
import { UpdatePrompt } from './components/UpdatePrompt';
import { OrderItem } from './utils/whatsapp';
import type { ExactAlarmPermission } from './utils/exactAlarm';
import type { MedicationSortField, MedicationSortDirection } from './utils/medicationSorting';
import { TOAST_DURATION_MS } from './utils/time';

import { useDoseReminders } from './hooks/useDoseReminders';
import { useAppRuntime } from './hooks/useAppRuntime';
import { useAppBackNavigation } from './hooks/useAppBackNavigation';
import { useDerivedMedications } from './hooks/useDerivedMedications';
import {
  cleanupNativeListeners,
} from './native';
import { getInitialTab } from './lib/initialTab';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>(getInitialTab);
  const { navigateToTab, registerBackOverlay } = useAppBackNavigation(activeTab, setActiveTab);

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

  // All Android Back behavior is registered with one authoritative dispatcher.
  // App-owned overlays use explicit priorities; child-owned overlays register
  // through the same dispatcher and therefore never install native listeners.
  useEffect(() => {
    const registrations = [
      alarmingMedication
        ? registerBackOverlay('dose-alarm', dismissAlarm, 100)
        : undefined,
      selectDoseMed
        ? registerBackOverlay('select-dose', () => {
            setSelectDoseMed(null);
            setSelectDoseMode('take');
          }, 90)
        : undefined,
      historyMedication
        ? registerBackOverlay('medication-history', () => setHistoryMedication(null), 80)
        : undefined,
      isAutoDeductPromptOpen
        ? registerBackOverlay('auto-deduct-prompt', () => {
            handleConfirmAutoDeductPromptRef.current(false);
          }, 70)
        : undefined,
      isAddModalOpen
        ? registerBackOverlay('add-medication', () => {
            setIsAddModalOpen(false);
            setEditingMedication(null);
          }, 60)
        : undefined,
      refillMedication
        ? registerBackOverlay('refill', () => setRefillMedication(null), 50)
        : undefined,
      isSettingsModalOpen
        ? registerBackOverlay('settings', () => setIsSettingsModalOpen(false), 40)
        : undefined,
    ];
    return () => registrations.forEach((unregister) => unregister?.());
  }, [
    alarmingMedication,
    dismissAlarm,
    selectDoseMed,
    historyMedication,
    isAutoDeductPromptOpen,
    isAddModalOpen,
    refillMedication,
    isSettingsModalOpen,
    registerBackOverlay,
  ]);

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

  // Track the toast auto-dismiss timer so it can be cleared on
  // unmount (prevents a setToast-after-unmount warning / leak).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // showToast is defined with useCallback BEFORE the persistence
  // effects so those effects can surface write failures (M1: previously
  // every catch was empty and a quota-exceeded write silently dropped
  // data). Stabilizing it via useCallback also keeps the persistence
  // effects from re-subscribing on every render.
  const toastIdRef = useRef(0);

  const showToast = useCallback((message: string) => {
    const id = ++toastIdRef.current;
    setToast({ id, message });
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
      toastTimerRef.current = null;
    }, TOAST_DURATION_MS);
  }, []);

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
    handleSavePharmacySettings,
    handleSavePharmacy,
    handleDeletePharmacy,
    handleSaveUserContact,
    handleDeleteUserContact,
    handleSaveUserAddress,
    handleDeleteUserAddress,
    userContacts,
    userAddresses,
    handleToggleNotifications,
    handleSendTestNotification,
    handleOpenExactAlarmSettings,
  } = useAppRuntime({
    medications,
    logs,
    pharmacySettings,
    hydrated,
    isFirstRun,
    soundEnabled,
    fontScale,
    isCompactView,
    notificationsEnabled,
    criticalStockAlertsEnabled,
    exactAlarmPermission,
    criticalAlarmResumeTick,
    doseAlarmResumeTick,
    doseLifecycleTick,
    globalAutoDeductEnabled,
    selectDoseMode,
    settingsModalMode,
    allowManualTakeActionByMedicationId,
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
    setSelectDoseMed,
    setSelectDoseMode,
    setEditingMedication,
    setDoseLifecycleTick,
    setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
    showToast,
    dismissAlarm,
    snoozeAlarm,
    openAlarm,
  });

  handleConfirmAutoDeductPromptRef.current = handleConfirmAutoDeductPrompt;
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

        <AppTabContent
          activeTab={activeTab}
          filter={filter}
          searchQuery={searchQuery}
          medications={medications}
          logs={logs}
          pharmacySettings={pharmacySettings}
          isCompactView={isCompactView}
          medicationSortField={medicationSortField}
          medicationSortDirection={medicationSortDirection}
          soundEnabled={soundEnabled}
          medicationsWithStatus={medicationsWithStatus}
          filteredMedications={filteredMedications}
          alertsCount={alertsCount}
          sufficientCount={sufficientCount}
          lastRefillByMed={lastRefillByMed}
          userContacts={userContacts}
          userAddresses={userAddresses}
          showToast={showToast}
          setFilter={setFilter}
          setSearchQuery={setSearchQuery}
          setMedicationSortField={setMedicationSortField}
          setMedicationSortDirection={setMedicationSortDirection}
          setIsCompactView={setIsCompactView}
          setPharmacySettings={setPharmacySettings}
          setEditingMedication={setEditingMedication}
          setIsAddModalOpen={setIsAddModalOpen}
          setRefillMedication={setRefillMedication}
          setHistoryMedication={setHistoryMedication}
          navigateToTab={navigateToTab}
          registerBackOverlay={registerBackOverlay}
          openAdd={openAdd}
          handleDeleteMedication={handleDeleteMedication}
          handleToggleAutoDeduct={handleToggleAutoDeduct}
          handleToggleMedicationReminder={handleToggleMedicationReminder}
          handleToggleMedicationCriticalStockAlerts={handleToggleMedicationCriticalStockAlerts}
          handleConsumeDose={handleConsumeDose}
          handleCardRestoreDose={handleCardRestoreDose}
          handleUndoRefill={handleUndoRefill}
          testAlarm={testAlarm}
          handleSavePharmacy={handleSavePharmacy}
          handleDeletePharmacy={handleDeletePharmacy}
          handleSaveUserContact={handleSaveUserContact}
          handleDeleteUserContact={handleDeleteUserContact}
          handleSaveUserAddress={handleSaveUserAddress}
          handleDeleteUserAddress={handleDeleteUserAddress}
        />

        {activeTab === 'stock' && <AndroidFab onClick={openAdd} />}
        <AndroidBottomNav activeTab={activeTab} onTabChange={navigateToTab} alertsCount={alertsCount} />

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
