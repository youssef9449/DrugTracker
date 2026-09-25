import { type Dispatch, type FC, type SetStateAction } from 'react';
import { Calendar, Clock } from 'lucide-react';
import type { MedicationDose } from '../types';
import { formatTimeArabic } from '../utils/medicationPresentation';
import { totalDailyAmount } from '../utils/doseSchedule';
import { getTodayDateString } from '../utils/dateCalculations';
import { CustomTimePicker } from './CustomTimePicker';
import { Toggle } from './ui/Toggle';

interface MedicationCourseAndScheduleProps {
  isChronic: boolean;
  setIsChronic: Dispatch<SetStateAction<boolean>>;
  durationDaysStr: string;
  setDurationDaysStr: Dispatch<SetStateAction<string>>;
  doseSchedule: MedicationDose[];
  setDoseSchedule: Dispatch<SetStateAction<MedicationDose[]>>;
  dosesPerDay: number;
  setDosesPerDay: Dispatch<SetStateAction<number>>;
  unit: string;
  reminderEnabled: boolean;
  setReminderEnabled: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setTreatmentStartDateStr: Dispatch<SetStateAction<string>>;
}

export const MedicationCourseAndSchedule: FC<MedicationCourseAndScheduleProps> = ({
  isChronic, setIsChronic, durationDaysStr, setDurationDaysStr, doseSchedule,
  setDoseSchedule, unit, reminderEnabled,
  setReminderEnabled, setError, setTreatmentStartDateStr,
}) => (
  <section className="space-y-3">
          {/* طبيعة استعمال الدواء (مزمن vs مدة محددة) */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center shrink-0">
                <Calendar className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <span className="block text-xs font-bold text-slate-800">
                  طبيعة استعمال الدواء
                </span>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                  {isChronic
                    ? 'دواء مزمن (استخدام مستمر بدون مدة محددة)'
                    : 'كورس علاجي محدد المدة'}
                </p>
              </div>
            </div>
            {/* خيار مدة الاستعمال كـ Toggle / أزرار اختيار بالأخضر التيل مثل باقي التطبيق */}
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-200/70 rounded-xl">
              <button
                type="button"
                onClick={() => {
                  setIsChronic(true);
                  setError('');
                }}
                className={`py-2 px-3 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                  isChronic
                    ? 'bg-teal-700 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>دواء مزمن</span>
                <span className={`text-[10px] font-normal ${isChronic ? 'text-teal-100' : 'text-slate-400'}`}>(مستمر)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsChronic(false);
                  setTreatmentStartDateStr((prev) => prev || getTodayDateString());
                  setError('');
                }}
                className={`py-2 px-3 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                  !isChronic
                    ? 'bg-teal-700 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>مدة محددة</span>
                <span className={`text-[10px] font-normal ${!isChronic ? 'text-teal-100' : 'text-slate-400'}`}>(كورس علاجي)</span>
              </button>
            </div>
            {!isChronic && (
              <div className="space-y-2 pt-0.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    مدة الاستعمال (بالأيام) <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={durationDaysStr}
                      onChange={(e) => {
                        setDurationDaysStr(e.target.value);
                        setError('');
                      }}
                      placeholder="مثال: 5، 7، 10، 14 يوماً..."
                      className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                    />
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">
                      أيام
                    </span>
                  </div>
                </div>
              </div>
            )}
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
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2.5"
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
                <div>
                  <label className="block text-[11px] font-bold text-slate-600 mb-1">
                    توضيح للجرعة (اختياري)
                  </label>
                  <input
                    type="text"
                    value={dose.description || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDoseSchedule((prev) =>
                        prev.map((d, i) => (i === index ? { ...d, description: val } : d))
                      );
                    }}
                    placeholder="مثال: بعد الإفطار، قبل النوم، مع الغداء..."
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                  />
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

  </section>
);
