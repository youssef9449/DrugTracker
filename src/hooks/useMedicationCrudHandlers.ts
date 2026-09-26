import type { Medication, ConsumptionLog, PharmacySettings } from '../types';
import {
  runGatedAddMedication,
  runGatedMedicationUpdate,
  runGatedDeleteMedication,
  runGatedBackupRestore,
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
    editingMedicationId?: string
  ): Promise<boolean> => {
    const isEditing = Boolean(editingMedicationId);

    if (isEditing && editingMedicationId) {
      const existing = medicationsRef.current.find((m) => m.id === editingMedicationId);
      if (!existing) {
        showToast(STORAGE_ERRORS.generic);
        return false;
      }
      const updatedMedication: Medication = {
        ...existing,
        ...medData,
        id: editingMedicationId,
        createdAt: existing.createdAt,
      };

      const result = await runGatedMedicationUpdate({
        medicationId: editingMedicationId,
        updatedMedication,
      });

      if (result.outcome === 'applied') {
        setMedications(result.medications);
        medicationsRef.current = result.medications;
        setLogs(result.logs);
        setEditingMedication(null);
        if (soundEnabled) playSuccessChime();
        showToast('تم حفظ التعديلات بنجاح');
        return true;
      }

      showToast(STORAGE_ERRORS.generic);
      return false;
    }

    const newMedication: Medication = {
      ...medData,
      id: generateId('med'),
      createdAt: new Date().toISOString(),
      autoDeductEnabled: globalAutoDeductEnabledRef.current,
      doseSchedule: getDoseScheduleForUI(medData),
    };

    const result = await runGatedAddMedication({ newMedication });

    if (result.outcome === 'applied') {
      setMedications(result.medications);
      medicationsRef.current = result.medications;
      setLogs(result.logs);
      if (soundEnabled) playSuccessChime();
      showToast('تمت إضافة الدواء بنجاح');
      return true;
    }

    showToast(STORAGE_ERRORS.generic);
    return false;
  };

  const handleDeleteMedication = (id: string) => {
    void (async () => {
      const result = await runGatedDeleteMedication({ medicationId: id });
      if (result.outcome === 'applied' || result.outcome === 'missing_med') {
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

  const handleRestoreBackup = async (opts: {
    backupMedications: Medication[];
    backupLogs?: ConsumptionLog[] | undefined;
    mode: 'replace' | 'merge';
    pharmacySettings?: PharmacySettings | undefined;
    onApplyPharmacySettings?: ((settings: PharmacySettings) => void) | undefined;
  }): Promise<boolean> => {
    const result = await runGatedBackupRestore({
      backupMedications: opts.backupMedications,
      backupLogs: opts.backupLogs,
      mode: opts.mode,
    });

    if (result.outcome !== 'applied') {
      showToast('تعذر استعادة النسخة الاحتياطية. يرجى المحاولة مرة أخرى.');
      return false;
    }

    setMedications(result.medications);
    medicationsRef.current = result.medications;
    setLogs(result.logs);

    if (opts.pharmacySettings && opts.onApplyPharmacySettings) {
      opts.onApplyPharmacySettings(opts.pharmacySettings);
    }

    if (soundEnabled) playSuccessChime();

    if (result.restoredCount > 0) {
      showToast(
        opts.mode === 'replace'
          ? `تمت استعادة ${result.restoredCount} دواء بنجاح (استبدال شامل)`
          : `تم دمج ${result.restoredCount} دواء مع القائمة الحالية بنجاح`
      );
    } else {
      showToast('تمت استعادة البيانات المحددة بنجاح');
    }
    return true;
  };

  return { handleSaveMedication, handleDeleteMedication, handleRestoreBackup };
}
