import { AppHeader } from './components/AppHeader';
import { AppTabContent } from './components/AppTabContent';
import { AndroidBottomNav } from './components/AndroidBottomNav';
import { AddMedicationModal } from './components/AddMedicationModal';
import { RefillModal } from './components/RefillModal';
import { AppSettingsModal } from './components/AppSettingsModal';
import { AndroidFab } from './components/AndroidFab';
import { DoseAlarmModal } from './components/DoseAlarmModal';
import { SelectDoseModal } from './components/SelectDoseModal';
import { MedicationHistoryModal } from './components/MedicationHistoryModal';
import { AutoDeductPromptModal } from './components/AutoDeductPromptModal';
import { UpdatePrompt } from './components/UpdatePrompt';
import { TOAST_MESSAGES } from './constants/uiStrings';
import { playSuccessChime } from './utils/sound';

import { useDoseReminders } from './hooks/useDoseReminders';
import { useAppRuntimeState } from './hooks/useAppRuntimeState';
import { useAppUiState } from './hooks/useAppUiState';
import { useAppBackOverlays } from './hooks/useAppBackOverlays';
import { useAppRuntime } from './hooks/useAppRuntime';
import { useAppBackNavigation } from './hooks/useAppBackNavigation';
import { useDerivedMedications } from './hooks/useDerivedMedications';

export default function App() {
  const runtimeState = useAppRuntimeState();
  const uiState = useAppUiState();

  const {
    activeTab, setActiveTab, filter, setFilter, searchQuery, setSearchQuery,
    isAddModalOpen, setIsAddModalOpen, isSettingsModalOpen, setIsSettingsModalOpen,
    settingsModalMode, setSettingsModalMode, activeOrderItems, setActiveOrderItems,
    editingMedication, setEditingMedication, refillMedication, setRefillMedication,
    selectDoseMed, setSelectDoseMed, selectDoseMode, setSelectDoseMode,
    historyMedication, setHistoryMedication, isPhoneFrame, setIsPhoneFrame,
    medicationSortField, setMedicationSortField, medicationSortDirection, setMedicationSortDirection,
    toast, showToast,
  } = uiState;

  const {
    medications, logs, pharmacySettings, hydrated, isFirstRun, isAutoDeductPromptOpen,
    soundEnabled, notificationsEnabled, criticalStockAlertsEnabled, exactAlarmPermission,
    criticalAlarmResumeTick, doseAlarmResumeTick, doseLifecycleTick, globalAutoDeductEnabled,
    fontScale, isCompactView, allowManualTakeActionByMedicationId,
    setMedications, setLogs, setPharmacySettings, setHydrated, setIsFirstRun,
    setIsAutoDeductPromptOpen, setSoundEnabled, setNotificationsEnabled,
    setCriticalStockAlertsEnabled, setExactAlarmPermission, setGlobalAutoDeductEnabled,
    setFontScale, setIsCompactView, setDoseLifecycleTick, setCriticalAlarmResumeTick,
    setDoseAlarmResumeTick,
  } = runtimeState;

  const { navigateToTab, selectTab, registerBackOverlay } = useAppBackNavigation(activeTab, setActiveTab);
  const { alarmingMedication, alarmingDoseId, openAlarm, dismissAlarm, snoozeAlarm, testAlarm } = useDoseReminders({
    medications,
    allowManualTakeActionByMedicationId,
  });


  } = useAppRuntime({
    state: runtimeState,
    ui: { selectDoseMode, settingsModalMode },
    uiActions: { setSelectDoseMed, setSelectDoseMode, setEditingMedication },
    services: { showToast, dismissAlarm, snoozeAlarm, openAlarm },
  });

  useAppBackOverlays({
    registerBackOverlay,
    alarmingMedication,
    dismissAlarm,
    selectDoseMed,
    setSelectDoseMed,
    setSelectDoseMode,
    historyMedication,
    setHistoryMedication,
    isAutoDeductPromptOpen,
    handleConfirmAutoDeductPrompt,
    isAddModalOpen,
    setIsAddModalOpen,
    setEditingMedication,
    refillMedication,
    setRefillMedication,
    isSettingsModalOpen,
    setIsSettingsModalOpen,
  });

  useAppBackOverlays({
    registerBackOverlay,
    alarmingMedication,
    dismissAlarm,
    selectDoseMed,
    setSelectDoseMed,
    setSelectDoseMode,
    historyMedication,
    setHistoryMedication,
    isAutoDeductPromptOpen,
    handleConfirmAutoDeductPrompt,
    isAddModalOpen,
    setIsAddModalOpen,
    setEditingMedication,
    refillMedication,
    setRefillMedication,
    isSettingsModalOpen,
    setIsSettingsModalOpen,
  });


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
        <AndroidBottomNav activeTab={activeTab} onTabChange={selectTab} alertsCount={alertsCount} />

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
