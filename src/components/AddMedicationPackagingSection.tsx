import type { FC } from 'react';
import { Box, Layers } from 'lucide-react';
import { Checkbox } from './ui/Checkbox';
import { isSolidUnit } from '../utils/medicationPackaging';

interface Props {
  unit: string;
  noStrips: boolean;
  setNoStrips: (value: boolean) => void;
  stripsPerBox: string;
  setStripsPerBox: (value: string) => void;
  pillsPerStrip: string;
  handleStripsChange: (value: string) => void;
  handlePillsPerStripChange: (value: string) => void;
  packageSize: number;
  packageSizeStr: string;
  setPackageSize: (value: number) => void;
  setPackageSizeStr: (value: string) => void;
}

export const AddMedicationPackagingSection: FC<Props> = ({
  unit, noStrips, setNoStrips, stripsPerBox, setStripsPerBox, pillsPerStrip,
  handleStripsChange, handlePillsPerStripChange, packageSize, packageSizeStr,
  setPackageSize, setPackageSizeStr,
}) => (
  <>
    {isSolidUnit(unit) && (
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2.5">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center">
            <Layers className="w-3.5 h-3.5" />
          </div>
          <h4 className="text-xs font-bold text-slate-800">مواصفات العلبة</h4>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox
            checked={noStrips}
            onChange={(e) => setNoStrips(e.target.checked)}
            aria-label="بدون أشرطة (أقراص فرط في العلبة)"
          />
          <span className="text-[11px] font-bold text-slate-700">بدون أشرطة (أقراص فرط في العلبة)</span>
        </label>
        {noStrips ? (
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">عدد الأقراص في العلبة</label>
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
              <span className="font-bold text-teal-900 font-mono">{packageSize} {unit}</span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">عدد الأشرطة في العلبة</label>
              <input type="number" min="1" max="50" inputMode="numeric" step="any" value={stripsPerBox}
                onChange={(e) => handleStripsChange(e.target.value)}
                placeholder="مثال: 3"
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">عدد الحبوب في الشريط</label>
              <input type="number" min="1" max="100000" inputMode="numeric" step="any" value={pillsPerStrip}
                onChange={(e) => handlePillsPerStripChange(e.target.value)}
                placeholder="مثال: 10"
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
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
    {!isSolidUnit(unit) && (
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center"><Box className="w-3.5 h-3.5" /></div>
          <div>
            <h4 className="text-xs font-bold text-slate-800">{unit === 'مل' ? 'حجم زجاجة/عبوة الدواء' : 'حجم العبوة'}</h4>
            <p className="text-[10px] text-slate-500">
              {unit === 'مل' ? 'سعة الزجاجة بالملل لحساب عدد العبوات المطلوبة عند الشراء والتعبئة' : `سعة العبوة الواحدة بـ (${unit})`}
            </p>
          </div>
        </div>
        <label className="block text-xs font-bold text-slate-700 mb-1">حجم العبوة ({unit})</label>
        <input
          type="number" min="1" max="100000" inputMode="numeric" step="any"
          value={packageSizeStr}
          onChange={(e) => {
            const raw = e.target.value;
            setPackageSizeStr(raw);
            const parsed = parseInt(raw, 10);
            if (!isNaN(parsed) && parsed > 0) setPackageSize(parsed);
          }}
          placeholder={unit === 'مل' ? 'مثال: 100 أو 120 مل' : 'مثال: 30'}
          className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
        />
      </div>
    )}
  </>
);
