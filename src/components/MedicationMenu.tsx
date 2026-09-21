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
  /** Effective Auto-Deduct (global ∧ medication). Used for runtime state only. */
  isAutoActive: boolean;
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

  // Medication-level Auto only (Global bulk-sets all meds; this menu edits one).
  const isMedicationAutoDeductEnabled = medication.autoDeductEnabled !== false;
  const autoTogglePressed = isMedicationAutoDeductEnabled;
  const autoToggleAriaLabel = isAutoActive
    ? 'إيقاف الخصم التلقائي'
    : 'تفعيل الخصم التلقائي';
  const autoToggleTitle = isAutoActive
    ? 'الخصم التلقائي مفعّل — اضغط للإيقاف'
    : 'الخصم التلقائي متوقف — اضغط للتفعيل';
  const autoToggleClass = isAutoActive
    ? 'bg-teal-100 text-teal-800 hover:bg-teal-200'
    : 'bg-amber-100 text-amber-700 hover:bg-amber-200 border border-amber-300/50';

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
      ? 'h-8 w-8 rounded-full'
      : 'h-6 w-6 rounded-full';

  const iconDims = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const iconButtonClass = `inline-flex ${btnDims} shrink-0 items-center justify-center transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 cursor-pointer`;

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
            className="w-full max-w-sm overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-xl"
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
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 cursor-pointer"
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
                className="h-10 flex-1 rounded-full border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 active:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="h-10 flex-1 rounded-full bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-700 active:bg-rose-800 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 cursor-pointer"
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
        className={`${iconButtonClass} ${autoToggleClass}`}
        aria-label={autoToggleAriaLabel}
        title={autoToggleTitle}
        aria-pressed={autoTogglePressed}
        data-auto-pref={isMedicationAutoDeductEnabled ? 'on' : 'off'}
        data-auto-effective={isAutoActive ? 'on' : 'off'}
      >
        <Zap
          className={`${iconDims} ${isAutoActive ? 'fill-teal-600/30' : 'text-amber-600 fill-amber-400/20'}`}
          aria-hidden="true"
        />
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
