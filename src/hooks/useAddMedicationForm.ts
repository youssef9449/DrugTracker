import { useState, useEffect, useMemo, type FormEvent } from 'react';
import type { Medication, MedicationDose } from '../types';
import { isSolidUnit } from '../utils/medicationPackaging';
import {
  getDoseScheduleForUI,
  resizeDoseSchedule,
  totalDailyAmount,
  validateAndNormalizeDoseSchedule,
} from '../utils/doseSchedule';
import {
  calculatePackageConfiguration,
  calculateStockHelperTotal,
  calculateStripBasedPackageSize,
} from '../utils/addMedicationFormCalculations';

export interface UseAddMedicationFormOptions {
  isOpen: boolean;
  onSave: (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => Promise<boolean>;
  initialData?: Medication | null;
  defaultAutoDeductEnabled?: boolean;
}

export function useAddMedicationForm({
  isOpen,
  onSave,
  initialData,
  defaultAutoDeductEnabled = true,
}: UseAddMedicationFormOptions) {
  const [name, setName] = useState('');
  // Number inputs use a STRING state so the user can clear the field
  // and type a fresh value. If we used a number state with a
  // `parseFloat(value) || 1` fallback, clearing the field would
  // immediately re-populate it with the fallback, making it
  // impossible to type e.g. "2" (because "1" was already there,
  // typing "2" appended "12" instead of replacing). The string
  // state is converted to a number at submit time and the dailyDose
  // validation in handleSubmit checks for empty / 0 / NaN.
  const [currentPills, setCurrentPills] = useState<number>(30);
  // String-typed mirror of `currentPills`, used ONLY by the
  // "المتوفر حالياً" number input so the field can be cleared mid-edit
  // (select-all → delete) without the old `Math.max(0, parseInt || 0)`
  // snapping it back to 0. Same pattern as packageSizeStr.
  const [currentPillsStr, setCurrentPillsStr] = useState<string>('30');
  // The UI uses the explicit multi-dose schedule.
  // dailyDose is computed as the sum of schedule amounts
  // at save time so the existing auto-deduction engine is unchanged.
  const [dosesPerDay, setDosesPerDay] = useState<number>(1);
  const [doseSchedule, setDoseSchedule] = useState<MedicationDose[]>(() =>
    resizeDoseSchedule([], 1)
  );
  const [unit, setUnit] = useState('قرص');
  const [warningThresholdDays, setWarningThresholdDays] = useState<string>('5');
  const [category, setCategory] = useState('');
  const [colorTag, setColorTag] = useState('teal');
  // Strips-per-box and pills-per-strip use a STRING state for the
  // same reason as dailyDose — so the user can clear the field and
  // type a fresh value (the previous `parseInt(...) || 1` fallback
  // made it impossible to clear, just like the daily dose bug).
  // The handlers parse + Math.max(1, ...) the value before
  // computing packageSize, so an empty field is treated as 1 (the
  // minimum valid strip/pill count).
  const [stripsPerBox, setStripsPerBox] = useState<string>('3');
  const [pillsPerStrip, setPillsPerStrip] = useState<string>('10');
  // packageSize is derived from stripsPerBox * pillsPerStrip, kept as
  // number state because it's used in validation + display only.
  const [packageSize, setPackageSize] = useState<number>(30);
  const [showStockHelper, setShowStockHelper] = useState(false);
  // String editing state so the user can clear the field mid-edit (select-all →
  // delete) without parseInt||0 snapping back to 0. Parsed only for calculation.
  const [helperBoxes, setHelperBoxes] = useState<string>('1');
  const [helperStrips, setHelperStrips] = useState<string>('0');
  const [helperLoose, setHelperLoose] = useState<string>('0');
  const helperTotal = useMemo(
    () => calculateStockHelperTotal(stripsPerBox, pillsPerStrip, helperBoxes, helperStrips, helperLoose),
    [helperBoxes, helperStrips, helperLoose, stripsPerBox, pillsPerStrip]
  );
  const [error, setError] = useState('');
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(false);
  const [autoDeductEnabled, setAutoDeductEnabled] = useState<boolean>(true);
  const [isChronic, setIsChronic] = useState<boolean>(true);
  const [durationDaysStr, setDurationDaysStr] = useState<string>('');
  const [treatmentStartDateStr, setTreatmentStartDateStr] = useState<string>('');
  // Toggle for medications that come as loose pills in a box without
  // strips (e.g., Coffiram — 15 pills per box, no blister strips).
  // When enabled, the strip fields are hidden and the user just
  // enters the total pills per box.
  const [noStrips, setNoStrips] = useState<boolean>(false);
  // String-typed mirror of `packageSize`, used ONLY by the non-solid
  // (liquid / dose / sachet) package-size input. Keeping it as a string
  // lets the user clear the field mid-edit (select-all → delete) without
  // the old `Math.max(1, parseInt(...) || 1)` snapping it back to "1".
  // The numeric `packageSize` is the source of truth for validation /
  // save; this string is synced to it and parsed back on every change.
  // (Same pattern already used for `dailyDose`, `stripsPerBox`, etc.)
  const [packageSizeStr, setPackageSizeStr] = useState<string>(String(packageSize));
  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setCurrentPills(initialData.currentPills);
      setCurrentPillsStr(String(initialData.currentPills));
      // Editing uses persisted doseSchedule only (explicit-schedule model).
      // Missing/empty schedule → no synthetic dose.
      const schedule = getDoseScheduleForUI(initialData);
      setDoseSchedule(schedule);
      setDosesPerDay(schedule.length);
      const initUnit = initialData.unit || 'قرص';
      setUnit(initUnit);
      setWarningThresholdDays(String(initialData.warningThresholdDays ?? 5));
      setCategory(initialData.category || '');
      setColorTag(initialData.colorTag || 'teal');
      const isSolid = isSolidUnit(initUnit);
      const hasStrips = isSolid && Boolean(
        initialData.stripsPerBox &&
          initialData.pillsPerStrip &&
          initialData.stripsPerBox > 0 &&
          initialData.pillsPerStrip > 0
      );
      setNoStrips(!hasStrips);
      if (hasStrips) {
        const strips = initialData.stripsPerBox;
        const perStrip = initialData.pillsPerStrip;
        setStripsPerBox(String(strips));
        setPillsPerStrip(String(perStrip));
        const pkg = initialData.packageSize || (strips && perStrip ? strips * perStrip : 30);
        setPackageSize(pkg);
        setPackageSizeStr(String(pkg));
      } else {
        const defaultPkg = isSolid ? 30 : initUnit === 'مل' ? 100 : 30;
        setStripsPerBox(String(initialData.packageSize || defaultPkg));
        setPillsPerStrip(String(initialData.pillsPerStrip || 10));
        const pkg = initialData.packageSize || defaultPkg;
        setPackageSize(pkg);
        setPackageSizeStr(String(pkg));
      }
      setReminderEnabled(Boolean(initialData.reminderEnabled));
      setAutoDeductEnabled(initialData.autoDeductEnabled === true);
      if (initialData.isChronic === false) {
        setIsChronic(false);
        setDurationDaysStr(initialData.durationDays ? String(initialData.durationDays) : '');
        setTreatmentStartDateStr(initialData.treatmentStartDate ?? '');
      } else {
        setIsChronic(initialData.isChronic === true);
        setDurationDaysStr('');
        setTreatmentStartDateStr('');
      }
    } else {
      setName('');
      setCurrentPills(30);
      setCurrentPillsStr('30');
      const defaultSchedule = resizeDoseSchedule([], 1);
      setDoseSchedule(defaultSchedule);
      setDosesPerDay(1);
      setUnit('قرص');
      setWarningThresholdDays('5');
      setCategory('');
      setColorTag('teal');
      setStripsPerBox('3');
      setPillsPerStrip('10');
      setNoStrips(false);
      setPackageSize(30);
      setPackageSizeStr('30');
      setHelperBoxes('1');
      setHelperStrips('0');
      setHelperLoose('0');
      setReminderEnabled(false);
      setAutoDeductEnabled(defaultAutoDeductEnabled !== false);
      setIsChronic(true);
      setDurationDaysStr('');
      setTreatmentStartDateStr('');
    }
    setShowStockHelper(false);
    setError('');
    // Intentionally only sync on the open transition (dep [isOpen]) — if
    // the parent passes a new initialData object reference while the
    // modal is already open, we must NOT reset the form (that would
    // blow away in-progress edits). The latest initialData is read from
    // the closure at the moment the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  // Handle unit changes: update sensible defaults when switching between solid and liquid
  const handleUnitChange = (newUnit: string) => {
    setUnit(newUnit);
    if (!initialData) {
      if (newUnit === 'مل') {
        if (packageSize === 30) {
          setPackageSize(100);
          setPackageSizeStr('100');
        }
        if (currentPills === 30) {
          setCurrentPills(100);
          setCurrentPillsStr('100');
        }
        setDoseSchedule((prev) => {
          if (prev.length === 1 && Number(prev[0].amount) === 1) {
            return [{ ...prev[0], amount: 5 }];
          }
          return prev;
        });
      } else if (isSolidUnit(newUnit)) {
        if (packageSize === 100) {
          setPackageSize(30);
          setPackageSizeStr('30');
        }
        if (currentPills === 100) {
          setCurrentPills(30);
          setCurrentPillsStr('30');
        }
        setDoseSchedule((prev) => {
          if (prev.length === 1 && Number(prev[0].amount) === 5) {
            return [{ ...prev[0], amount: 1 }];
          }
          return prev;
        });
      }
    }
  };
  // Handle strips-per-box change. The input value comes in as a raw
  // string (per the onChange handler); we parse it to a number with a
  // Math.max(1, ...) clamp so the package size is always computed
  // from a valid strip count even when the user has temporarily
  // cleared the field.
  const handleStripsChange = (rawStrips: string) => {
    setStripsPerBox(rawStrips);
    setPackageSize(calculateStripBasedPackageSize(rawStrips, pillsPerStrip));
  };
  const handlePillsPerStripChange = (rawPills: string) => {
    setPillsPerStrip(rawPills);
    setPackageSize(calculateStripBasedPackageSize(stripsPerBox, rawPills));
  };
  const applyStockHelper = () => {
    const clamped = calculateStockHelperTotal(
      stripsPerBox,
      pillsPerStrip,
      helperBoxes,
      helperStrips,
      helperLoose
    );
    setCurrentPills(clamped);
    setCurrentPillsStr(String(clamped));
    setShowStockHelper(false);
  };
  const handleSubmit = async (e: FormEvent): Promise<boolean> => {
    e.preventDefault();
    if (!name.trim()) {
      setError('يرجى إدخال اسم الدواء');
      return false;
    }
    if (currentPills < 0) {
      setError('الكمية المتوفرة لا يمكن أن تكون سالبة');
      return false;
    }
    // Validate multi-dose schedule (amounts, times, uniqueness, length).
    // dailyDose for the existing engine = sum of schedule amounts.
    const scheduleResult = validateAndNormalizeDoseSchedule(dosesPerDay, doseSchedule);
    if (!scheduleResult.ok || !scheduleResult.schedule) {
      setError(scheduleResult.message || 'جدول الجرعات غير صالح');
      return false;
    }
    const doseNum = scheduleResult.dailyDose!;
    const normalizedSchedule = scheduleResult.schedule;
    // Calculate packaging — for non-solid types (e.g. liquid / مل),
    // strips and per-strip counts are completely irrelevant.
    // For solid types (pills/capsules), handle "no strips" (loose pills)
    // or standard strips.
    const { stripsPerBoxNum, pillsPerStripNum, calculatedPkgSize } = calculatePackageConfiguration({
      unit,
      noStrips,
      packageSize,
      stripsPerBox,
      pillsPerStrip,
    });
    // C1: when EDITING, preserve the live inventory (`currentPills`)
    // rather than letting the form overwrite it. Stock adjustments
    // must go through the RefillModal (+) or the "restore dose" flow
    // so auto-deductions and refill logs stay accurate. The form's
    // currentPills input is disabled in edit mode (see JSX below), so
    // this value equals initialData.currentPills at submit time — but
    // we pass it explicitly here to make the intent unambiguous and
    // guard against any future input-enable change.
    const isEditing = Boolean(initialData);
    const savedCurrentPills = isEditing && initialData
      ? initialData.currentPills
      : Number(currentPills);
    const parsedThreshold = parseInt(warningThresholdDays, 10);
    const savedWarningThreshold = !Number.isNaN(parsedThreshold) && parsedThreshold >= 1 ? parsedThreshold : 5;
    let finalDurationDays: number | undefined = undefined;
    if (!isChronic) {
      const dur = parseInt(durationDaysStr, 10);
      if (!Number.isInteger(dur) || dur <= 0 || dur > 3650) {
        setError('مدة الاستعمال يجب أن تكون من 1 إلى 3650 يوماً');
        return false;
      }
      finalDurationDays = dur;
    }
    const finalTreatmentStartDate = !isChronic
      ? (treatmentStartDateStr || initialData?.treatmentStartDate || '')
      : undefined;
    if (!isChronic && !finalTreatmentStartDate) {
      setError('تاريخ بداية الكورس غير محدد. اختر مدة محددة مرة أخرى لتعيين بداية العلاج.');
      return false;
    }
    const saved = await onSave(
      {
        name: name.trim(),
        currentPills: savedCurrentPills,
        dailyDose: doseNum,
        unit,
        warningThresholdDays: savedWarningThreshold,
        category: category.trim(),
        notes: initialData?.notes || '',
        colorTag,
        autoDeductEnabled,
        isChronic,
        durationDays: finalDurationDays,
        treatmentStartDate: finalTreatmentStartDate,
        stripsPerBox: stripsPerBoxNum,
        pillsPerStrip: pillsPerStripNum,
        packageSize: calculatedPkgSize,
        reminderEnabled,
        dosesPerDay: normalizedSchedule.length,
        doseSchedule: normalizedSchedule,
      },
      initialData ? initialData.id : undefined
    );
    return saved;
  };

  const previewDoseNum = totalDailyAmount(doseSchedule);
  const previewDays =
    previewDoseNum > 0 ? Math.floor(currentPills / previewDoseNum) : 0;

  return {
    name, setName, currentPills, currentPillsStr, setCurrentPills, setCurrentPillsStr,
    dosesPerDay, setDosesPerDay, doseSchedule, setDoseSchedule,
    unit, warningThresholdDays, setWarningThresholdDays, category, setCategory, colorTag, setColorTag,
    stripsPerBox, setStripsPerBox, pillsPerStrip, noStrips, setNoStrips,
    packageSize, packageSizeStr, setPackageSize, setPackageSizeStr,
    showStockHelper, setShowStockHelper,
    helperBoxes, helperStrips, helperLoose, setHelperBoxes, setHelperStrips, setHelperLoose, helperTotal,
    error, setError, reminderEnabled, setReminderEnabled, autoDeductEnabled, setAutoDeductEnabled,
    isChronic, setIsChronic, durationDaysStr, setDurationDaysStr, treatmentStartDateStr, setTreatmentStartDateStr,
    previewDays,
    handleUnitChange, handleStripsChange, handlePillsPerStripChange, applyStockHelper, handleSubmit,
  };
}
