import { type FC } from 'react';
import { MessageCircle } from 'lucide-react';
import type { Medication, PharmacySettings } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { describeOrderQuantityBreakdown } from '../utils/whatsapp';
import { PharmacyShoppingSendModal } from './PharmacyShoppingSendModal';
import { PharmacyShoppingMedicationRow } from './PharmacyShoppingMedicationRow';
import { usePharmacyShoppingModel } from '../hooks/usePharmacyShoppingModel';

interface PharmacyShoppingViewProps {
  medications: Medication[];
  settings: PharmacySettings;
  onUpdateSettings: (newSettings: PharmacySettings) => void;
  showToast: (message: string) => void;
  onOpenUserContactsSettings?: (() => void) | undefined;
  onRegisterBackHandler?: ((id: string, close: () => void, priority?: number) => () => void) | undefined;
}

export const PharmacyShoppingView: FC<PharmacyShoppingViewProps> = ({
  medications, settings, onUpdateSettings, showToast,
  onOpenUserContactsSettings = () => {}, onRegisterBackHandler,
}) => {
  const {
    pharmacies, selectedPharmacy, whatsappContacts, whatsappAddresses, selectedWhatsappContactIds,
    selectedWhatsappAddressIds, showAllForPlanning, setShowAllForPlanning, displayList, selectedMedIds,
    activeOrderItems, currentWhatsAppMessage, isSendModalOpen, setIsSendModalOpen, hasPharmacyPhone,
    displayPhone, selectedCount, targetWaUrl, handleToggleSelect, handleRemoveFromShopping,
    getMedicationPeriod, getQuantityMode, getAvailableUnits, getSelectedUnits, getUnitQuantity,
    getCustomQuantityInputValue, getOrderBreakdown, getRequestedPills, unitLabel, getRequestedAmount,
    handleMedicationPeriodChange, handleToggleQuantityMode, handleToggleOrderUnit, handleCustomQuantityChange,
    toggleWhatsappContact, toggleWhatsappAddress, handleSendToWhatsApp, selectAllDisplayedMeds,
    deselectAllDisplayedMeds, restoreAllMedicationsToShopping,
  } = usePharmacyShoppingModel({
    medications,
    settings,
    onUpdateSettings,
    showToast,
    ...(onRegisterBackHandler !== undefined ? { onRegisterBackHandler } : {}),
  });

  const handleShowAllForPlanning = () => {
    restoreAllMedicationsToShopping();
    setShowAllForPlanning(true);
  };
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between text-xs px-1">
        <span className="font-bold text-slate-700">
          الأدوية المتاحة للطلب ({selectedCount} من {displayList.length})
        </span>
        <div className="flex items-center gap-2 text-[11px]">
          <div className="flex items-center gap-0.5 rounded-xl bg-teal-600 p-0.5 shadow-xs" role="group" aria-label="نطاق الأدوية">
            <button
              type="button"
              onClick={() => setShowAllForPlanning(false)}
              className={`rounded-lg px-2 py-1 text-[10px] font-bold transition ${!showAllForPlanning ? 'bg-white text-teal-700 shadow-xs' : 'text-white hover:bg-teal-700'}`}
            >
              النواقص فقط
            </button>
            <button
              type="button"
              onClick={handleShowAllForPlanning}
              className={`rounded-lg px-2 py-1 text-[10px] font-bold transition ${showAllForPlanning ? 'bg-white text-teal-700 shadow-xs' : 'text-white hover:bg-teal-700'}`}
            >
              كل الأدوية
            </button>
          </div>
          <button
            onClick={selectAllDisplayedMeds}
            className="text-teal-700 font-bold"
          >
            تحديد الكل
          </button>
          <button
            onClick={deselectAllDisplayedMeds}
            className="text-slate-500"
          >
            إلغاء
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {displayList.map((med) => {
          const { status } = calculateMedicationStatus(med);
          const { quantity: suggestedPills } = getRequestedAmount(med);
          const requestedPills = getRequestedPills(med, suggestedPills);
          return (
            <PharmacyShoppingMedicationRow
              key={med.id}
              medication={med}
              status={status}
              suggestedPills={suggestedPills}
              requestedPills={requestedPills}
              isSelected={selectedMedIds.has(med.id)}
              availableUnits={getAvailableUnits(med)}
              selectedUnits={getSelectedUnits(med)}
              getQuantityMode={getQuantityMode}
              getCustomQuantityInputValue={getCustomQuantityInputValue}
              getMedicationPeriod={getMedicationPeriod}
              getUnitQuantity={getUnitQuantity}
              getOrderBreakdown={getOrderBreakdown}
              unitLabel={unitLabel}
              describeOrderQuantityBreakdown={describeOrderQuantityBreakdown}
              onToggleSelect={handleToggleSelect}
              onRemoveFromShopping={handleRemoveFromShopping}
              onToggleQuantityMode={handleToggleQuantityMode}
              onToggleOrderUnit={handleToggleOrderUnit}
              onCustomQuantityChange={handleCustomQuantityChange}
              onMedicationPeriodChange={handleMedicationPeriodChange}
            />
          );
        })}
      </div>
      <button
        type="button"
        onClick={handleSendToWhatsApp}
        aria-label="إرسال طلبية بالواتساب"
        className="fixed bottom-[112px] left-4 z-40 flex items-center gap-2 rounded-2xl border border-teal-400/40 bg-teal-600 px-4 py-3 text-xs font-bold text-white shadow-xl ring-2 ring-white/60 transition-all duration-200 hover:bg-teal-700 active:scale-95 sm:text-sm md:absolute md:bottom-16 md:left-auto md:right-5 md:rounded-xl md:px-3 md:py-2 md:text-xs"
      >
        <MessageCircle className="w-5 h-5" />
        <span>إرسال طلبية بالواتساب</span>
      </button>
      {/* WhatsApp Send Confirmation & Direct Links Modal */}
      <PharmacyShoppingSendModal
        isOpen={isSendModalOpen}
        settings={settings}
        onUpdateSettings={onUpdateSettings}
        pharmacies={pharmacies}
        selectedPharmacy={selectedPharmacy}
        whatsappContacts={whatsappContacts}
        whatsappAddresses={whatsappAddresses}
        selectedWhatsappContactIds={selectedWhatsappContactIds}
        selectedWhatsappAddressIds={selectedWhatsappAddressIds}
        toggleWhatsappContact={toggleWhatsappContact}
        toggleWhatsappAddress={toggleWhatsappAddress}
        selectedCount={selectedCount}
        hasPharmacyPhone={hasPharmacyPhone}
        displayPhone={displayPhone}
        targetWaUrl={targetWaUrl}
        currentWhatsAppMessage={currentWhatsAppMessage}
        activeOrderItems={activeOrderItems}
        onOpenUserContactsSettings={onOpenUserContactsSettings}
        showToast={showToast}
        onClose={() => setIsSendModalOpen(false)}
      />
    </div>
  );
};