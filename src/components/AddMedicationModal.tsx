import { type FC, type FormEvent } from 'react';
import { X, Pill, ShieldAlert, Check } from 'lucide-react';
import type { Medication } from '../types';
import { resizeDoseSchedule } from '../utils/doseSchedule';
import { Modal } from './ui/Modal';
import { MedicationCourseAndSchedule } from './MedicationCourseAndSchedule';
import { AddMedicationStockSettings } from './AddMedicationStockSettings';
import { AddMedicationBasicsSection } from './AddMedicationBasicsSection';
import { AddMedicationPackagingSection } from './AddMedicationPackagingSection';
import { AddMedicationDetailsSection } from './AddMedicationDetailsSection';
import { useAddMedicationForm } from '../hooks/useAddMedicationForm';

interface AddMedicationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => Promise<boolean>;
  initialData?: Medication | null | undefined;
  defaultAutoDeductEnabled?: boolean | undefined;
}
export const AddMedicationModal: FC<AddMedicationModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
  defaultAutoDeductEnabled = true,
}) => {
  const {
    name, setName, currentPills, currentPillsStr, setCurrentPills, setCurrentPillsStr,
    dosesPerDay, setDosesPerDay, doseSchedule, setDoseSchedule,
    unit, warningThresholdDays, setWarningThresholdDays, category, setCategory, colorTag, setColorTag,
    stripsPerBox, setStripsPerBox, pillsPerStrip, noStrips, setNoStrips,
    packageSize, packageSizeStr, setPackageSize, setPackageSizeStr,
    showStockHelper, setShowStockHelper, helperBoxes, helperStrips, helperLoose,
    setHelperBoxes, setHelperStrips, setHelperLoose, helperTotal, error, setError,
    reminderEnabled, setReminderEnabled, autoDeductEnabled, setAutoDeductEnabled,
    criticalStockAlertsEnabled, setCriticalStockAlertsEnabled,
    isChronic, setIsChronic, durationDaysStr, setDurationDaysStr,
    setTreatmentStartDateStr, handleUnitChange, handleStripsChange,
    handlePillsPerStripChange, applyStockHelper, handleSubmit,
  } = useAddMedicationForm({ isOpen, onSave, initialData, defaultAutoDeductEnabled });

  const onSubmit = async (event: FormEvent) => {
    if (await handleSubmit(event)) onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      label={initialData ? 'تعديل بيانات الدواء' : 'إضافة دواء جديد'}
    >
      <div
        className="w-full sm:max-w-md bg-white rounded-t-[28px] sm:rounded-[28px] shadow-xl border border-slate-200/80 overflow-hidden max-h-[90vh] flex flex-col"
        dir="rtl"
      >
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-teal-700/90 flex items-center justify-center">
              <Pill className="w-5 h-5 text-teal-100" />
            </div>
            <h3 className="font-bold text-base">
              {initialData ? 'تعديل بيانات الدواء' : 'إضافة دواء جديد لمتابعة استهلاكه'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full text-teal-200 hover:text-white hover:bg-teal-700/80 transition flex items-center justify-center cursor-pointer"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <AddMedicationStockSettings
            criticalStockAlertsEnabled={criticalStockAlertsEnabled}
            setCriticalStockAlertsEnabled={setCriticalStockAlertsEnabled}
            warningThresholdDays={warningThresholdDays}
            setWarningThresholdDays={setWarningThresholdDays}
            autoDeductEnabled={autoDeductEnabled}
            setAutoDeductEnabled={setAutoDeductEnabled}
          />
          <AddMedicationBasicsSection
            name={name}
            setName={setName}
            currentPills={currentPills}
            currentPillsStr={currentPillsStr}
            setCurrentPills={setCurrentPills}
            setCurrentPillsStr={setCurrentPillsStr}
            initialData={initialData}
            unit={unit}
            handleUnitChange={handleUnitChange}
            showStockHelper={showStockHelper}
            setShowStockHelper={setShowStockHelper}
            noStrips={noStrips}
            pillsPerStrip={pillsPerStrip}
            stripsPerBox={stripsPerBox}
            helperBoxes={helperBoxes}
            helperStrips={helperStrips}
            helperLoose={helperLoose}
            setHelperBoxes={setHelperBoxes}
            setHelperStrips={setHelperStrips}
            setHelperLoose={setHelperLoose}
            helperTotal={helperTotal}
            applyStockHelper={applyStockHelper}
          />
          <AddMedicationPackagingSection
            unit={unit}
            noStrips={noStrips}
            setNoStrips={setNoStrips}
            stripsPerBox={stripsPerBox}
            setStripsPerBox={setStripsPerBox}
            pillsPerStrip={pillsPerStrip}
            handleStripsChange={handleStripsChange}
            handlePillsPerStripChange={handlePillsPerStripChange}
            packageSize={packageSize}
            packageSizeStr={packageSizeStr}
            setPackageSize={setPackageSize}
            setPackageSizeStr={setPackageSizeStr}
          />
          <AddMedicationDetailsSection
            dosesPerDay={dosesPerDay}
            setDosesPerDay={setDosesPerDay}
            setDoseSchedule={setDoseSchedule}
            resizeDoseSchedule={resizeDoseSchedule}
            category={category}
            setCategory={setCategory}
            colorTag={colorTag}
            setColorTag={setColorTag}
          />
          <MedicationCourseAndSchedule
            isChronic={isChronic}
            setIsChronic={setIsChronic}
            durationDaysStr={durationDaysStr}
            setDurationDaysStr={setDurationDaysStr}
            doseSchedule={doseSchedule}
            setDoseSchedule={setDoseSchedule}
            dosesPerDay={dosesPerDay}
            setDosesPerDay={setDosesPerDay}
            unit={unit}
            reminderEnabled={reminderEnabled}
            setReminderEnabled={setReminderEnabled}
            setError={setError}
            setTreatmentStartDateStr={setTreatmentStartDateStr}
          />
          <button
            type="submit"
            className="w-full h-11 px-6 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-full font-semibold text-sm flex items-center justify-center gap-2 shadow-2xs transition cursor-pointer"
          >
            <Check className="w-4 h-4" />
            <span>{initialData ? 'حفظ التعديلات' : 'إضافة الدواء'}</span>
          </button>
        </form>
      </div>
    </Modal>
  );
};
