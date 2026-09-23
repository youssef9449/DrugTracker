import type { FC } from 'react';
import { MAX_DOSES_PER_DAY } from '../utils/doseSchedule';

const COLOR_TAGS = [
  { id: 'teal', label: 'تيل', className: 'bg-teal-500' },
  { id: 'rose', label: 'وردي', className: 'bg-rose-500' },
  { id: 'amber', label: 'ذهبي', className: 'bg-amber-500' },
  { id: 'sky', label: 'سماوي', className: 'bg-sky-500' },
  { id: 'violet', label: 'بنفسجي', className: 'bg-violet-500' },
];

interface Props {
  dosesPerDay: number;
  setDosesPerDay: (value: number) => void;
  setDoseSchedule: React.Dispatch<React.SetStateAction<any[]>>;
  warningThresholdDays: string;
  setWarningThresholdDays: (value: string) => void;
  category: string;
  setCategory: (value: string) => void;
  colorTag: string;
  setColorTag: (value: string) => void;
}

export const AddMedicationDetailsSection: FC<Props> = ({
  dosesPerDay, setDosesPerDay, setDoseSchedule, warningThresholdDays, setWarningThresholdDays,
  category, setCategory, colorTag, setColorTag,
}) => (
  <>
    <div className="grid grid-cols-2 gap-3 items-end">
      <div className="min-w-0">
        <label className="block text-xs font-bold text-slate-700 mb-1.5 leading-snug">
          عدد مرات تناول الدواء يومياً <span className="text-red-500">*</span>
        </label>
        <select
          value={dosesPerDay}
          onChange={(e) => {
            const n = Math.max(1, Math.min(MAX_DOSES_PER_DAY, parseInt(e.target.value, 10) || 1));
            setDosesPerDay(n);
            setDoseSchedule((prev) => {
              const next = [...prev];
              while (next.length < n) next.push({ id: `dose-${next.length + 1}`, time: '09:00', amount: 1 });
              return next.slice(0, n);
            });
          }}
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
        >
          {Array.from({ length: MAX_DOSES_PER_DAY }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="min-w-0">
        <label className="block text-xs font-bold text-slate-700 mb-1.5 leading-snug">التنبيه قبل النفاذ (أيام)</label>
        <input type="number" min="1" max="100000" inputMode="numeric" value={warningThresholdDays}
          onChange={(e) => setWarningThresholdDays(e.target.value)} placeholder="مثال: 5"
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
      </div>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">التصنيف (اختياري)</label>
        <input type="text" value={category} onChange={(e) => setCategory(e.target.value)}
          placeholder="ضغط، سكري، فيتامينات..."
          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
      </div>
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">لون البطاقة</label>
        <div className="flex items-center gap-1.5 h-[42px]">
          {COLOR_TAGS.map((c) => (
            <button key={c.id} type="button" title={c.label} onClick={() => setColorTag(c.id)}
              className={`w-7 h-7 rounded-full ${c.className} ${colorTag === c.id ? 'ring-2 ring-offset-2 ring-slate-700 scale-110' : 'opacity-70'} transition`} />
          ))}
        </div>
      </div>
    </div>
  </>
);