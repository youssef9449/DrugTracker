import React, { useState, useEffect } from 'react';
import { X, Pill, ShieldAlert, Check, Zap, Layers, Box, Calculator, Bell, Clock, Volume2, FileAudio, Trash2 } from 'lucide-react';
import { Medication, describeStockInStrips, NotificationSoundType, CustomSoundFile, formatTimeArabic } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import {
  NOTIFICATION_SOUND_OPTIONS,
  playNotificationSound,
  readCustomSoundFile,
  CUSTOM_SOUND_ACCEPTED_MIME,
  CUSTOM_SOUND_MAX_BYTES,
} from '../utils/sound';

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

export const AddMedicationModal: React.FC<AddMedicationModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialData,
}) => {
  const [name, setName] = useState('');
  const [currentPills, setCurrentPills] = useState<number>(30);
  const [dailyDose, setDailyDose] = useState<number>(1);
  const [unit, setUnit] = useState('قرص');
  const [warningThresholdDays, setWarningThresholdDays] = useState<number>(5);
  const [category, setCategory] = useState('');
  const [notes, setNotes] = useState('');
  const [colorTag, setColorTag] = useState('teal');
  const [stripsPerBox, setStripsPerBox] = useState<number>(3);
  const [pillsPerStrip, setPillsPerStrip] = useState<number>(10);
  const [packageSize, setPackageSize] = useState<number>(30);
  const [showStockHelper, setShowStockHelper] = useState(false);
  const [helperBoxes, setHelperBoxes] = useState<number>(1);
  const [helperStrips, setHelperStrips] = useState<number>(0);
  const [helperLoose, setHelperLoose] = useState<number>(0);
  const [error, setError] = useState('');

  const [reminderEnabled, setReminderEnabled] = useState<boolean>(false);
  const [reminderTime, setReminderTime] = useState<string>('09:00');
  const [notificationSound, setNotificationSound] = useState<NotificationSoundType>('classic_chime');
  const [customSoundEnabled, setCustomSoundEnabled] = useState<boolean>(false);
  const [customSoundFile, setCustomSoundFile] = useState<CustomSoundFile | null>(null);
  const [isUploadingSound, setIsUploadingSound] = useState<boolean>(false);

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setCurrentPills(initialData.currentPills);
      setDailyDose(initialData.dailyDose);
      setUnit(initialData.unit || 'قرص');
      setWarningThresholdDays(initialData.warningThresholdDays || 5);
      setCategory(initialData.category || '');
      setNotes(initialData.notes || '');
      setColorTag(initialData.colorTag || 'teal');
      const sBox = initialData.stripsPerBox || 3;
      const pStrip = initialData.pillsPerStrip || 10;
      setStripsPerBox(sBox);
      setPillsPerStrip(pStrip);
      setPackageSize(initialData.packageSize || sBox * pStrip);
      setReminderEnabled(Boolean(initialData.reminderEnabled));
      setReminderTime(initialData.reminderTime || '09:00');
      setNotificationSound(initialData.notificationSound || 'classic_chime');
      setCustomSoundEnabled(Boolean(initialData.notificationSound));
      setCustomSoundFile(initialData.customSoundFile || null);
    } else {
      setName('');
      setCurrentPills(30);
      setDailyDose(1);
      setUnit('قرص');
      setWarningThresholdDays(5);
      setCategory('');
      setNotes('');
      setColorTag('teal');
      setStripsPerBox(3);
      setPillsPerStrip(10);
      setPackageSize(30);
      setHelperBoxes(1);
      setHelperStrips(0);
      setHelperLoose(0);
      setReminderEnabled(false);
      setReminderTime('09:00');
      setNotificationSound('classic_chime');
      setCustomSoundEnabled(false);
      setCustomSoundFile(null);
    }
    setShowStockHelper(false);
    setError('');
    setIsUploadingSound(false);
  }, [initialData, isOpen]);

  if (!isOpen) return null;

  const handleStripsChange = (newStrips: number) => {
    const s = Math.max(1, newStrips);
    setStripsPerBox(s);
    setPackageSize(s * pillsPerStrip);
  };

  const handlePillsPerStripChange = (newPills: number) => {
    const p = Math.max(1, newPills);
    setPillsPerStrip(p);
    setPackageSize(stripsPerBox * p);
  };

  const applyStockHelper = () => {
    const boxSize = stripsPerBox * pillsPerStrip;
    const computed = helperBoxes * boxSize + helperStrips * pillsPerStrip + helperLoose;
    setCurrentPills(Math.max(0, computed));
    setShowStockHelper(false);
  };

  // File picker handler — uses an <input type="file"> with accept="audio/*"
  // to let the user pick any audio file from their mobile device. Reads
  // the file as a base64 data URL and stores it in component state.
  const handleCustomSoundFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input value so the same file can be re-picked later if needed.
    event.target.value = '';
    if (!file) return;

    setIsUploadingSound(true);
    setError('');
    try {
      const customFile = await readCustomSoundFile(file);
      setCustomSoundFile(customFile);
      setNotificationSound('custom');
      setCustomSoundEnabled(true);
      // Immediately preview the selected file.
      playNotificationSound('custom', customFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'تعذّر تحميل الملف الصوتي';
      setError(message);
    } finally {
      setIsUploadingSound(false);
    }
  };

  const handleRemoveCustomSound = () => {
    setCustomSoundFile(null);
    setNotificationSound('classic_chime');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('يرجى إدخال اسم الدواء');
      return;
    }
    if (currentPills < 0) {
      setError('عدد الحبوب لا يمكن أن يكون سالباً');
      return;
    }
    if (dailyDose <= 0) {
      setError('معدل الاستهلاك يجب أن يكون أكبر من صفر');
      return;
    }
    if (reminderEnabled && !reminderTime) {
      setError('اختر وقت التذكير اليومي');
      return;
    }
    if (notificationSound === 'custom' && !customSoundFile) {
      setError('اختر ملفاً صوتياً أو عُد إلى إحدى النغمات الافتراضية');
      return;
    }

    const calculatedPkgSize =
      stripsPerBox > 0 && pillsPerStrip > 0 ? stripsPerBox * pillsPerStrip : Number(packageSize) || 30;

    onSave(
      {
        name: name.trim(),
        currentPills: Number(currentPills),
        dailyDose: Number(dailyDose),
        unit,
        warningThresholdDays: Number(warningThresholdDays) || 5,
        category: category.trim(),
        notes: notes.trim(),
        colorTag,
        lastSyncDate: initialData?.lastSyncDate || getTodayDateString(),
        autoDeductEnabled: initialData?.autoDeductEnabled ?? true,
        stripsPerBox: Number(stripsPerBox) || 3,
        pillsPerStrip: Number(pillsPerStrip) || 10,
        packageSize: calculatedPkgSize,
        reminderEnabled,
        reminderTime: reminderEnabled ? reminderTime : undefined,
        notificationSound: customSoundEnabled || reminderEnabled ? notificationSound : 'classic_chime',
        customSoundFile:
          notificationSound === 'custom' && customSoundFile ? customSoundFile : undefined,
      },
      initialData ? initialData.id : undefined
    );
    onClose();
  };

  const previewDays = dailyDose > 0 ? Math.floor(currentPills / dailyDose) : 0;

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
                  عدد الحبوب المتوفرة حالياً <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={currentPills}
                  onChange={(e) => setCurrentPills(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
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

            <div className="mt-1.5 flex items-center justify-between flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setShowStockHelper(!showStockHelper)}
                className="text-[11px] text-teal-700 hover:text-teal-900 font-bold flex items-center gap-1 transition"
              >
                <Calculator className="w-3 h-3 text-teal-600" />
                <span>{showStockHelper ? 'إخفاء حاسبة الأشرطة' : 'احسب من العلب والأشرطة المتوفرة'}</span>
              </button>
              {describeStockInStrips(currentPills, pillsPerStrip, stripsPerBox, unit) && (
                <span className="text-[11px] text-teal-800 font-medium bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60">
                  يعادل: {describeStockInStrips(currentPills, pillsPerStrip, stripsPerBox, unit)}
                </span>
              )}
            </div>

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
                    المجموع = {helperBoxes * (stripsPerBox * pillsPerStrip) + helperStrips * pillsPerStrip + helperLoose} {unit}
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
                <h4 className="text-xs font-bold text-slate-800">مواصفات العلبة والأشرطة</h4>
                <p className="text-[10px] text-slate-500">تحديد عدد الأشرطة والحبوب لطلب علب صحيحة من الصيدلية</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">عدد الأشرطة في العلبة</label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={stripsPerBox}
                  onChange={(e) => handleStripsChange(parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">عدد الحبوب في الشريط</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={pillsPerStrip}
                  onChange={(e) => handlePillsPerStripChange(parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-xs bg-white p-2 rounded-xl border border-teal-200/80">
              <span className="text-slate-600 font-medium flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5 text-teal-600" />
                <span>حجم العلبة الكلي:</span>
              </span>
              <span className="font-bold text-teal-900 font-mono">
                {packageSize} {unit}{' '}
                <span className="text-[10px] text-slate-500 font-normal">
                  ({stripsPerBox} أشرطة × {pillsPerStrip} {unit})
                </span>
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                الاستهلاك اليومي التلقائي <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                min="0.25"
                step="0.5"
                required
                value={dailyDose}
                onChange={(e) => setDailyDose(parseFloat(e.target.value) || 1)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">التنبيه قبل النفاد بـ</label>
              <input
                type="number"
                min="1"
                max="30"
                value={warningThresholdDays}
                onChange={(e) => setWarningThresholdDays(parseInt(e.target.value) || 5)}
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
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={reminderTime}
                    onChange={(e) => setReminderTime(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-xl border border-amber-300 bg-white text-sm font-mono font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <span className="text-xs font-bold text-amber-900 bg-white border border-amber-200 px-2.5 py-2 rounded-xl">
                    {formatTimeArabic(reminderTime)}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <div className="w-8 h-8 rounded-xl bg-teal-100 text-teal-800 flex items-center justify-center shrink-0">
                  <Volume2 className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800">صوت إشعار خاص بهذا الدواء</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                    اختياري. اختر نغمة مختلفة لكل دواء حتى تميّز التنبيه من غير ما تشوف الشاشة.
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={customSoundEnabled || reminderEnabled}
                onClick={() => setCustomSoundEnabled(!customSoundEnabled)}
                className={`w-11 h-6 rounded-full relative transition shrink-0 ${
                  customSoundEnabled || reminderEnabled ? 'bg-teal-600' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition ${
                    customSoundEnabled || reminderEnabled ? 'right-0.5' : 'right-[22px]'
                  }`}
                />
              </button>
            </div>

            {(customSoundEnabled || reminderEnabled) && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {NOTIFICATION_SOUND_OPTIONS.map((opt) => {
                    const selected = notificationSound === opt.id;
                    // Hide the "custom" entry when a custom file is already selected
                    // (it's shown in its own block below with the file name).
                    if (opt.id === 'custom' && !customSoundFile) {
                      return null;
                    }
                    if (opt.id === 'custom' && customSoundFile) {
                      // Render the custom option as the "currently selected file" tile.
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => {
                            setNotificationSound('custom');
                            setCustomSoundEnabled(true);
                            playNotificationSound('custom', customSoundFile);
                          }}
                          className={`text-right p-2.5 rounded-xl border transition ${
                            selected
                              ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                              : 'bg-white text-slate-700 border-slate-200 hover:border-teal-300 hover:bg-teal-50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <FileAudio className="w-4 h-4" />
                            {selected && <Volume2 className="w-3.5 h-3.5" />}
                          </div>
                          <div className="text-[11px] font-bold mt-1 truncate" title={customSoundFile.fileName}>
                            {customSoundFile.fileName}
                          </div>
                          <div className={`text-[10px] mt-0.5 ${selected ? 'text-teal-100' : 'text-slate-500'}`}>
                            ملفك الخاص — اضغط للاستماع
                          </div>
                        </button>
                      );
                    }
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          setNotificationSound(opt.id);
                          setCustomSoundEnabled(true);
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

                {/* Upload custom sound file block */}
                <div className="p-3 bg-white border border-dashed border-teal-300 rounded-xl space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center shrink-0">
                        <FileAudio className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold text-slate-800">
                          ملف صوتي من جهازك
                        </p>
                        <p className="text-[10px] text-slate-500 leading-relaxed">
                          MP3 / WAV / OGG / M4A. الحد الأقصى {Math.round(CUSTOM_SOUND_MAX_BYTES / 1024 / 1024)} ميجابايت.
                        </p>
                      </div>
                    </div>
                    {customSoundFile && (
                      <button
                        type="button"
                        onClick={handleRemoveCustomSound}
                        className="text-[10px] font-bold text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded-lg flex items-center gap-1 shrink-0 transition"
                        title="إزالة الملف"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>إزالة</span>
                      </button>
                    )}
                  </div>

                  <label
                    className={`block w-full py-2 px-3 rounded-xl text-xs font-bold text-center cursor-pointer transition ${
                      isUploadingSound
                        ? 'bg-slate-100 text-slate-400 cursor-wait'
                        : 'bg-teal-50 text-teal-800 border border-teal-200 hover:bg-teal-100'
                    }`}
                  >
                    <input
                      type="file"
                      accept={CUSTOM_SOUND_ACCEPTED_MIME}
                      onChange={handleCustomSoundFilePick}
                      disabled={isUploadingSound}
                      className="sr-only"
                    />
                    {isUploadingSound
                      ? 'جاري التحميل...'
                      : customSoundFile
                      ? 'اختيار ملف آخر'
                      : 'اختر ملفاً صوتياً'}
                  </label>

                  {customSoundFile && (
                    <div className="text-[10px] text-teal-700 bg-teal-50 border border-teal-200 rounded-lg px-2 py-1.5 truncate" title={customSoundFile.fileName}>
                      📂 {customSoundFile.fileName}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

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
