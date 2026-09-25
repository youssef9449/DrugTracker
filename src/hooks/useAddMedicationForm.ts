import { useReducer, useEffect, useMemo, useCallback, type FormEvent, type SetStateAction } from 'react';
import type { Medication, MedicationDose } from '../types';
import {
  totalDailyAmount,
  validateAndNormalizeDoseSchedule,
} from '../utils/doseSchedule';
import {
  calculateStockHelperTotal,
  calculatePackageConfiguration,
} from '../utils/addMedicationFormCalculations';
import {
  addMedicationFormReducer,
  createDefaultFormModel,
} from './addMedicationFormReducer';

export type { AddMedicationFormModel } from './addMedicationFormReducer';

export interface UseAddMedicationFormOptions {
  isOpen: boolean;
  onSave: (
    medData: Omit<Medication, 'id' | 'createdAt'>,
    editId?: string
  ) => Promise<boolean>;
  initialData?: Medication | null | undefined;
  defaultAutoDeductEnabled?: boolean | undefined;
}

/**
 * Add/edit medication form state driven by an explicit domain reducer (#529).
 * Public field setters remain stable for existing consumers.
 */
export function useAddMedicationForm({
  isOpen,
  onSave,
  initialData,
  defaultAutoDeductEnabled = true,
}: UseAddMedicationFormOptions) {
  const [form, dispatch] = useReducer(
    addMedicationFormReducer,
    defaultAutoDeductEnabled,
    createDefaultFormModel
  );

  useEffect(() => {
    if (!isOpen) return;
    if (initialData) {
      dispatch({ type: 'INIT_EDIT', medication: initialData });
    } else {
      dispatch({ type: 'RESET_ADD', defaultAutoDeductEnabled });
    }
    // Intentionally only [isOpen]: parent identity changes must not reset mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const {
    details,
    stock,
    packaging,
    dosage,
    treatment,
    ui,
  } = form;

  const helperTotal = useMemo(
    () =>
      calculateStockHelperTotal(
        packaging.stripsPerBox,
        packaging.pillsPerStrip,
        packaging.helperBoxes,
        packaging.helperStrips,
        packaging.helperLoose
      ),
    [
      packaging.helperBoxes,
      packaging.helperStrips,
      packaging.helperLoose,
      packaging.stripsPerBox,
      packaging.pillsPerStrip,
    ]
  );

  const handleUnitChange = useCallback(
    (newUnit: string) => {
      dispatch({
        type: 'UNIT_CHANGED',
        nextUnit: newUnit,
        skipDefaults: Boolean(initialData),
      });
    },
    [initialData]
  );

  const handleStripsChange = useCallback((rawStrips: string) => {
    dispatch({ type: 'STRIPS_CHANGED', value: rawStrips });
  }, []);

  const handlePillsPerStripChange = useCallback((rawPills: string) => {
    dispatch({ type: 'PILLS_PER_STRIP_CHANGED', value: rawPills });
  }, []);

  const applyStockHelper = useCallback(() => {
    const clamped = calculateStockHelperTotal(
      packaging.stripsPerBox,
      packaging.pillsPerStrip,
      packaging.helperBoxes,
      packaging.helperStrips,
      packaging.helperLoose
    );
    dispatch({ type: 'APPLY_STOCK_HELPER', total: clamped });
  }, [
    packaging.stripsPerBox,
    packaging.pillsPerStrip,
    packaging.helperBoxes,
    packaging.helperStrips,
    packaging.helperLoose,
  ]);

  const handleSubmit = async (e: FormEvent): Promise<boolean> => {
    e.preventDefault();
    if (!details.name.trim()) {
      dispatch({ type: 'SET_ERROR', value: 'يرجى إدخال اسم الدواء' });
      return false;
    }
    if (stock.currentPills < 0) {
      dispatch({
        type: 'SET_ERROR',
        value: 'الكمية المتوفرة لا يمكن أن تكون سالبة',
      });
      return false;
    }
    const scheduleResult = validateAndNormalizeDoseSchedule(
      dosage.dosesPerDay,
      dosage.doseSchedule
    );
    if (!scheduleResult.ok || !scheduleResult.schedule) {
      dispatch({
        type: 'SET_ERROR',
        value: scheduleResult.message || 'جدول الجرعات غير صالح',
      });
      return false;
    }
    const normalizedSchedule = scheduleResult.schedule;
    const doseNum = totalDailyAmount(normalizedSchedule);
    if (!(doseNum > 0)) {
      dispatch({
        type: 'SET_ERROR',
        value: 'يجب أن يكون مجموع الجرعات أكبر من صفر',
      });
      return false;
    }
    const pkgConfig = calculatePackageConfiguration({
      unit: details.unit,
      noStrips: packaging.noStrips,
      packageSize: stock.packageSize,
      stripsPerBox: packaging.stripsPerBox,
      pillsPerStrip: packaging.pillsPerStrip,
    });
    const { stripsPerBoxNum, pillsPerStripNum, calculatedPkgSize } = pkgConfig;
    const savedCurrentPills =
      Number.isFinite(stock.currentPills) && stock.currentPills >= 0
        ? stock.currentPills
        : 0;
    const parsedThreshold = parseInt(dosage.warningThresholdDays, 10);
    const savedWarningThreshold =
      Number.isInteger(parsedThreshold) && parsedThreshold >= 1
        ? parsedThreshold
        : 5;
    let finalDurationDays: number | undefined = undefined;
    if (!treatment.isChronic) {
      const dur = parseInt(treatment.durationDaysStr, 10);
      if (!Number.isInteger(dur) || dur <= 0 || dur > 3650) {
        dispatch({
          type: 'SET_ERROR',
          value: 'مدة الاستعمال يجب أن تكون من 1 إلى 3650 يوماً',
        });
        return false;
      }
      finalDurationDays = dur;
    }
    const finalTreatmentStartDate = !treatment.isChronic
      ? treatment.treatmentStartDateStr ||
        initialData?.treatmentStartDate ||
        ''
      : undefined;
    if (!treatment.isChronic && !finalTreatmentStartDate) {
      dispatch({
        type: 'SET_ERROR',
        value:
          'تاريخ بداية الكورس غير محدد. اختر مدة محددة مرة أخرى لتعيين بداية العلاج.',
      });
      return false;
    }
    const saved = await onSave(
      {
        name: details.name.trim(),
        currentPills: savedCurrentPills,
        dailyDose: doseNum,
        unit: details.unit,
        warningThresholdDays: savedWarningThreshold,
        category: details.category.trim(),
        notes: initialData?.notes || '',
        colorTag: details.colorTag,
        autoDeductEnabled: treatment.autoDeductEnabled,
        isChronic: treatment.isChronic,
        durationDays: finalDurationDays,
        treatmentStartDate: finalTreatmentStartDate,
        stripsPerBox: stripsPerBoxNum,
        pillsPerStrip: pillsPerStripNum,
        packageSize: calculatedPkgSize,
        reminderEnabled: treatment.reminderEnabled,
        dosesPerDay: normalizedSchedule.length,
        doseSchedule: normalizedSchedule,
      },
      initialData ? initialData.id : undefined
    );
    return saved;
  };



  // Stable consumer API: field accessors + named setters over the reducer.
  return {
    name: details.name,
    setName: (v: string) => dispatch({ type: 'SET_NAME', value: v }),
    currentPills: stock.currentPills,
    currentPillsStr: stock.currentPillsStr,
    setCurrentPills: (v: number) =>
      dispatch({ type: 'SET_CURRENT_PILLS', value: v }),
    setCurrentPillsStr: (v: string) =>
      dispatch({ type: 'SET_CURRENT_PILLS_STR', value: v }),
    dosesPerDay: dosage.dosesPerDay,
    setDosesPerDay: (v: SetStateAction<number>) =>
      dispatch({ type: 'SET_DOSES_PER_DAY', value: typeof v === 'function' ? v(dosage.dosesPerDay) : v }),
    doseSchedule: dosage.doseSchedule,
    setDoseSchedule: (v: MedicationDose[] | ((prev: MedicationDose[]) => MedicationDose[])) => {
      const next =
        typeof v === 'function' ? v(dosage.doseSchedule) : v;
      dispatch({ type: 'SET_DOSE_SCHEDULE', value: next });
    },
    unit: details.unit,
    warningThresholdDays: dosage.warningThresholdDays,
    setWarningThresholdDays: (v: string) =>
      dispatch({ type: 'SET_WARNING_THRESHOLD_DAYS', value: v }),
    category: details.category,
    setCategory: (v: string) => dispatch({ type: 'SET_CATEGORY', value: v }),
    colorTag: details.colorTag,
    setColorTag: (v: string) => dispatch({ type: 'SET_COLOR_TAG', value: v }),
    stripsPerBox: packaging.stripsPerBox,
    setStripsPerBox: (v: string) =>
      dispatch({ type: 'SET_STRIPS_PER_BOX', value: v }),
    pillsPerStrip: packaging.pillsPerStrip,
    noStrips: packaging.noStrips,
    setNoStrips: (v: boolean) => dispatch({ type: 'SET_NO_STRIPS', value: v }),
    packageSize: stock.packageSize,
    packageSizeStr: stock.packageSizeStr,
    setPackageSize: (v: number) =>
      dispatch({ type: 'SET_PACKAGE_SIZE', value: v }),
    setPackageSizeStr: (v: string) =>
      dispatch({ type: 'SET_PACKAGE_SIZE_STR', value: v }),
    showStockHelper: packaging.showStockHelper,
    setShowStockHelper: (v: boolean) =>
      dispatch({ type: 'SET_SHOW_STOCK_HELPER', value: v }),
    helperBoxes: packaging.helperBoxes,
    helperStrips: packaging.helperStrips,
    helperLoose: packaging.helperLoose,
    setHelperBoxes: (v: string) =>
      dispatch({ type: 'SET_HELPER_BOXES', value: v }),
    setHelperStrips: (v: string) =>
      dispatch({ type: 'SET_HELPER_STRIPS', value: v }),
    setHelperLoose: (v: string) =>
      dispatch({ type: 'SET_HELPER_LOOSE', value: v }),
    helperTotal,
    error: ui.error,
    setError: (v: SetStateAction<string>) =>
      dispatch({ type: 'SET_ERROR', value: typeof v === 'function' ? v(ui.error) : v }),
    reminderEnabled: treatment.reminderEnabled,
    setReminderEnabled: (v: SetStateAction<boolean>) =>
      dispatch({ type: 'SET_REMINDER_ENABLED', value: typeof v === 'function' ? v(treatment.reminderEnabled) : v }),
    autoDeductEnabled: treatment.autoDeductEnabled,
    setAutoDeductEnabled: (v: boolean) =>
      dispatch({ type: 'SET_AUTO_DEDUCT_ENABLED', value: v }),
    isChronic: treatment.isChronic,
    setIsChronic: (v: SetStateAction<boolean>) =>
      dispatch({ type: 'SET_IS_CHRONIC', value: typeof v === 'function' ? v(treatment.isChronic) : v }),
    durationDaysStr: treatment.durationDaysStr,
    setDurationDaysStr: (v: SetStateAction<string>) =>
      dispatch({ type: 'SET_DURATION_DAYS_STR', value: typeof v === 'function' ? v(treatment.durationDaysStr) : v }),
    treatmentStartDateStr: treatment.treatmentStartDateStr,
    setTreatmentStartDateStr: (v: SetStateAction<string>) =>
      dispatch({ type: 'SET_TREATMENT_START_DATE_STR', value: typeof v === 'function' ? v(treatment.treatmentStartDateStr) : v }),
    handleUnitChange,
    handleStripsChange,
    handlePillsPerStripChange,
    applyStockHelper,
    handleSubmit,
  };
}
