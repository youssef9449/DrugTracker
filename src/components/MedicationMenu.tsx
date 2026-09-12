import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MoreVertical,
  Edit3,
  Trash2,
  PauseCircle,
  PlayCircle,
  Pill,
  Droplets,
  Syringe,
  Package,
} from 'lucide-react';
import { Medication } from '../types';

interface MedicationMenuProps {
  medication: Medication;
  isAutoActive: boolean;
  showRefillInMenu?: boolean;
  onOpenRefill?: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
}

function MedicationTypeIcon({ unit }: { unit: string }) {
  switch (unit) {
    case 'مل':
      return <Droplets className="h-4 w-4" aria-hidden="true" />;
    case 'جرعة':
      return <Syringe className="h-4 w-4" aria-hidden="true" />;
    case 'كيس':
      return <Package className="h-4 w-4" aria-hidden="true" />;
    case 'كبسولة':
    case 'قرص':
    default:
      return <Pill className="h-4 w-4" aria-hidden="true" />;
  }
}

export function MedicationMenu({
  medication,
  isAutoActive,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
}: MedicationMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 192;
    const viewportPadding = 8;
    const left = Math.max(
      viewportPadding,
      Math.min(rect.left, window.innerWidth - menuWidth - viewportPadding)
    );
    const estimatedHeight = 180;
    const below = rect.bottom + 8;
    const top =
      below + estimatedHeight <= window.innerHeight - viewportPadding
        ? below
        : Math.max(viewportPadding, rect.top - estimatedHeight - 8);

    setMenuPosition({ top, left });
  };

  useEffect(() => {
    if (!menuOpen) return;

    updateMenuPosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };

    const handleViewportChange = () => updateMenuPosition();

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);

  const runAction = (action: () => void) => {
    closeMenu();
    action();
  };

  const iconButtonClass =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1';

  const menu = menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] w-48 overflow-hidden rounded-2xl border border-slate-200 bg-white p-1.5 text-xs shadow-2xl shadow-slate-900/15"
          style={{ top: menuPosition.top, left: menuPosition.left }}
          dir="rtl"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onEdit(medication))}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            <Edit3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <span className="font-medium">تعديل تفاصيل الدواء</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onToggleAutoDeduct(medication.id))}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            {isAutoActive ? (
              <PauseCircle className="h-4 w-4 text-amber-600" aria-hidden="true" />
            ) : (
              <PlayCircle className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            )}
            <span className="font-medium">
              {isAutoActive ? 'إيقاف الخصم التلقائي' : 'تفعيل الخصم التلقائي'}
            </span>
          </button>

          <div className="my-1 border-t border-slate-100" />

          <button
            type="button"
            role="menuitem"
            onClick={() => runAction(() => onDelete(medication.id))}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-right text-rose-600 transition hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            <span className="font-medium">حذف الدواء</span>
          </button>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="medication-menu-root flex items-center gap-1" dir="ltr">
      <span
        className="medication-type-icon inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-500"
        title={`نوع الدواء: ${medication.unit || 'غير محدد'}`}
        aria-label={`نوع الدواء: ${medication.unit || 'غير محدد'}`}
      >
        <MedicationTypeIcon unit={medication.unit} />
      </span>

      <button
        type="button"
        onClick={() => onEdit(medication)}
        className={`${iconButtonClass} border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800`}
        aria-label="تعديل الدواء"
        title="تعديل الدواء"
      >
        <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={() => onToggleAutoDeduct(medication.id)}
        className={`${iconButtonClass} ${
          isAutoActive
            ? 'border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100'
            : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
        }`}
        aria-label={isAutoActive ? 'إيقاف الخصم التلقائي' : 'تفعيل الخصم التلقائي'}
        title={isAutoActive ? 'الخصم التلقائي مفعّل — اضغط للإيقاف' : 'الخصم التلقائي متوقف — اضغط للتفعيل'}
        aria-pressed={isAutoActive}
      >
        {isAutoActive ? (
          <PauseCircle className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        onClick={() => onDelete(medication.id)}
        className={`${iconButtonClass} border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100`}
        aria-label="حذف الدواء"
        title="حذف الدواء"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!menuOpen) updateMenuPosition();
          setMenuOpen((value) => !value);
        }}
        className={`${iconButtonClass} border-transparent bg-transparent text-slate-400 hover:border-slate-200 hover:bg-slate-100 hover:text-slate-700`}
        aria-label="خيارات إضافية"
        aria-expanded={menuOpen}
        title="خيارات إضافية"
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      {menu}
    </div>
  );
}
