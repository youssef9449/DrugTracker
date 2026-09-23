import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreVertical,
  Edit3,
  Trash2,
  Zap,
  Pill,
  Droplets,
  Syringe,
  Package,
  History,
  X,
} from 'lucide-react';
import { Medication } from '../types';
import './MedicationCardMaterial.css';
import { MedicationNotificationStatusBadge } from './medicationCardParts';

export interface MedicationMenuProps {
  medication: Medication;
  /** Effective Auto-Deduct (global ∧ medication). Used for runtime state only. */
  isAutoActive: boolean;
  onOpenRefill?: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
  onToggleMedicationReminder?: (id: string) => void;
  onToggleMedicationCriticalStockAlerts?: (id: string) => void;
  onOpenHistory?: (medication: Medication) => void;
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void;
  size?: 'xs' | 'sm' | 'md';
  showTypeIcon?: boolean;
  showOverflow?: boolean;
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

export interface MedicationOverflowMenuProps {
  medication: Medication;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onOpenHistory?: (medication: Medication) => void;
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

export function MedicationOverflowMenu({
  medication,
  onEdit,
  onDelete,
  onOpenHistory,
  onRegisterBackHandler,
  size = 'sm',
  className = '',
}: MedicationOverflowMenuProps) {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!onRegisterBackHandler) return;
    const unregister = overflowOpen
      ? onRegisterBackHandler(`medication-overflow:${medication.id}`, () => setOverflowOpen(false), 100)
      : undefined;
    const unregisterDelete = deleteConfirmOpen
      ? onRegisterBackHandler(`medication-delete-confirm:${medication.id}`, () => setDeleteConfirmOpen(false), 110)
      : undefined;
    return () => {
      unregister?.();
      unregisterDelete?.();
    };
  }, [overflowOpen, deleteConfirmOpen, onRegisterBackHandler]);
  useEffect(() => {
    if (!overflowOpen || !triggerRef.current) {
      setCoords(null);
      return;
    }

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const menuWidth = 160;
      const menuHeight = onOpenHistory ? 140 : 100;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Vertical: default below button, flip up if near screen bottom
      let top = rect.bottom + 4;
      if (top + menuHeight > viewportHeight - 12 && rect.top > menuHeight + 12) {
        top = rect.top - menuHeight - 4;
      }

      // Horizontal: Trigger is on the left side of the card.
      // Position dropdown extending inward towards the right.
      let left = rect.left;
      if (left + menuWidth > viewportWidth - 8) {
        left = Math.max(8, viewportWidth - menuWidth - 8);
      }
      if (left < 8) left = 8;

      setCoords({ top, left });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [overflowOpen, onOpenHistory]);

  useEffect(() => {
    if (!overflowOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOverflowOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [overflowOpen]);

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
      ? 'h-5 w-5 rounded-md'
      : size === 'md'
      ? 'h-8 w-8 rounded-full'
      : 'h-6 w-6 rounded-lg';

  const iconDims = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const overflowDropdown = overflowOpen && coords && typeof document !== 'undefined'
    ? createPortal(
        <>
          <div
            className="fixed inset-0 z-[105] bg-transparent"
            role="presentation"
            onClick={(event) => {
              event.stopPropagation();
              setOverflowOpen(false);
            }}
            onMouseDown={(event) => {
              event.stopPropagation();
              setOverflowOpen(false);
            }}
          />
          <div
            role="menu"
            aria-orientation="vertical"
            aria-labelledby={`overflow-trigger-${medication.id}`}
            dir="rtl"
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
            }}
            className="fixed z-[106] w-[160px] overflow-hidden rounded-2xl border border-slate-200/90 bg-white p-1.5 shadow-xl animate-in fade-in zoom-in-95 duration-100"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOverflowOpen(false);
                onEdit(medication);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 cursor-pointer text-right"
              aria-label="تعديل الدواء"
              data-testid={`medication-edit-${medication.id}`}
            >
              <Edit3 className="h-4 w-4 text-slate-500 shrink-0" aria-hidden="true" />
              <span>تعديل الدواء</span>
            </button>

            {onOpenHistory && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOverflowOpen(false);
                  onOpenHistory(medication);
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 cursor-pointer text-right"
                aria-label="سجل حركات الدواء"
                data-testid={`medication-history-${medication.id}`}
              >
                <History className="h-4 w-4 text-teal-600 shrink-0" aria-hidden="true" />
                <span>سجل الحركات</span>
              </button>
            )}

            <div className="my-1 border-t border-slate-100" />

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOverflowOpen(false);
                requestDeleteConfirmation();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 hover:text-rose-700 active:bg-rose-100 cursor-pointer text-right"
              aria-label="حذف الدواء"
              data-testid={`medication-delete-${medication.id}`}
            >
              <Trash2 className="h-4 w-4 text-rose-500 shrink-0" aria-hidden="true" />
              <span>حذف الدواء</span>
            </button>
          </div>
        </>,
        document.body
      )
    : null;

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
              <div className="min-w-0 flex-1 pt-1">
                <h3
                  id={`delete-medication-title-${medication.id}`}
                  className="text-base font-bold text-slate-900"
                >
                  حذف الدواء؟
                </h3>
                <p
                  id={`delete-medication-description-${medication.id}`}
                  className="mt-1 text-xs leading-relaxed text-slate-600"
                >
                  هل أنت متأكد من حذف <span className="font-semibold text-slate-800">{medication.name}</span>؟ لن يمكن التراجع عن هذا الإجراء وسيتم مسح سجل الجرعات المرتبط به.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDeleteConfirmOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
                aria-label="إغلاق"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50/70 p-3 px-4">
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
    <>
      <button
        ref={triggerRef}
        id={`overflow-trigger-${medication.id}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOverflowOpen((prev) => !prev);
        }}
        className={`inline-flex ${btnDims} shrink-0 items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 active:bg-slate-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 cursor-pointer ${className}`}
        aria-label={`المزيد من الخيارات لـ ${medication.name}`}
        title="المزيد من الخيارات"
        aria-haspopup="menu"
        aria-expanded={overflowOpen}
        data-testid={`medication-overflow-${medication.id}`}
      >
        <MoreVertical className={iconDims} aria-hidden="true" />
      </button>

      {overflowDropdown}
      {deleteDialog}
    </>
  );
}

export function MedicationMenu({
  medication,
  isAutoActive,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
  onToggleMedicationReminder,
  onToggleMedicationCriticalStockAlerts,
  onOpenHistory,
  size = 'sm',
  showTypeIcon = false,
  showOverflow = false,
}: MedicationMenuProps) {
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

  const btnDims =
    size === 'xs'
      ? 'h-5 w-5 rounded-full'
      : size === 'md'
      ? 'h-8 w-8 rounded-full'
      : 'h-6 w-6 rounded-full';

  const iconDims = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  const iconButtonClass = `inline-flex ${btnDims} shrink-0 items-center justify-center transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 cursor-pointer`;

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

      {/* History icon removed from card action strip per user instructions.
          History is now cleanly accessed inside the MedicationOverflowMenu. */}

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

      {onToggleMedicationReminder && (
        <MedicationNotificationStatusBadge
          enabled={medication.reminderEnabled === true}
          onToggle={() => onToggleMedicationReminder(medication.id)}
          type="dose"
          size={size === 'xs' ? 'xs' : 'sm'}
          medicationId={medication.id}
        />
      )}

      {onToggleMedicationCriticalStockAlerts && (
        <MedicationNotificationStatusBadge
          enabled={medication.criticalStockAlertsEnabled !== false}
          onToggle={() => onToggleMedicationCriticalStockAlerts(medication.id)}
          type="critical"
          size={size === 'xs' ? 'xs' : 'sm'}
          medicationId={medication.id}
        />
      )}

      {showOverflow && (
        <MedicationOverflowMenu
          medication={medication}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenHistory={onOpenHistory}
          onRegisterBackHandler={onRegisterBackHandler}
          size={size}
        />
      )}
    </div>
  );
}
