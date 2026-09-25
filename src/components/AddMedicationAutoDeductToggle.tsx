import type { FC } from 'react';
import { Toggle } from './ui/Toggle';

interface Props {
  enabled: boolean;
  onChange: () => void;
}

export const AddMedicationAutoDeductToggle: FC<Props> = ({ enabled, onChange }) => (
  <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
      <span className="block text-xs font-bold text-slate-800">
        الخصم التلقائي للمخزون
      </span>
      <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
        {enabled
          ? 'خصم كل جرعة تلقائياً فور حلول موعدها المحدد'
          : 'إيقاف الخصم التلقائي (تسجيل تناول الجرعات يدوياً)'}
      </p>
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