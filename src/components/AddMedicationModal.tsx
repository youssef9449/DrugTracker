import { useState, useEffect, useMemo, type FC, type FormEvent } from 'react';
import { X, Pill, ShieldAlert, Check, Zap, Layers, Box, Calculator, Clock } from 'lucide-react';
import { Medication, MedicationDose, describeStockInStrips, formatTimeArabic, isSolidUnit } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  MAX_DOSES_PER_DAY,
  getDoseScheduleForUI,
  resizeDoseSchedule,
  totalDailyAmount,
  validateAndNormalizeDoseSchedule,
} from '../utils/doseSchedule';
import { CustomTimePicker } from './CustomTimePicker';
import { Toggle } from './ui/Toggle';
import { Modal } from './ui/Modal';
import { Checkbox } from './ui/Checkbox';

interface AddMedicationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => void;
  initialData?: Medication | null;
}

const COLOR_TAGS = [
  { id: 'teal', label: 'تيل', className: 'bg-teal-500' },
  { id: 'rose', label: 'وردي', className: 'bg-rose-500' },
  { id: 'amber', label: 'ذهبي', className: 'bg-amber-500' },
  { id: 'sky', label: 'سماوي', className: 'bg-sky-500' },
  { id: 'violet', label: 'بنفسجي', className: 'bg-violet-500' },
];

