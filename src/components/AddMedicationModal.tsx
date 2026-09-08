import React, { useState, useEffect } from 'react';
import { X, Pill, ShieldAlert, Check, Calendar, Zap, Layers, Box, Calculator, Bell, Clock, Volume2, Play } from 'lucide-react';
import { Medication, describeStockInStrips, NotificationSoundType, formatTimeArabic } from '../types';
import { getTodayDateString } from '../utils/dateCalculations';
import { NOTIFICATION_SOUND_OPTIONS, playNotificationSound } from '../utils/sound';

interface AddMedicationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => void;
  initialData?: Medication | null;
}

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

  // Reminder & Sound states
  const [reminderEnabled, setReminderEnabled] = useState<boolean>(false);
  const [reminderTime, setReminderTime] = useState<string>('09:00');
  const [notificationSound, setNotificationSound] = useState<NotificationSoundType>('classic_chime');

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
    }
    setShowStockHelper(false);
    setError('');
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
    const computed = (helperBoxes * boxSize) + (helperStrips * pillsPerStrip) + helperLoose;
    setCurrentPills(Math.max(0, computed));
    setShowStockHelper(false);
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

    const calculatedPkgSize =
      stripsPerBox > 0 && pillsPerStrip > 0
        ? stripsPerBox * pillsPerStrip
        : Number(packageSize) || 30;

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
        autoDeductEnabled: true,
        stripsPerBox: Number(stripsPerBox) || 3,
        pillsPerStrip: Number(pillsPerStrip) || 10,
        packageSize: calculatedPkgSize,
        reminderEnabled,
        reminderTime: reminderEnabled ? reminderTime : undefined,
        notificationSound: reminderEnabled ? notificationSound : 'classic_chime',
      },
      initialData ? initialData.id : undefined
    );
    onClose();
  };

  // Preview calculation
  const previewDays = dailyDose > 0 ? Math.floor(currentPills / dailyDose) : 0;
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + previewDays);
  const previewDepletionDate = targetDate.toLocaleDateString('ar-EG', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs">
      <div
        className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col animate-in slide-in-from-bottom duration-200"
        dir="rtl"
      >
        {/* Header */}
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

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Automatic Deduction Explanation Banner */}
          <div className="p-2.5 bg-teal-50 border border-teal-100 rounded-xl text-xs text-teal-900 flex items-center gap-2">
            <Zap className="w-4 h-4 text-teal-600 shrink-0" />
            <span>
              سيتولى التطبيق خصم الاستهلاك تلقائياً بمرور الأيام دون الحاجة لتسجيل يومي يدوي!
            </span>
          </div>

          {/* Medication Name */}
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

          {/* Pill Count & Unit */}
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
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  نوع الوحدة
                </label>
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

            {/* Quick Strip Stock Helper */}
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
              <div className="mt-2 p-3 bg-teal-50/70 border border-teal-200 rounded-xl space-y-2 animate-in fade-in duration-150">
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
                    المجموع = {(helperBoxes * (stripsPerBox * pillsPerStrip)) + (helperStrips * pillsPerStrip) + helperLoose} {unit}
                  </span>
                  <button
                    type="button"
                    onClick={applyStockHelper}
                    className="px-2.5 py-1 bg-teal-700 hover:bg-teal-800 text-white text-[11px] font-bold rounded-lg transition active:scale-95 shadow-2xs"
                  >
                    تطبيق على الرصيد
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Strips per Box & Pills per Strip Specifications */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-800">
                  مواصفات العلبة والأشرطة (مهم لتتبع المخزون والطلب)
                </h4>
                <p className="text-[10px] text-slate-500">
                  تحديد عدد الأشرطة والحبوب لطلب علب وأشرطة صحيحة من الصيدلية
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  عدد الأشرطة في العلبة
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={stripsPerBox}
                    onChange={(e) => handleStripsChange(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
                  <span className="absolute left-3 top-2 text-xs text-slate-400">
                    أشرطة
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  عدد الحبوب في الشريط
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={pillsPerStrip}
                    onChange={(e) => handlePillsPerStripChange(parseInt(e.target.value) || 1)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
                  <span className="absolute left-3 top-2 text-xs text-slate-400">
                    {unit}
                  </span>
                </div>
              </div>
            </div>

            {/* Total box calculation badge */}
            <div className="flex items-center justify-between text-xs bg-white p-2 rounded-xl border border-teal-200/80">
              <span className="text-slate-600 font-medium flex items-center gap-1.5">
                <Box className="w-3.5 h-3.5 text-teal-600" />
                <span>حجم العلبة الكلي:</span>
              </span>
              <span className="font-bold text-teal-900 font-mono">
                {packageSize} {unit} <span className="text-[10px] text-slate-500 font-normal">({stripsPerBox} أشرطة × {pillsPerStrip} {unit})</span>
              </span>
            </div>
          </div>

          {/* Daily Consumption Rate & Warning Days */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                الاستهلاك اليومي التلقائي <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="0.25"
                  step="0.5"
                  required
                  value={dailyDose}
                  onChange={(e) => setDailyDose(parseFloat(e.target.value) || 1)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
                <span className="absolute left-3 top-2.5 text-xs text-slate-400">
                  {unit} / يوم
                </span>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                التنبيه قبل النفاد بـ
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="1"
                  max="30"
                  value={warningThresholdDays}
                  onChange={(e) => setWarningThresholdDays(parseInt(e.target.value) || 5)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                />
                <span className="absolute left-3 top-2.5 text-xs text-slate-400">
                  أيام
                </span>
              </div>
            </div>
          </div>

          {/* Live Calculation Preview Card */}
          <div className="p-3 bg-teal-50 border border-teal-200/80 rounded-xl text-xs space-y-1">
            <div className="flex items-center justify-between text-teal-950 font-medium">
              <span>الكمية الحالية تكفيك لمدة:</span>
              <span className="font-extrabold text-teal-800 text-sm font-mono bg-teal-100 px-2 py-0.5 rounded-lg">
                {previewDays} {previewDays === 1 ? 'يوم' : previewDays === 2 ? 'يومان' : 'يوماً'}
              </span>
            </div>
            <div className="flex items-center justify-between text-teal-800 text-[11px]">
              <span>تاريخ النفاد المحسوب:</span>
              <span className="font-bold">{previewDepletionDate}</span>
            </div>
          </div>

          {/* Daily Dose Reminder & Custom Notification Sound Section */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-teal-100 text-teal-800 flex items-center justify-center">
                  <Bell className="w-4 h-4 text-teal-700" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-900">تنبيه بميعاد الجرعة اليومي</h4>
                  <p className="text-[11px] text-slate-500">إشعار ونغمة صوتية في وقت تختاره بنفسك</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={reminderEnabled}
                  onChange={(e) => setReminderEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-10 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-teal-600"></div>
              </label>
            </div>

            {reminderEnabled && (
              <div className="space-y-3 pt-2.5 border-t border-slate-200">
                {/* Reminder Time Picker */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-teal-600" />
                      <span>ميعاد التذكير:</span>
                    </label>
                    {reminderTime && (
                      <span className="text-xs font-extrabold text-teal-900 font-mono bg-teal-100 border border-teal-200 px-2 py-0.5 rounded-lg">
                        {formatTimeArabic(reminderTime)}
                      </span>
                    )}
                  </div>
                  <input
                    type="time"
                    value={reminderTime}
                    onChange={(e) => setReminderTime(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />

                  {/* Quick Preset Buttons */}
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    <span className="text-[10px] text-slate-500 font-medium">أوقات شائعة:</span>
                    {[
                      { label: 'صباحاً (09:00 ص)', time: '09:00' },
                      { label: 'ظهراً (02:00 م)', time: '14:00' },
                      { label: 'مساءً (08:00 م)', time: '20:00' },
                      { label: 'قبل النوم (11:00 م)', time: '23:00' },
                    ].map((preset) => (
                      <button
                        key={preset.time}
                        type="button"
                        onClick={() => setReminderTime(preset.time)}
                        className={`text-[11px] px-2.5 py-0.5 rounded-lg border transition ${
                          reminderTime === preset.time
                            ? 'bg-teal-700 text-white border-teal-700 font-bold'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sound Selection for this Medication */}
                <div className="pt-2 border-t border-slate-200">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5 text-teal-600" />
                      <span>صوت إشعار هذا الدواء:</span>
                    </label>
                    <span className="text-[10px] text-slate-500">اختر نغمة مميزة لكل دواء</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {NOTIFICATION_SOUND_OPTIONS.map((snd) => {
                      const isSelected = notificationSound === snd.id;
                      return (
                        <div
                          key={snd.id}
                          onClick={() => setNotificationSound(snd.id)}
                          className={`flex items-center justify-between p-2 rounded-xl border text-xs cursor-pointer transition select-none ${
                            isSelected
                              ? 'bg-teal-50 border-teal-500 text-teal-950 font-bold ring-1 ring-teal-500'
                              : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-base shrink-0">{snd.icon}</span>
                            <div className="min-w-0">
                              <div className="text-xs font-bold truncate">{snd.name}</div>
                              <div className="text-[10px] text-slate-400 font-normal truncate">
                                {snd.description}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              playNotificationSound(snd.id);
                            }}
                            className="mr-1.5 px-2 py-1 bg-white hover:bg-teal-100 border border-slate-200 hover:border-teal-300 rounded-lg text-[10px] font-bold text-teal-800 flex items-center gap-1 shrink-0 active:scale-95 transition shadow-2xs"
                            title="استمع للنغمة"
                          >
                            <Play className="w-2.5 h-2.5 fill-teal-800 text-teal-800" />
                            <span>استماع</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Category & Notes */}
          <div className="space-y-3 pt-1 border-t border-slate-100">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                التصنيف أو التخصص (اختياري)
              </label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="مثال: ضغط، سكر، مسكن، فيتامينات..."
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                ملاحظات الجرعة (اختياري)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="مثال: بعد الأكل، صباحاً على الريق..."
                className="w-full px-3.5 py-2 rounded-xl border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
              />
            </div>
          </div>

          {/* Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition"
            >
              <Check className="w-4 h-4" />
              <span>{initialData ? 'حفظ التعديلات' : 'إضافة الدواء وبدء الحساب التلقائي'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
