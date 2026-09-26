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

export function useMedicationCrudHandlers(
  deps: MedicationHandlersDeps,
  state: MedicationHandlerState
) {
  const {
    soundEnabled,
    setMedications,
    setLogs,
    setEditingMedication,
    showToast,
    pharmacySettings,
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
        reconcileExactBeforeMutation: false,
      });
      if (result.outcome !== 'applied') {
        if (result.outcome !== 'persist_failed') {
          setMedications(result.medications);
          medicationsRef.current = result.medications;
          setLogs(result.logs);
        }
        showToast(STORAGE_ERRORS.medicationSave(result.reason));
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
      doseSchedule: getDoseScheduleForUI(medData),
    };
    const firstDoseTime = getDoseScheduleForUI(newMed)[0]?.time;
    const result = await runGatedAddMedication({
      medication: newMed,
      reconcileExactBeforeMutation: false,
    });
    if (result.outcome !== 'applied') {
      showToast(STORAGE_ERRORS.medicationSave(result.reason));
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

  const handleRestoreBackup = async (opts: {
    backupMedications: Medication[];
    backupLogs?: ConsumptionLog[] | undefined;
    restoreLogs: boolean;
    mode: 'replace' | 'merge';
    pharmacySettings?: PharmacySettings | undefined;
    onApplyPharmacySettings?: ((settings: PharmacySettings) => Promise<boolean> | boolean) | undefined;
  }): Promise<boolean> => {
    let pharmacyApplied = false;
    const previousPharmacySettings = pharmacySettings;

    if (opts.pharmacySettings && opts.onApplyPharmacySettings) {
      const pharmacyResult = await opts.onApplyPharmacySettings(opts.pharmacySettings);
      if (pharmacyResult === false) {
        showToast('تعذر حفظ بيانات الصيدليات. لم يتم استعادة النسخة.');
        return false;
      }
      pharmacyApplied = true;
    }

    const result = await runGatedBackupRestore({
      backupMedications: opts.backupMedications,
      backupLogs: opts.backupLogs,
      restoreLogs: opts.restoreLogs,
      mode: opts.mode,
    });

    if (result.outcome !== 'applied') {
      if (pharmacyApplied && opts.onApplyPharmacySettings) {
        await opts.onApplyPharmacySettings(previousPharmacySettings);
      }
      showToast('تعذر استعادة النسخة الاحتياطية. يرجى المحاولة مرة أخرى.');
      return false;
    }

    setMedications(result.medications);
    medicationsRef.current = result.medications;
    setLogs(result.logs);

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
