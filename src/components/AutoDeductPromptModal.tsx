import type { FC } from 'react';
import { Zap, Check, X, Info } from 'lucide-react';
import { Modal } from './ui/Modal';

export interface AutoDeductPromptModalProps {
  isOpen: boolean;
  onConfirm: (enable: boolean) => void;
}

/**
 * First-run modal prompting the user to enable or disable Automatic Deduction.
 * Explains clearly what automatic deduction does and offers "نعم" and "لا" choices.
 */
export const AutoDeductPromptModal: FC<AutoDeductPromptModalProps> = ({
  isOpen,
  onConfirm,
}) => {
  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => onConfirm(false)}
      label="إعداد الخصم التلقائي للمخزون"
      variant="center"
    >
      <div className="bg-white rounded-[28px] shadow-2xl w-full max-w-sm mx-auto overflow-hidden border border-slate-100 text-right">
        {/* Header with icon and title */}
        <div className="bg-gradient-to-b from-teal-50 to-white px-5 pt-6 pb-3 text-center">
          <div className="w-12 h-12 rounded-2xl bg-teal-700 text-white flex items-center justify-center mx-auto shadow-md shadow-teal-700/20 mb-3">
            <Zap className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-slate-900 leading-snug">
            تفعيل الخصم التلقائي للأدوية؟
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            مرحباً بك! هل تود تفعيل ميزة الخصم التلقائي للجرعات؟
          </p>
        </div>

        {/* Explanation Card */}
        <div className="px-5 py-3 space-y-2.5">
          <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-2 text-xs">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-teal-700 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold text-slate-800 block text-[11px] mb-0.5">
                  ماذا تفعل هذه الميزة؟
                </span>
                <p className="text-slate-600 text-[11px] leading-relaxed">
                  يقوم التطبيق بخصم جرعات أدويتك تلقائياً من رصيد المخزون عند حلول موعد كل جرعة، مما يضمن دقة رصيدك وتاريخ النفاذ وتنبيهات النقص دون الحاجة لتسجيل كل حبة يدوياً.
                </p>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-200/60 text-[10.5px] text-slate-500 leading-relaxed space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-600 shrink-0" />
                <span><strong className="text-teal-900 font-semibold">اختيار نعم:</strong> خصم تلقائي في موعد الجرعات وتحديث مستمر للمخزون.</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0" />
                <span><strong className="text-slate-700 font-semibold">اختيار لا:</strong> يظل المخزون ثابتاً وتخصم الجرعات عند تسجيلها يدوياً فقط.</span>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-slate-400 text-center">
            يمكنك تغيير هذا الخيار لاحقاً في أي وقت من إعدادات التطبيق.
          </p>
        </div>

        {/* Choice Buttons: نعم / لا */}
        <div className="p-4 pt-2 bg-slate-50/50 border-t border-slate-100 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            id="btn-auto-deduct-yes"
            onClick={() => onConfirm(true)}
            className="flex items-center justify-center gap-1.5 h-10 px-4 bg-teal-700 hover:bg-teal-800 active:bg-teal-900 text-white rounded-full text-xs font-semibold transition shadow-2xs cursor-pointer"
          >
            <Check className="w-4 h-4 stroke-[2.25]" />
            <span>نعم (تفعيل)</span>
          </button>
          <button
            type="button"
            id="btn-auto-deduct-no"
            onClick={() => onConfirm(false)}
            className="flex items-center justify-center gap-1.5 h-10 px-4 bg-white hover:bg-slate-50 active:bg-slate-100 text-slate-700 border border-slate-300 rounded-full text-xs font-semibold transition cursor-pointer"
          >
            <X className="w-4 h-4 stroke-[2.25]" />
            <span>لا (إيقاف)</span>
          </button>
        </div>
      </div>
    </Modal>
  );
};
