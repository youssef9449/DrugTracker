import type { Medication } from '../types';
import {
  runGatedAddMedication,
  runGatedMedicationUpdate,
  runGatedDeleteMedication,
} from '../utils/manualStockMutation';
import { generateId } from '../utils/id';
import { playSuccessChime } from '../utils/sound';
import { STORAGE_ERRORS } from '../constants/uiStrings';
import { getDoseScheduleForUI } from '../utils/doseSchedule';
import type { MedicationHandlerState, MedicationHandlersDeps } from './medicationHandlerTypes';

export function useMedicationCrudHandlers(deps: MedicationHandlersDeps, state: MedicationHandlerState) {
  const {
    soundEnabled,
    setMedications,
    setLogs,
    setEditingMedication,
    showToast,
  } = deps;
  const { medicationsRef, globalAutoDeductEnabledRef } = state;

  const handleSaveMedication = async (
    medData: Omit<Medication, 'id' | 'createdAt'>,
    editId?: string
  ): Promise<boolean> => {
    const normalizedName = medData.name.trim().replace(/\\s+/g, ' ').toLocaleLowerCase();
    const hasDuplicateName = medicationsRef.current.some((medication) =>
      medication.id !== editId &&
      medication.name.trim().replace(/\\s+/g, ' ').toLocaleLowerCase() === normalizedName
    );
    if (hasDuplicateName) {
      showToast('يوجد دواء بنفس الاسم بالفعل');
      return false;
    }

    if (editId) {
      const result = await runGatedMedicationUpdate({
        editId,
        medData,
        globalAutoDeductEnabled: globalAutoDeductEnabledRef.current,
      });
      if (result.outcome !== 'applied') {
        if (result.outcome !== 'persist_failed') {
          setMedications(result.medications);
          medicationsRef.current = result.medications;
          setLogs(result.logs);
        }
        showToast(STORAGE_ERRORS.generic);
        return false;
      }
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
      const firstDoseTime = getDoseScheduleForUI(medData)[0]?.time;
      showToast(
        medData.reminderEnabled && firstDoseTime
          ? 'تم حفظ "' + medData.name + '" مع تذكير يومي الساعة ' + firstDoseTime
          : 'تم تعديل بيانات "' + medData.name + '" بنجاح'
      );
      if (soundEnabled) playSuccessChime();
      setEditingMedication(null);
      return true;
    }

    const newMed: Medication = {
      ...medData,
      id: generateId('med'),
      createdAt: new Date().toISOString(),
      autoDeductEnabled:
        medData.autoDeductEnabled !== undefined
          ? medData.autoDeductEnabled
          : globalAutoDeductEnabledRef.current,
      criticalStockAlertsEnabled: medData.criticalStockAlertsEnabled !== false,
    };
    const firstDoseTime = getDoseScheduleForUI(newMed)[0]?.time;
    const result = await runGatedAddMedication({ medication: newMed });
    if (result.outcome !== 'applied') {
      showToast(STORAGE_ERRORS.generic);
      return false;
    }
    setMedications(result.medications);
    medicationsRef.current = result.medications;
    setLogs(result.logs);
    showToast(
      newMed.reminderEnabled && firstDoseTime
        ? 'تمت إضافة "' + newMed.name + '" مع تنبيه الساعة ' + firstDoseTime
        : newMed.autoDeductEnabled
          ? 'تمت إضافة "' + newMed.name + '"، وستخصم كل جرعة تلقائياً في موعدها'
          : 'تمت إضافة "' + newMed.name + '" بنجاح'
    );
    if (soundEnabled) playSuccessChime();
    setEditingMedication(null);
    return true;
  };

  const handleDeleteMedication = (id: string) => {
    void (async () => {
      const result = await runGatedDeleteMedication({ medicationId: id });
      if (result.outcome !== 'persist_failed') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
      }
      if (result.outcome === 'applied') {
        const name = result.medicationName ?? id;
        showToast('تم حذف "' + name + '" من القائمة');
      } else {
        showToast(STORAGE_ERRORS.generic);
      }
    })();
  };

  return { handleSaveMedication, handleDeleteMedication };
}
