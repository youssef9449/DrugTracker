import React, { useState, useEffect } from 'react';
import { X, PlusCircle, Check, Layers, Box } from 'lucide-react';
import { Medication, describeStockInStrips } from '../types';

interface RefillModalProps {
  medication: Medication | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirmRefill: (medicationId: string, addedPills: number) => void;
}

export const RefillModal: React.FC<RefillModalProps> = ({
  medication,
  isOpen,
  onClose,
  onConfirmRefill,
}) => {
  const [addedCount, setAddedCount] = useState<number>(30);

  // Sync default count with medication's actual package size on open
  useEffect(() => {
    if (medication && isOpen) {
      const boxSize =
        medication.stripsPerBox && medication.pillsPerStrip
          ? medication.stripsPerBox * medication.pillsPerStrip
          : medication.packageSize && medication.packageSize > 0
          ? medication.packageSize
          : 30;
      setAddedCount(boxSize);
    }
  }, [medication, isOpen]);

  if (!isOpen || !medication) return null;

  const boxSize =
    medication.stripsPerBox && medication.pillsPerStrip
      ? medication.stripsPerBox * medication.pillsPerStrip
      : medication.packageSize && medication.packageSize > 0
      ? medication.packageSize
      : 30;

  const stripSize = medication.pillsPerStrip || 10;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (addedCount <= 0) return;
    onConfirmRefill(medication.id, addedCount);
    onClose();
  };

  const newTotal = medication.currentPills + addedCount;
  const newDays =
    medication.dailyDose > 0 ? Math.floor(newTotal / medication.dailyDose) : 0;

  const currentStripsDesc = describeStockInStrips(
    medication.currentPills,
    medication.pillsPerStrip,
    medication.stripsPerBox,
    medication.unit
  );

  const newStripsDesc = describeStockInStrips(
    newTotal,
    medication.pillsPerStrip,
    medication.stripsPerBox,
    medication.unit
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs">
      <div
        className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom duration-200"
        dir="rtl"
      >
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PlusCircle className="w-5 h-5 text-teal-200" />
            <h3 className="font-bold text-base">إعادة تعبئة المخزون</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full text-teal-200 hover:text-white hover:bg-teal-700 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 space-y-4">
          <div>
            <span className="text-xs text-slate-500 block">الدواء المحدد:</span>
            <h4 className="font-bold text-base text-slate-800 mt-0.5">{medication.name}</h4>
            <div className="mt-1 text-xs text-slate-600 flex items-center gap-1.5 flex-wrap">
              <span>المتوفر حالياً:</span>
              <strong className="font-mono text-teal-700">{medication.currentPills} {medication.unit}</strong>
              {currentStripsDesc && (
                <span className="text-[11px] text-slate-500 font-medium">({currentStripsDesc})</span>
              )}
            </div>
            {medication.stripsPerBox && medication.pillsPerStrip && (
              <div className="mt-1 text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded-md border border-teal-200/60 inline-flex items-center gap-1">
                <Layers className="w-3 h-3 text-teal-600" />
                <span>مواصفات العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">
              عدد الحبوب التي تريد إضافتها:
            </label>
            <input
              type="number"
              min="1"
              step="1"
              required
              value={addedCount}
              onChange={(e) => setAddedCount(Math.max(1, parseInt(e.target.value) || 0))}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-base font-bold font-mono text-center focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
            />
          </div>

          {/* Quick preset chips by Box and Strip */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-bold text-slate-600 block">إضافة سريعة بالعلبة أو الشريط:</span>
            <div className="flex items-center justify-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setAddedCount(boxSize)}
                className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition border flex items-center gap-1 ${
                  addedCount === boxSize
                    ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Box className="w-3 h-3" />
                <span>+1 علبة ({boxSize})</span>
              </button>

              <button
                type="button"
                onClick={() => setAddedCount(boxSize * 2)}
                className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition border flex items-center gap-1 ${
                  addedCount === boxSize * 2
                    ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <Box className="w-3 h-3" />
                <span>+2 علبة ({boxSize * 2})</span>
              </button>

              {medication.pillsPerStrip && (
                <>
                  <button
                    type="button"
                    onClick={() => setAddedCount(stripSize)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition border flex items-center gap-1 ${
                      addedCount === stripSize
                        ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>+1 شريط ({stripSize})</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAddedCount(stripSize * 2)}
                    className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition border flex items-center gap-1 ${
                      addedCount === stripSize * 2
                        ? 'bg-teal-700 text-white border-teal-700 shadow-xs'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>+2 شريط ({stripSize * 2})</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* New estimation preview */}
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs space-y-1">
            <div className="flex justify-between items-center text-emerald-950 font-medium">
              <span>المجموع بعد الإضافة:</span>
              <div className="text-left">
                <span className="font-bold font-mono">{newTotal} {medication.unit}</span>
                {newStripsDesc && (
                  <span className="block text-[10px] text-emerald-800 font-medium">({newStripsDesc})</span>
                )}
              </div>
            </div>
            <div className="flex justify-between text-emerald-800 pt-0.5">
              <span>سيكفيك لمدة:</span>
              <span className="font-bold font-mono">{newDays} يوماً تقريباً</span>
            </div>
          </div>

          <button
            type="submit"
            className="w-full py-3 px-4 bg-teal-700 hover:bg-teal-800 active:scale-98 text-white rounded-xl font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition"
          >
            <Check className="w-4 h-4" />
            <span>تأكيد إضافة المخزون (+{addedCount})</span>
          </button>
        </form>
      </div>
    </div>
  );
};
