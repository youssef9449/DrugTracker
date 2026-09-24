import type { FC } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Medication } from '../types';

export interface MedicationDeleteConfirmDialogProps {
  medication: Medication;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Focused delete-confirmation workflow for medication cards/menus. */
export const MedicationDeleteConfirmDialog: FC<MedicationDeleteConfirmDialogProps> = ({
  medication,
  open,
  onCancel,
  onConfirm,
}) => {
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`delete-med-title-${medication.id}`}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <h3
              id={`delete-med-title-${medication.id}`}
              className="text-sm font-bold text-slate-900"
            >
              تأكيد حذف الدواء
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              هل أنت متأكد من حذف <span className="font-bold">{medication.name}</span>؟
              لن يمكن التراجع عن هذا الإجراء وسيتم مسح سجل الجرعات المرتبط به.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
            aria-label="إغلاق"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 p-3 px-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 flex-1 rounded-full border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 cursor-pointer"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-10 flex-1 rounded-full bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-700 active:bg-rose-800 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 cursor-pointer"
          >
            حذف الدواء
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