export const AddMedicationModal: FC<AddMedicationModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
}) => {
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
  // snapping it back to 0. Same pattern as packageSizeStr (PR #146).
  const [currentPillsStr, setCurrentPillsStr] = useState<string>('30');
  // Legacy single-field dailyDose is replaced in the UI by a multi-dose
  // schedule. dailyDose is still computed as the sum of schedule amounts
  // at save time so the existing auto-deduction engine is unchanged.
  const [dosesPerDay, setDosesPerDay] = useState<number>(1);
  const [doseSchedule, setDoseSchedule] = useState<MedicationDose[]>(() =>
    resizeDoseSchedule([], 1)
  );
  const [unit, setUnit] = useState('قرص');
  const [warningThresholdDays, setWarningThresholdDays] = useState<string>('5');
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
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
  const [helperBoxes, setHelperBoxes] = useState<number>(1);
  const [helperStrips, setHelperStrips] = useState<number>(0);
  const [helperLoose, setHelperLoose] = useState<number>(0);
  // #111: extracted from an inline IIFE — the stock-helper total.
  const helperTotal = useMemo(() => {
    const s = Math.max(1, parseInt(stripsPerBox, 10) || 1);
    const p = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
    return helperBoxes * (s * p) + helperStrips * p + helperLoose;
  }, [helperBoxes, helperStrips, helperLoose, stripsPerBox, pillsPerStrip]);
  const [error, setError] = useState('');

  const [reminderEnabled, setReminderEnabled] = useState<boolean>(false);
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
      // Multi-dose schedule: use stored schedule when present, otherwise
      // map legacy dailyDose + reminderTime to a single-dose row.
      const schedule = getDoseScheduleForUI(initialData);
      setDoseSchedule(schedule);
      setDosesPerDay(schedule.length);
      const initUnit = initialData.unit || 'قرص';
      setUnit(initUnit);
      setWarningThresholdDays(String(initialData.warningThresholdDays ?? 5));
      setCategory(initialData.category || '');
      setNotes(initialData.notes || '');
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
      setNotes('');
      setColorTag('teal');
      setStripsPerBox('3');
      setPillsPerStrip('10');
      setNoStrips(false);
      setPackageSize(30);
      setPackageSizeStr('30');
      setHelperBoxes(1);
      setHelperStrips(0);
      setHelperLoose(0);
      setReminderEnabled(false);
    }
    setShowStockHelper(false);
    setError('');
    // Intentionally only sync on the open transition (dep [isOpen]) — if
    // the parent passes a new initialData object reference while the
    // modal is already open, we must NOT reset the form (that would
    // blow away in-progress edits). The latest initialData is read from
    // the closure at the moment the modal opens (audit #93).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

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
    const s = Math.max(1, parseInt(rawStrips, 10) || 1);
    const p = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
    setPackageSize(s * p);
  };

  const handlePillsPerStripChange = (rawPills: string) => {
    setPillsPerStrip(rawPills);
    const s = Math.max(1, parseInt(stripsPerBox, 10) || 1);
    const p = Math.max(1, parseInt(rawPills, 10) || 1);
    setPackageSize(s * p);
  };

  const applyStockHelper = () => {
    const sBox = Math.max(1, parseInt(stripsPerBox, 10) || 1);
    const pStrip = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
    const boxSize = sBox * pStrip;
    const computed = helperBoxes * boxSize + helperStrips * pStrip + helperLoose;
    const clamped = Math.max(0, computed);
    setCurrentPills(clamped);
    setCurrentPillsStr(String(clamped));
    setShowStockHelper(false);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('يرجى إدخال اسم الدواء');
      return;
    }
    if (currentPills < 0) {
      setError('الكمية المتوفرة لا يمكن أن تكون سالبة');
      return;
    }
    // Validate multi-dose schedule (amounts, times, uniqueness, length).
    // dailyDose for the existing engine = sum of schedule amounts.
    const scheduleResult = validateAndNormalizeDoseSchedule(dosesPerDay, doseSchedule);
    if (!scheduleResult.ok || !scheduleResult.schedule) {
      setError(scheduleResult.message || 'جدول الجرعات غير صالح');
      return;
    }
    const doseNum = scheduleResult.dailyDose!;
    const normalizedSchedule = scheduleResult.schedule;
    const savedReminderTime = scheduleResult.reminderTime || '09:00';

    // Calculate packaging — for non-solid types (e.g. liquid / مل),
    // strips and per-strip counts are completely irrelevant.
    // For solid types (pills/capsules), handle "no strips" (loose pills)
    // or standard strips.
    const isSolid = isSolidUnit(unit);
    let stripsPerBoxNum: number | undefined;
    let pillsPerStripNum: number | undefined;
    let calculatedPkgSize: number;

    if (!isSolid) {
      stripsPerBoxNum = undefined;
      pillsPerStripNum = undefined;
      calculatedPkgSize = Math.max(1, packageSize || (unit === 'مل' ? 100 : 30));
    } else if (noStrips) {
      stripsPerBoxNum = undefined;
      pillsPerStripNum = undefined;
      calculatedPkgSize = Math.max(1, parseInt(stripsPerBox, 10) || packageSize || 30);
    } else {
      stripsPerBoxNum = Math.max(1, parseInt(stripsPerBox, 10) || 1);
      pillsPerStripNum = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
      calculatedPkgSize = stripsPerBoxNum * pillsPerStripNum;
    }

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

    onSave(
      {
        name: name.trim(),
        currentPills: savedCurrentPills,
        dailyDose: doseNum,
        unit,
        warningThresholdDays: Number(warningThresholdDays) || 5,
        category: category.trim(),
        notes: notes.trim(),
        colorTag,
        lastSyncDate: initialData?.lastSyncDate || getTodayDateString(),
        autoDeductEnabled: initialData?.autoDeductEnabled ?? true,
        stripsPerBox: stripsPerBoxNum,
        pillsPerStrip: pillsPerStripNum,
        packageSize: calculatedPkgSize,
        reminderEnabled,
        // Phase-1 compat: single reminderTime remains the earliest dose
        // so existing notification scheduling is unchanged.
        reminderTime: savedReminderTime,
        dosesPerDay: normalizedSchedule.length,
        doseSchedule: normalizedSchedule,
      },
      initialData ? initialData.id : undefined
    );
    onClose();
  };

  // Preview days from total daily consumption (sum of schedule amounts).
  const previewDoseNum = totalDailyAmount(doseSchedule);
  const previewDays =
    previewDoseNum > 0 ? Math.floor(currentPills / previewDoseNum) : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      label={initialData ? 'تعديل بيانات الدواء' : 'إضافة دواء جديد'}
    >
      <div
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
        dir="rtl"
      >
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-teal-700 flex items-center justify-center">
              <Pill className="w-4 h-4 text-teal-100" />
            </div>
            <h3 className="font-bold text-base">
              {initialData ? 'تعديل بيانات الدواء' : 'إضافة دواء جديد لمتابعة استهلاكه'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-teal-200 hover:text-white hover:bg-teal-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="p-2.5 bg-teal-50 border border-teal-100 rounded-xl text-xs text-teal-900 flex items-center gap-2">
            <Zap className="w-4 h-4 text-teal-600 shrink-0" />
            <span>سيتولى التطبيق خصم الاستهلاك تلقائياً بمرور الأيام دون الحاجة لتسجيل يومي يدوي!</span>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              اسم الدواء <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: بانادول إكسترا، كونكور 5مجم..."
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
            />
          </div>

          <div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  {unit === 'مل'
                    ? 'الكمية المتوفرة حالياً (مل)'
                    : isSolidUnit(unit)
                    ? 'عدد الحبوب المتوفرة حالياً'
                    : `الكمية المتوفرة حالياً (${unit})`}{' '}
                  {initialData ? (
                    <span className="text-slate-400 font-normal">(للتعديل استخدم تعبئة الرصيد)</span>
                  ) : (
                    <span className="text-red-500">*</span>
                  )}
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={currentPillsStr}
                  // C1: stock adjustments on an EXISTING medication must go
                  // through the RefillModal (+) or the "restore dose" flow,
                  // not the edit form — otherwise the form overwrites the
                  // live inventory (which may have been auto-deducted) and
                  // loses deductions. Disabled here on edit; the value is
                  // shown for reference only.
                  disabled={Boolean(initialData)}
                  onChange={(e) => {
                    // Store the raw string so the field can be cleared
                    // mid-edit (select-all → delete) instead of snapping
                    // back to 0 like the old `Math.max(0, parseInt || 0)`.
                    const raw = e.target.value;
                    setCurrentPillsStr(raw);
                    const parsed = parseInt(raw, 10);
                    if (!isNaN(parsed) && parsed >= 0) {
                      setCurrentPills(parsed);
                    }
                    // If empty/invalid, leave currentPills at its previous
                    // value — the submit handler falls back to it.
                  }}
                  className={`w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white ${
                    initialData ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">نوع الوحدة</label>
                <select
                  value={unit}
                  onChange={(e) => handleUnitChange(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                >
                  <option value="قرص">قرص (حبّة)</option>
                  <option value="كبسولة">كبسولة</option>
                  <option value="مل">مل (دواء شرب / شراب)</option>
                  <option value="جرعة">جرعة (بخاخ / قطرة / حقنة)</option>
                  <option value="كيس">كيس (فوار / بودرة)</option>
                </select>
              </div>
            </div>

            {/* C1: hide the stock helper in edit mode AND for non-pill
                types (liquid, dose, sachet — strips don't apply). */}
            {!initialData && isSolidUnit(unit) && (
              <div className="mt-1.5 flex items-center justify-between flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setShowStockHelper(!showStockHelper)}
                  className="text-[11px] text-teal-700 hover:text-teal-900 font-bold flex items-center gap-1 transition"
                >
                  <Calculator className="w-3 h-3 text-teal-600" />
                  <span>{showStockHelper ? 'إخفاء حاسبة الأشرطة' : 'احسب من العلب والأشرطة المتوفرة'}</span>
                </button>
                {/* Hide "يعادل" when noStrips is selected — strips info is
                    meaningless for loose-pill medications. */}
                {!noStrips && describeStockInStrips(currentPills, parseInt(pillsPerStrip, 10) || 10, parseInt(stripsPerBox, 10) || 3, unit) && (
                  <span className="text-[11px] text-teal-800 font-medium bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60">
                    يعادل: {describeStockInStrips(currentPills, parseInt(pillsPerStrip, 10) || 10, parseInt(stripsPerBox, 10) || 3, unit)}
                  </span>
                )}
              </div>
            )}

            {showStockHelper && (
              <div className="mt-2 p-3 bg-teal-50/70 border border-teal-200 rounded-xl space-y-2">
                <p className="text-[11px] font-bold text-teal-950">
                  حساب الرصيد بدلالة العلب والأشرطة الموجودة في الصيدلية المنزلية:
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-600 mb-0.5">علب كاملة</label>
                    <input
                      type="number"
                      min="0"
                      value={helperBoxes}
                      onChange={(e) => setHelperBoxes(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center focus:ring-1 focus:ring-teal-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600 mb-0.5">أشرطة إضافية</label>
                    <input
                      type="number"
                      min="0"
                      value={helperStrips}
                      onChange={(e) => setHelperStrips(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center focus:ring-1 focus:ring-teal-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-600 mb-0.5">حبات فَرط</label>
                    <input
                      type="number"
                      min="0"
                      value={helperLoose}
                      onChange={(e) => setHelperLoose(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center focus:ring-1 focus:ring-teal-500"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-[11px] text-teal-900 font-mono">
                    المجموع = {helperTotal} {unit}
                  </span>
                  <button
                    type="button"
                    onClick={applyStockHelper}
                    className="px-2.5 py-1 bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-bold rounded-lg transition active:scale-95"
                  >
                    تطبيق على الرصيد
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* مواصفات العلبة — only shown for pill/capsule types.
              For liquid (مل), dose (جرعة), or sachet (كيس), strips
              and per-box pill count don't make sense; the user just
              enters the package size directly. */}
          {isSolidUnit(unit) && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-800">مواصفات العلبة</h4>
              </div>
            </div>

            {/* "بدون أشرطة" toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Checkbox
                checked={noStrips}
                onChange={(e) => setNoStrips(e.target.checked)}
                aria-label="بدون أشرطة (أقراص فرط في العلبة)"
              />
              <span className="text-[11px] font-bold text-slate-700">
                بدون أشرطة (أقراص فرط في العلبة)
              </span>
            </label>

            {noStrips ? (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  عدد الأقراص في العلبة
                </label>
                <input
                  type="number"
                  min="1"
                  max="100000"
                  inputMode="numeric"
                  step="any"
                  value={stripsPerBox}
                  onChange={(e) => {
                    setStripsPerBox(e.target.value);
                    const v = Math.max(1, parseInt(e.target.value, 10) || 30);
                    setPackageSize(v);
                  }}
                  placeholder="مثال: 15"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
                <div className="mt-1.5 text-xs bg-white p-2 rounded-xl border border-teal-200/80 flex items-center gap-1.5">
                  <Box className="w-3.5 h-3.5 text-teal-600" />
                  <span className="text-slate-600 font-medium">حجم العلبة:</span>
                  <span className="font-bold text-teal-900 font-mono">
                    {packageSize} {unit}
                  </span>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">عدد الأشرطة في العلبة</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    inputMode="numeric"
                    step="any"
                    value={stripsPerBox}
                    onChange={(e) => handleStripsChange(e.target.value)}
                    placeholder="مثال: 3"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">عدد الحبوب في الشريط</label>
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    inputMode="numeric"
                    step="any"
                    value={pillsPerStrip}
                    onChange={(e) => handlePillsPerStripChange(e.target.value)}
                    placeholder="مثال: 10"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
                </div>
              </div>
            )}

            {!noStrips && (
              <div className="flex items-center justify-between text-xs bg-white p-2 rounded-xl border border-teal-200/80">
                <span className="text-slate-600 font-medium flex items-center gap-1.5">
                  <Box className="w-3.5 h-3.5 text-teal-600" />
                  <span>حجم العلبة الكلي:</span>
                </span>
                <span className="font-bold text-teal-900 font-mono">
                  {packageSize} {unit}{' '}
                  <span className="text-[10px] text-slate-500 font-normal">
                    ({stripsPerBox || '—'} أشرطة × {pillsPerStrip || '—'} {unit})
                  </span>
                </span>
              </div>
            )}
          </div>
          )}

          {/* For liquid/dose/sachet: just show a package size field. */}
          {!isSolidUnit(unit) && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center">
                <Box className="w-3.5 h-3.5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-800">
                  {unit === 'مل' ? 'حجم زجاجة/عبوة الدواء' : 'حجم العبوة'}
                </h4>
                <p className="text-[10px] text-slate-500">
                  {unit === 'مل'
                    ? 'سعة الزجاجة بالملل لحساب عدد العبوات المطلوبة عند الشراء والتعبئة'
                    : `سعة العبوة الواحدة بـ (${unit})`}
                </p>
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                حجم العبوة ({unit})
              </label>
              <input
                type="number"
                min="1"
                max="100000"
                inputMode="numeric"
                step="any"
                value={packageSizeStr}
                onChange={(e) => {
                  // Store the raw string so the field can be cleared
                  // mid-edit (select-all → delete) instead of snapping
                  // back to "1" like the old `Math.max(1, parseInt || 1)`.
                  // The numeric packageSize is parsed here and also
                  // re-parsed at save time as a safety net.
                  const raw = e.target.value;
                  setPackageSizeStr(raw);
                  const parsed = parseInt(raw, 10);
                  if (!isNaN(parsed) && parsed > 0) {
                    setPackageSize(parsed);
                  }
                  // If empty/invalid, leave packageSize at its previous
                  // value — the save handler falls back to a sensible
                  // default (line: `packageSize || (unit === 'مل' ? 100 : 30)`).
                }}
                placeholder={unit === 'مل' ? 'مثال: 100 أو 120 مل' : 'مثال: 30'}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>
          </div>
          )}

          {/* Multi-dose count + warning threshold */}
          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="min-w-0">
              <label className="block text-xs font-bold text-slate-700 mb-1.5 leading-snug">
                عدد مرات تناول الدواء يومياً <span className="text-red-500">*</span>
              </label>
              <select
                value={dosesPerDay}
                onChange={(e) => {
                  const n = Math.max(
                    1,
                    Math.min(MAX_DOSES_PER_DAY, parseInt(e.target.value, 10) || 1)
                  );
                  setDosesPerDay(n);
                  setDoseSchedule((prev) => resizeDoseSchedule(prev, n));
                }}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              >
                {Array.from({ length: MAX_DOSES_PER_DAY }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="block text-xs font-bold text-slate-700 mb-1.5 leading-snug">
                التنبيه قبل النفاذ (أيام)
              </label>
              <input
                type="number"
                min="1"
                max="100000"
                inputMode="numeric"
                value={warningThresholdDays}
                onChange={(e) => setWarningThresholdDays(e.target.value)}
                placeholder="مثال: 5"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">التصنيف (اختياري)</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="ضغط، سكري، فيتامينات..."
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">لون البطاقة</label>
              <div className="flex items-center gap-1.5 h-[42px]">
                {COLOR_TAGS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    title={c.label}
                    onClick={() => setColorTag(c.id)}
                    className={`w-7 h-7 rounded-full ${c.className} ${
                      colorTag === c.id ? 'ring-2 ring-offset-2 ring-slate-700 scale-110' : 'opacity-70'
                    } transition`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">ملاحظات الجرعة (اختياري)</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="مثال: بعد الإفطار، مع اللبن..."
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Clock className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <h4 className="text-xs font-bold text-slate-800">
                  جدول الجرعات اليومية <span className="text-red-500">*</span>
                </h4>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                  حدد كمية وميعاد كل جرعة. الإجمالي اليومي يُحسب تلقائياً.
                </p>
              </div>
            </div>

            {doseSchedule.map((dose, index) => (
              <div
                key={dose.id}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2"
              >
                <div className="text-xs font-bold text-slate-700">الجرعة {index + 1}</div>
                <div className="grid grid-cols-2 gap-2 items-start">
                  <div className="min-w-0">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      الكمية ({unit})
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={Number.isFinite(Number(dose.amount)) ? dose.amount : ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const parsed = parseFloat(raw);
                        setDoseSchedule((prev) =>
                          prev.map((d, i) =>
                            i === index
                              ? {
                                  ...d,
                                  amount: raw.trim() === '' || isNaN(parsed) ? 0 : parsed,
                                }
                              : d
                          )
                        );
                      }}
                      placeholder="مثال: 1"
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                    />
                  </div>
                  <div className="min-w-0">
                    <label className="block text-[11px] font-bold text-slate-600 mb-1">
                      الميعاد
                    </label>
                    <CustomTimePicker
                      value={dose.time}
                      onChange={(time) => {
                        setDoseSchedule((prev) =>
                          prev.map((d, i) => (i === index ? { ...d, time } : d))
                        );
                      }}
                    />
                    <div className="text-[11px] text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 text-center font-bold mt-1">
                      {formatTimeArabic(dose.time) || 'اختر الوقت'}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            <div className="text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 flex items-center justify-between">
              <span>إجمالي الاستهلاك اليومي</span>
              <span className="font-bold text-teal-800 font-mono">
                {totalDailyAmount(doseSchedule) || 0} {unit}
              </span>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
              <span className="text-xs font-bold text-slate-700 leading-snug">
                تفعيل اشعار التنبيه بالجرعة
              </span>
              <Toggle
                checked={reminderEnabled}
                onChange={() => setReminderEnabled(!reminderEnabled)}
                label="تفعيل اشعار التنبيه بالجرعة"
                size="md"
              />
            </div>
          </div>

          {/* Per-medication sound selector removed — all dose reminders
              now use the single native channel sound. */}


          <div className="p-3 bg-white border border-slate-200 rounded-xl text-xs flex items-center justify-between">
            <span className="text-slate-600">يكفي تقريباً لمدة:</span>
            <span className="font-bold text-teal-800 font-mono">{previewDays} يوماً</span>
          </div>

          <button
            type="submit"
            className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition"
          >
            <Check className="w-4 h-4" />
            <span>{initialData ? 'حفظ التعديلات' : 'إضافة الدواء'}</span>
          </button>
        </form>
      </div>
    </Modal>
  );
};
