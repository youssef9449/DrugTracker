import { useState, useEffect, type FC, type FormEvent } from 'react';
import { X, Pill, ShieldAlert, Check, Zap, Layers, Box, Calculator, Bell, Clock, Volume2 } from 'lucide-react';
import { Medication, describeStockInStrips, NotificationSoundType, formatTimeArabic } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  NOTIFICATION_SOUND_OPTIONS,
  playNotificationSound,
} from '../utils/sound';
import { CustomTimePicker } from './CustomTimePicker';

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
  const [dailyDose, setDailyDose] = useState<string>('1');
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
  const [error, setError] = useState('');

  const [reminderEnabled, setReminderEnabled] = useState<boolean>(false);
  const [reminderTime, setReminderTime] = useState<string>('09:00');
  const [notificationSound, setNotificationSound] = useState<NotificationSoundType>('classic_chime');
  // Toggle for medications that come as loose pills in a box without
  // strips (e.g., Coffiram — 15 pills per box, no blister strips).
  // When enabled, the strip fields are hidden and the user just
  // enters the total pills per box.
  const [noStrips, setNoStrips] = useState<boolean>(false);

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setCurrentPills(initialData.currentPills);
      // Convert numeric initial values to STRING state for the
      // number inputs (see comment on dailyDose declaration above).
      setDailyDose(String(initialData.dailyDose ?? ''));
      setUnit(initialData.unit || 'قرص');
      setWarningThresholdDays(String(initialData.warningThresholdDays ?? 5));
      setCategory(initialData.category || '');
      setNotes(initialData.notes || '');
      setColorTag(initialData.colorTag || 'teal');
      // Detect "no strips" medications — if stripsPerBox or pillsPerStrip
      // is null/0/undefined, treat as loose pills (e.g., Coffiram 15
      // pills per box, no blister strips).
      const hasStrips = initialData.stripsPerBox && initialData.pillsPerStrip && initialData.stripsPerBox > 0 && initialData.pillsPerStrip > 0;
      setNoStrips(!hasStrips);
      // #14: in noStrips mode the "عدد الأقراص في العلبة" input reuses
      // the `stripsPerBox` state (it's the only pills-per-box field).
      // Previously this initialized `stripsPerBox` from
      // `initialData.stripsPerBox || 3`, which for a noStrips med (where
      // stripsPerBox is undefined) fell back to 3 — so the input showed
      // "3" instead of the actual packageSize (e.g. 15), and on save
      // `parseInt('3')` truthy-overrode packageSize in handleSubmit,
      // silently rewriting 15 → 3. Now: for noStrips meds initialize
      // stripsPerBox from packageSize; for strips meds use the real
      // stripsPerBox/pillsPerStrip.
      if (hasStrips) {
        setStripsPerBox(String(initialData.stripsPerBox));
        setPillsPerStrip(String(initialData.pillsPerStrip));
        setPackageSize(initialData.packageSize || initialData.stripsPerBox * initialData.pillsPerStrip!);
      } else {
        setStripsPerBox(String(initialData.packageSize || 30));
        setPillsPerStrip(String(initialData.pillsPerStrip || 10));
        setPackageSize(initialData.packageSize || 30);
      }
      setReminderEnabled(Boolean(initialData.reminderEnabled));
      setReminderTime(initialData.reminderTime || '09:00');
      setNotificationSound(initialData.notificationSound || 'classic_chime');
    } else {
      setName('');
      setCurrentPills(30);
      setDailyDose('1');
      setUnit('قرص');
      setWarningThresholdDays('5');
      setCategory('');
      setNotes('');
      setColorTag('teal');
      setStripsPerBox('3');
      setPillsPerStrip('10');
      setNoStrips(false);
      setPackageSize(30);
      setHelperBoxes(1);
      setHelperStrips(0);
      setHelperLoose(0);
      setReminderEnabled(false);
      setReminderTime('09:00');
      setNotificationSound('classic_chime');
    }
    setShowStockHelper(false);
    setError('');
  }, [initialData, isOpen]);

  if (!isOpen) return null;

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
    setCurrentPills(Math.max(0, computed));
    setShowStockHelper(false);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('يرجى إدخال اسم الدواء');
      return;
    }
    if (currentPills < 0) {
      setError('عدد الحبوب لا يمكن أن يكون سالباً');
      return;
    }
    // Convert the string-typed dailyDose to a number for validation
    // + save. We need to handle the empty string case explicitly
    // (NaN fails the > 0 check, but we want a clearer error message).
    const doseNum = parseFloat(dailyDose);
    if (dailyDose.trim() === '' || isNaN(doseNum)) {
      setError('يرجى إدخال معدل الاستهلاك اليومي');
      return;
    }
    if (doseNum <= 0) {
      setError('معدل الاستهلاك يجب أن يكون أكبر من صفر');
      return;
    }
    if (reminderEnabled && !reminderTime) {
      setError('اختر وقت التذكير اليومي');
      return;
    }

    // Calculate packaging — handle "no strips" medications (loose
    // pills in a box, e.g., Coffiram 15 pills per box without blister
    // strips). When noStrips is true, stripsPerBox and pillsPerStrip
    // are set to undefined and packageSize is used directly.
    let stripsPerBoxNum: number | undefined;
    let pillsPerStripNum: number | undefined;
    let calculatedPkgSize: number;

    if (noStrips) {
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
    const savedCurrentPills = isEditing
      ? initialData!.currentPills
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
        reminderTime: reminderEnabled ? reminderTime : undefined,
        // Per-medication sound is a synthesized tone only (classic_chime,
        // marimba, ...). Custom sound files are a GLOBAL setting uploaded
        // via the AppHeader and apply to all notifications — not stored
        // per-medication (see H3 in the audit fix).
        notificationSound: reminderEnabled ? notificationSound : 'classic_chime',
      },
      initialData ? initialData.id : undefined
    );
    onClose();
  };

  // Compute previewDays from the string-typed dailyDose. We parse
  // it to a number here; if the user hasn't typed anything valid yet
  // (empty string or NaN), we just show 0 days.
  const previewDoseNum = parseFloat(dailyDose);
  const previewDays =
    !isNaN(previewDoseNum) && previewDoseNum > 0
      ? Math.floor(currentPills / previewDoseNum)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs">
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
                  عدد الحبوب المتوفرة حالياً{' '}
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
                  value={currentPills}
                  // C1: stock adjustments on an EXISTING medication must go
                  // through the RefillModal (+) or the "restore dose" flow,
                  // not the edit form — otherwise the form overwrites the
                  // live inventory (which may have been auto-deducted) and
                  // loses deductions. Disabled here on edit; the value is
                  // shown for reference only.
                  disabled={Boolean(initialData)}
                  onChange={(e) => setCurrentPills(Math.max(0, parseInt(e.target.value) || 0))}
                  className={`w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white ${
                    initialData ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">نوع الوحدة</label>
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                >
                  <option value="قرص">قرص (حبّة)</option>
                  <option value="كبسولة">كبسولة</option>
                  <option value="مل">مل (شراب)</option>
                  <option value="جرعة">جرعة</option>
                  <option value="كيس">كيس فوار</option>
                </select>
              </div>
            </div>

            {/* C1: hide the stock helper in edit mode — it would change
                currentPills, but on edit the save preserves the live
                inventory (initialData.currentPills) and the input is
                disabled, so the helper's value wouldn't be saved. */}
            {!initialData && (
              <div className="mt-1.5 flex items-center justify-between flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setShowStockHelper(!showStockHelper)}
                  className="text-[11px] text-teal-700 hover:text-teal-900 font-bold flex items-center gap-1 transition"
                >
                  <Calculator className="w-3 h-3 text-teal-600" />
                  <span>{showStockHelper ? 'إخفاء حاسبة الأشرطة' : 'احسب من العلب والأشرطة المتوفرة'}</span>
                </button>
                {describeStockInStrips(currentPills, parseInt(pillsPerStrip, 10) || 10, parseInt(stripsPerBox, 10) || 3, unit) && (
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
                    المجموع = {(() => {
                      const s = Math.max(1, parseInt(stripsPerBox, 10) || 1);
                      const p = Math.max(1, parseInt(pillsPerStrip, 10) || 1);
                      return helperBoxes * (s * p) + helperStrips * p + helperLoose;
                    })()} {unit}
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

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-800">مواصفات العلبة</h4>
                <p className="text-[10px] text-slate-500">تحديد عدد الأقراص لطلب علب صحيحة من الصيدلية</p>
              </div>
            </div>

            {/* "بدون أشرطة" toggle — for medications like Coffiram that
                come as loose pills in a box without blister strips.
                When on, hide the strip-count fields and show just a
                single "عدد الأقراص في العلبة" input. */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={noStrips}
                onChange={(e) => setNoStrips(e.target.checked)}
                className="w-4 h-4 accent-teal-600"
              />
              <span className="text-[11px] font-bold text-slate-700">
                بدون أشرطة (أقراص فرط في العلبة)
              </span>
            </label>

            {noStrips ? (
              /* No strips — just enter total pills per box */
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  عدد الأقراص في العلبة
                </label>
                <input
                  type="number"
                  min="1"
                  max="500"
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
              /* With strips — show both strip fields */
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
                    max="100"
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                الاستهلاك اليومي التلقائي <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0"
                // Use step="any" instead of step="0.5" so the browser
                // doesn't show the "please enter a valid value. The
                // two nearest valid values are 0.75 and 1.25" error
                // when the user types integers like 1, 2, 3, etc.
                // (with step="0.5" + min="0.25", typing "1" produces
                // that browser-native error because 1 - 0.25 = 0.75,
                // not a multiple of 0.5). Validation is done in
                // handleSubmit instead.
                step="any"
                inputMode="decimal"
                value={dailyDose}
                // Use a string-typed state so the user can clear the
                // field and type a fresh value. The submit handler
                // parses it back to a number with proper validation
                // (empty / NaN / <= 0).
                onChange={(e) => setDailyDose(e.target.value)}
                placeholder="مثال: 1"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">التنبيه قبل النفاذ بـ</label>
              <input
                type="number"
                min="1"
                max="30"
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

          <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-2xl space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <div className="w-8 h-8 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
                  <Bell className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-amber-950">إشعار يومي بميعاد تحدده أنت</h4>
                  <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                    فعّل التذكير واختر الساعة التي تريد سماع التنبيه فيها كل يوم.
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={reminderEnabled}
                onClick={() => setReminderEnabled(!reminderEnabled)}
                className={`w-11 h-6 rounded-full relative transition shrink-0 ${
                  reminderEnabled ? 'bg-teal-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition ${
                    reminderEnabled ? 'right-0.5' : 'right-[22px]'
                  }`}
                />
              </button>
            </div>

            {reminderEnabled && (
              <div className="space-y-2 pt-1 border-t border-amber-200/80">
                <label className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  <span>وقت التذكير اليومي</span>
                </label>
                {/* Custom time picker (replaces the native <input type="time">
                    which on Android shows the OS time picker with default
                    Material colors — text invisible in AM/PM dropdown due
                    to the OS using the system theme color for the option
                    text against a same-color background). We use 3
                    theme-styled <select> dropdowns instead: hour (1-12),
                    minute (00-59), and AM/PM. The selected value is
                    converted to/from 24-hour "HH:MM" format used by
                    reminderTime state. */}
                <CustomTimePicker
                  value={reminderTime}
                  onChange={setReminderTime}
                />
                <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 text-center font-bold">
                  {formatTimeArabic(reminderTime) || 'اختر الوقت'}
                </div>
              </div>
            )}
          </div>

          {/* Per-medication synthesized sound selector — only shown
              when reminder is enabled. The "custom file" option was
              removed because custom sound is now a GLOBAL setting
              (uploaded via AppHeader, applies to all medications).
              Each medication still gets its own synthesized tone
              (classic_chime, marimba, etc.). */}
          {reminderEnabled && (
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
              <div className="flex items-start gap-2">
                <div className="w-8 h-8 rounded-xl bg-teal-100 text-teal-800 flex items-center justify-center shrink-0">
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800">نغمة تنبيه هذا الدواء</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                    اختر نغمة مختلفة لكل دواء حتى تميّز التنبيه من غير ما تشوف الشاشة.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {NOTIFICATION_SOUND_OPTIONS.filter((opt) => opt.id !== 'custom').map((opt) => {
                  const selected = notificationSound === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setNotificationSound(opt.id);
                        playNotificationSound(opt.id);
                      }}
                      className={`text-right p-2.5 rounded-xl border transition ${
                        selected
                          ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                          : 'bg-white text-slate-700 border-slate-200 hover:border-teal-300 hover:bg-teal-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-base">{opt.icon}</span>
                        {selected && <Volume2 className="w-3.5 h-3.5" />}
                      </div>
                      <div className="text-[11px] font-bold mt-1">{opt.name}</div>
                      <div className={`text-[10px] mt-0.5 ${selected ? 'text-teal-100' : 'text-slate-500'}`}>
                        {opt.description}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="text-[10px] text-slate-500 bg-teal-50/50 border border-teal-200/60 rounded-lg px-2 py-1.5">
                💡 لاستخدام ملف صوتي مخصص من جهازك، اضغط على أيقونة الصوت في الشريط العلوي وارفع ملفك هناك — الصوت المخصص يُطبّق على كل الأدوية.
              </div>
            </div>
          )}

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
    </div>
  );
};
