import type { FC } from 'react';
import { Zap } from 'lucide-react';
import { Toggle } from './ui/Toggle';

interface Props {
  enabled: boolean;
  onChange: () => void;
}

export const AddMedicationAutoDeductToggle: FC<Props> = ({ enabled, onChange }) => (
  <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-start gap-2.5 min-w-0">
        <div
          className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
            enabled ? 'bg-teal-100 text-teal-800' : 'bg-slate-200 text-slate-500'
          }`}
        >
          <Zap className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <span className="block text-xs font-bold text-slate-800">الخصم التلقائي للمخزون</span>
          <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
            {enabled
              ? 'خصم كل جرعة تلقائياً فور حلول موعدها المحدد'
              : 'إيقاف الخصم التلقائي (تسجيل تناول الجرعات يدوياً)'}
          </p>
        </div>
      </div>
      <Toggle
        checked={enabled}
        onChange={onChange}
        label="تفعيل الخصم التلقائي لهذا الدواء"
        size="md"
      />
    </div>
  </div>
);
