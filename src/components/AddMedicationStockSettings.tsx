import type { FC } from 'react';
import { Toggle } from './ui/Toggle';
import { AddMedicationAutoDeductToggle } from './AddMedicationAutoDeductToggle';

interface Props {
  criticalStockAlertsEnabled: boolean;
  setCriticalStockAlertsEnabled: (value: boolean) => void;
  warningThresholdDays: string;
  setWarningThresholdDays: (value: string) => void;
  autoDeductEnabled: boolean;
  setAutoDeductEnabled: (value: boolean) => void;
}

/** Per-medication stock notification + threshold + Auto-Deduction settings. */
export const AddMedicationStockSettings: FC<Props> = ({
  criticalStockAlertsEnabled,
  setCriticalStockAlertsEnabled,
  warningThresholdDays,
  setWarningThresholdDays,
  autoDeductEnabled,
  setAutoDeductEnabled,
}) => (
  <section className="space-y-3 pt-2 border-t border-slate-100">
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl">
      <div className="grid grid-cols-2 gap-3 items-center">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <span className="text-xs font-bold text-slate-700 leading-snug">
            تفعيل إشعارات المخزون
          </span>
          <Toggle
            checked={criticalStockAlertsEnabled}
            onChange={() => setCriticalStockAlertsEnabled(!criticalStockAlertsEnabled)}
            label={
              criticalStockAlertsEnabled
                ? 'إشعارات المخزون مفعّلة — انقر للإيقاف'
                : 'إشعارات المخزون متوقفة — انقر للتفعيل'
            }
            size="md"
          />
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
            className="w-full h-[42px] px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
          />
        </div>
      </div>
    </div>

    <AddMedicationAutoDeductToggle
      enabled={autoDeductEnabled}
      onChange={() => setAutoDeductEnabled(!autoDeductEnabled)}
    />
  </section>
);
