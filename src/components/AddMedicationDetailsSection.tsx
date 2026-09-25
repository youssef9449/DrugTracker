import type { FC, Dispatch, SetStateAction } from 'react';
import type { MedicationDose } from '../types';
import { MAX_DOSES_PER_DAY } from '../utils/doseSchedule';

interface Props {
  dosesPerDay: number;
  setDosesPerDay: (value: number) => void;
  setDoseSchedule: Dispatch<SetStateAction<MedicationDose[]>>;
  resizeDoseSchedule: (schedule: MedicationDose[], count: number) => MedicationDose[];
  category: string;
  setCategory: (value: string) => void;
}

export const AddMedicationDetailsSection: FC<Props> = ({
  dosesPerDay, setDosesPerDay, setDoseSchedule, category, setCategory,
  resizeDoseSchedule,
}) => (
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
          setDoseSchedule((prev) => resizeDoseSchedule(prev, n));
        }}
        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
      >
        {Array.from({ length: MAX_DOSES_PER_DAY }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </div>
    <div className="min-w-0">
      <label className="block text-xs font-bold text-slate-700 mb-1.5">التصنيف (اختياري)</label>
      <input type="text" value={category} onChange={(e) => setCategory(e.target.value)}
        placeholder="ضغط، سكري، فيتامينات..."
        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
    </div>
  </div>
);
