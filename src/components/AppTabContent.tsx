import type { FC, Dispatch, SetStateAction } from 'react';
import type { Medication, ConsumptionLog, PharmacySettings, Pharmacy, UserContact, UserAddress } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import type { MedicationSortDirection, MedicationSortField } from '../utils/medicationSorting';
import type { ActiveTab } from './AndroidBottomNav';
import { LowStockBanner } from './LowStockBanner';
import { MedicationCard } from './MedicationCard';
import { PharmacyShoppingView } from './PharmacyShoppingView';
import { PharmacyManagementView } from './PharmacyManagementView';
import { UserDataManagementView } from './UserDataManagementView';
import { ConsumptionLogView } from './ConsumptionLogView';
import { EmptyState } from './EmptyState';
import { MedicationSortControl } from './MedicationSortControl';
import { Toggle } from './ui/Toggle';
import { playSuccessChime } from '../utils/sound';

interface StockViewModel {
  medications: Medication[];
  logs: ConsumptionLog[];
  medicationsWithStatus: Array<{ med: Medication; statusInfo: ReturnType<typeof calculateMedicationStatus> }>;
  filteredMedications: Medication[];
  alertsCount: number;
  sufficientCount: number;
  filter: 'all' | 'alerts' | 'sufficient';
  searchQuery: string;
  isCompactView: boolean;
  medicationSortField: MedicationSortField;
  medicationSortDirection: MedicationSortDirection;
  soundEnabled: boolean;
  globalAutoDeductEnabled: boolean;
}

interface StockActions {
  setFilter: Dispatch<SetStateAction<'all' | 'alerts' | 'sufficient'>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setMedicationSortField: Dispatch<SetStateAction<MedicationSortField>>;
  setMedicationSortDirection: Dispatch<SetStateAction<MedicationSortDirection>>;
  setIsCompactView: Dispatch<SetStateAction<boolean>>;
  setEditingMedication: Dispatch<SetStateAction<Medication | null>>;
  setIsAddModalOpen: Dispatch<SetStateAction<boolean>>;
  setRefillMedication: Dispatch<SetStateAction<Medication | null>>;
  setHistoryMedication: Dispatch<SetStateAction<Medication | null>>;
  openAdd: () => void;
  handleDeleteMedication: (id: string) => void;
  handleToggleAutoDeduct: (id: string) => void;
  handleToggleMedicationReminder: (id: string) => void;
  handleToggleMedicationCriticalStockAlerts: (id: string) => void;
  handleConsumeDose: (medicationId: string, doseId?: string) => void;
  handleCardRestoreDose: (medicationId: string, doseId?: string) => void;
}

interface PharmacyActions {
  pharmacySettings: PharmacySettings;
  setPharmacySettings: Dispatch<SetStateAction<PharmacySettings>>;
  handleSavePharmacy: (pharmacy: Pharmacy) => void;
  handleDeletePharmacy: (id: string) => void;
}

interface UserDataActions {
  userContacts: UserContact[];
  userAddresses: UserAddress[];
  handleSaveUserContact: (contact: UserContact) => void;
  handleDeleteUserContact: (id: string) => void;
  handleSaveUserAddress: (address: UserAddress) => void;
  handleDeleteUserAddress: (id: string) => void;
}

interface NavigationActions {
  activeTab: ActiveTab;
  navigateToTab: (tab: ActiveTab) => void;
  registerBackOverlay: (id: string, close: () => void, priority?: number) => () => void;
  showToast: (message: string) => void;
}

interface AppTabContentProps {
  stock: StockViewModel;
  stockActions: StockActions;
  pharmacy: PharmacyActions;
  userData: UserDataActions;
  navigation: NavigationActions;
}

export const AppTabContent: FC<AppTabContentProps> = ({
  stock,
  stockActions,
  pharmacy,
  userData,
  navigation,
}) => {
  const {
    medications, logs, medicationsWithStatus, filteredMedications, alertsCount, sufficientCount,
    filter, searchQuery, isCompactView, medicationSortField, medicationSortDirection,
    soundEnabled, globalAutoDeductEnabled,
  } = stock;
  const {
    setFilter, setSearchQuery, setMedicationSortField, setMedicationSortDirection, setIsCompactView,
    setEditingMedication, setIsAddModalOpen, setRefillMedication, setHistoryMedication, openAdd,
    handleDeleteMedication, handleToggleAutoDeduct, handleToggleMedicationReminder,
    handleToggleMedicationCriticalStockAlerts, handleConsumeDose, handleCardRestoreDose,
  } = stockActions;
  const { pharmacySettings, setPharmacySettings, handleSavePharmacy, handleDeletePharmacy } = pharmacy;
  const {
    userContacts, userAddresses, handleSaveUserContact, handleDeleteUserContact,
    handleSaveUserAddress, handleDeleteUserAddress,
  } = userData;
  const { activeTab, navigateToTab, registerBackOverlay, showToast } = navigation;

  return (
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
                          onRegisterBackHandler={registerBackOverlay}
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
                  <LowStockBanner medicationsWithStatus={medicationsWithStatus} onNavigateToShopping={() => navigateToTab('shopping')} />
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
                        onNavigateToShopping={() => navigateToTab('shopping')}
                        onRegisterBackHandler={registerBackOverlay}
                        onConsumeDose={handleConsumeDose}
                        onRestoreDose={handleCardRestoreDose}
                        onOpenHistory={(m) => setHistoryMedication(m)}
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
                onOpenUserContactsSettings={() => navigateToTab('user-data')}
                onRegisterBackHandler={registerBackOverlay}
              />
            )}
  
            {activeTab === 'pharmacies' && (
              <PharmacyManagementView
                pharmacies={pharmacySettings.pharmacies || []}
                onSave={handleSavePharmacy}
                onDelete={handleDeletePharmacy}
                showToast={showToast}
                onRegisterBackHandler={registerBackOverlay}
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
                onRegisterBackHandler={registerBackOverlay}
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
  );
};
