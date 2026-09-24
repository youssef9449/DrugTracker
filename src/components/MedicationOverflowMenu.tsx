import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreVertical,
  Edit3,
  Trash2,
  History,
} from 'lucide-react';
import type { Medication } from '../types';
import { MedicationDeleteConfirmDialog } from './MedicationDeleteConfirmDialog';

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

  const deleteDialog = (
    <MedicationDeleteConfirmDialog
      medication={medication}
      open={deleteConfirmOpen}
      onCancel={() => setDeleteConfirmOpen(false)}
      onConfirm={confirmDelete}
    />
  );

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

