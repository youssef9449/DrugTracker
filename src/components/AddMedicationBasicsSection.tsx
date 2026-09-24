import type { FC } from 'react';
import { Calculator } from 'lucide-react';
import type { Medication } from '../types';
import { describeStockInStrips, isSolidUnit } from '../utils/medicationPackaging';

interface Props {
  name: string;
  setName: (value: string) => void;
  currentPills: number;
  currentPillsStr: string;
  setCurrentPills: (value: number) => void;
  setCurrentPillsStr: (value: string) => void;
  initialData?: Medication | null;
  unit: string;
  handleUnitChange: (unit: string) => void;
  showStockHelper: boolean;
  setShowStockHelper: (value: boolean) => void;
  noStrips: boolean;
  pillsPerStrip: string;
  stripsPerBox: string;
  helperBoxes: string;
  helperStrips: string;
  helperLoose: string;
  setHelperBoxes: (value: string) => void;
  setHelperStrips: (value: string) => void;
  setHelperLoose: (value: string) => void;
  helperTotal: number;
  applyStockHelper: () => void;
}

export const AddMedicationBasicsSection: FC<Props> = ({
  name,
  setName,
  currentPills,
  currentPillsStr,
  setCurrentPills,
  setCurrentPillsStr,
  initialData,
  unit,
  handleUnitChange,
  showStockHelper,
  setShowStockHelper,
  noStrips,
  pillsPerStrip,
  stripsPerBox,
  helperBoxes,
  helperStrips,
  helperLoose,
  setHelperBoxes,
  setHelperStrips,
  setHelperLoose,
  helperTotal,
  applyStockHelper,
}) => (
  <>
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
        <div className="h-full flex flex-col justify-between">
          <label className="block text-xs font-bold text-slate-700 mb-1.5">
            {unit === 'مل'
              ? 'الكمية المتوفرة حالياً (مل)'
              : isSolidUnit(unit)
              ? 'عدد الحبوب المتوفرة حالياً'
              : `الكمية المتوفرة حالياً (${unit})`}{' '}
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
            value={currentPillsStr}
            disabled={Boolean(initialData)}
            onChange={(e) => {
              const raw = e.target.value;
              setCurrentPillsStr(raw);
              const parsed = parseInt(raw, 10);
              if (!isNaN(parsed) && parsed >= 0) setCurrentPills(parsed);
            }}
            className={`w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white mt-auto ${
              initialData ? 'opacity-60 cursor-not-allowed' : ''
            }`}
          />
        </div>
        <div className="h-full flex flex-col justify-between">
          <label className="block text-xs font-bold text-slate-700 mb-1.5">نوع الوحدة</label>
          <select
            value={unit}
            onChange={(e) => handleUnitChange(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white mt-auto"
          >
            <option value="قرص">قرص (حبّة)</option>
            <option value="كبسولة">كبسولة</option>
            <option value="مل">مل (دواء شرب / شراب)</option>
            <option value="جرعة">جرعة (بخاخ / قطرة / حقنة)</option>
            <option value="كيس">كيس (فوار / بودرة)</option>
          </select>
        </div>
      </div>
      {!initialData && isSolidUnit(unit) && (
        <div className="mt-1.5 flex items-center justify-between flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setShowStockHelper(!showStockHelper)}
            className="text-[11px] text-teal-700 hover:text-teal-900 font-bold flex items-center gap-1 transition"
          >
            <Calculator className="w-3 h-3 text-teal-600" />
            <span>{showStockHelper ? 'إخفاء حاسبة الأشرطة' : 'احسب من العلب والأشرطة المتوفرة'}</span>
          </button>
          {!noStrips &&
            describeStockInStrips(
              currentPills,
              parseInt(pillsPerStrip, 10) || 10,
              parseInt(stripsPerBox, 10) || 3,
              unit
            ) && (
              <span className="text-[11px] text-teal-800 font-medium bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60">
                يعادل:{' '}
                {describeStockInStrips(
                  currentPills,
                  parseInt(pillsPerStrip, 10) || 10,
                  parseInt(stripsPerBox, 10) || 3,
                  unit
                )}
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
            {([
              ['علب كاملة', helperBoxes, setHelperBoxes],
              ['أشرطة إضافية', helperStrips, setHelperStrips],
              ['حبات منفردة', helperLoose, setHelperLoose],
            ] as Array<[string, string, (value: string) => void]>).map(([label, value, setter]) => (
              <div key={label as string}>
                <label className="block text-[10px] text-slate-600 mb-0.5">{label}</label>
                <input
                  type="number"
                  min="0"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs font-mono text-center focus:ring-1 focus:ring-teal-500"
                />
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-teal-900 font-mono">المجموع = {helperTotal} {unit}</span>
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
  </>
);
