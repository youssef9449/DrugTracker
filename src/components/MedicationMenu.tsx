import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Edit3,
  Trash2,
  Zap,
  Pill,
  Droplets,
  Syringe,
  Package,
  X,
} from 'lucide-react';
import { Medication } from '../types';
import './MedicationCardMaterial.css';

interface MedicationMenuProps {
  medication: Medication;
  isAutoActive: boolean;
  showRefillInMenu?: boolean;
  onOpenRefill?: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
  size?: 'xs' | 'sm' | 'md';
  showTypeIcon?: boolean;
}

export function MedicationTypeIcon({ unit, className = "h-3.5 w-3.5" }: { unit: string; className?: string }) {
  switch (unit) {
    case 'مل':
      return <Droplets className={className} aria-hidden="true" />;
    case 'جرعة':
      return <Syringe className={className} aria-hidden="true" />;
    case 'كيس':
      return <Package className={className} aria-hidden="true" />;
    case 'كبسولة':
    case 'قرص':
    default:
      return <Pill className={className} aria-hidden="true" />;
  }
}

export function MedicationMenu({
  medication,
  isAutoActive,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
  size = 'sm',
  showTypeIcon = false,
}: MedicationMenuProps) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (!deleteConfirmOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDeleteConfirmOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [deleteConfirmOpen]);

  const requestDeleteConfirmation = () => setDeleteConfirmOpen(true);

  const confirmDelete = () => {
    setDeleteConfirmOpen(false);
    onDelete(medication.id);
  };

  const btnDims =
    size === 'xs'
      ? 'h-5 w-5 rounded-full'
      : size === 'md'
      ? 'h-8 w-8 rounded-xl'
      : 'h-6 w-6 rounded-full';

  const iconDims = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const iconButtonClass = `inline-flex ${btnDims} shrink-0 items-center justify-center transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40`;

  const deleteDialog = deleteConfirmOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDeleteConfirmOpen(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`delete-medication-title-${medication.id}`}
            aria-describedby={`delete-medication-description-${medication.id}`}
            dir="rtl"
            className="w-full max-w-sm overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/20"
          >
            <div className="flex items-start gap-3 p-5 pb-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600">
                <Trash2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h2
                  id={`delete-medication-title-${medication.id}`}
                  className="text-base font-bold text-slate-900"
                >
                  حذف الدواء؟
                </h2>
                <p
                  id={`delete-medication-description-${medication.id}`}
                  className="mt-1 text-sm leading-6 text-slate-600"
                >
                  هل أنت متأكد من حذف «{medication.name}»؟ لا يمكن التراجع عن هذا الإجراء.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                aria-label="إغلاق"
                title="إلغاء"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex gap-2 border-t border-slate-100 bg-slate-50/70 p-4">
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                className="min-h-10 flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="min-h-10 flex-1 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              >
                حذف الدواء
              </button>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="medication-menu-root flex items-center gap-1" dir="ltr">
      {showTypeIcon && (
        <span
          className={`medication-type-icon inline-flex ${btnDims} shrink-0 items-center justify-center border border-slate-200 bg-slate-50 text-slate-500`}
          title={`نوع الدواء: ${medication.unit || 'غير محدد'}`}
          aria-label={`نوع الدواء: ${medication.unit || 'غير محدد'}`}
        >
          <MedicationTypeIcon unit={medication.unit} className={iconDims} />
        </span>
      )}

      <button
        type="button"
        onClick={() => onEdit(medication)}
        className={`${iconButtonClass} bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800`}
        aria-label="تعديل الدواء"
        title="تعديل الدواء"
      >
        <Edit3 className={iconDims} aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={() => onToggleAutoDeduct(medication.id)}
        className={`${iconButtonClass} ${
          isAutoActive
            ? 'bg-teal-100 text-teal-800 hover:bg-teal-200'
            : 'bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-600'
        }`}
        aria-label={isAutoActive ? 'إيقاف الخصم التلقائي' : 'تفعيل الخصم التلقائي'}
        title={isAutoActive ? 'الخصم التلقائي مفعّل — اضغط للإيقاف' : 'الخصم التلقائي متوقف — اضغط للتفعيل'}
        aria-pressed={isAutoActive}
      >
        <Zap className={`${iconDims} ${isAutoActive ? 'fill-teal-600/30' : ''}`} aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={requestDeleteConfirmation}
        className={`${iconButtonClass} bg-rose-100 text-rose-700 hover:bg-rose-200`}
        aria-label="حذف الدواء"
        title="حذف الدواء"
      >
        <Trash2 className={iconDims} aria-hidden="true" />
      </button>

      {deleteDialog}
    </div>
  );
}
