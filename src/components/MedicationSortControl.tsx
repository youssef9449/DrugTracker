import { useEffect, useRef, useState } from 'react';
import { ArrowDownAZ, ArrowUpAZ, Check, ListFilter } from 'lucide-react';
import type { MedicationSortDirection, MedicationSortField } from '../utils/medicationSorting';

interface MedicationSortControlProps {
  field: MedicationSortField;
  direction: MedicationSortDirection;
  onFieldChange: (field: MedicationSortField) => void;
  onDirectionChange: (direction: MedicationSortDirection) => void;
}

const OPTIONS = [
  { value: 'name' as const, label: 'الاسم' },
  { value: 'quantity' as const, label: 'الكمية المتاحة' },
  { value: 'category' as const, label: 'التصنيف' },
];

export function MedicationSortControl({ field, direction, onFieldChange, onDirectionChange }: MedicationSortControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const label = OPTIONS.find((o) => o.value === field)?.label ?? 'الاسم';
  const Icon = direction === 'asc' ? ArrowUpAZ : ArrowDownAZ;
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={`ترتيب الأدوية حسب ${label} — ${direction === 'asc' ? 'تصاعدي' : 'تنازلي'}`}
        onClick={() => setOpen((v) => !v)}
        className="h-8 inline-flex items-center gap-1.5 rounded-full border border-slate-300/90 bg-white px-2.5 text-[11px] font-bold text-slate-700 shadow-2xs hover:bg-slate-50 active:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40">
        <ListFilter className="h-3.5 w-3.5 text-teal-700" aria-hidden="true" /><span>ترتيب</span><Icon className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
      </button>
      {open && <div role="menu" aria-label="ترتيب الأدوية" className="absolute right-0 top-[calc(100%+8px)] z-50 w-56 overflow-hidden rounded-3xl border border-slate-200 bg-white p-1.5 shadow-xl">
        <div className="px-3 pb-1.5 pt-2 text-[10px] font-bold text-slate-500">ترتيب حسب</div>
        {OPTIONS.map((o) => {
          const selected = o.value === field;
          return <button key={o.value} type="button" role="menuitemradio" aria-checked={selected}
            onClick={() => { onFieldChange(o.value); setOpen(false); }}
            className={`flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-right text-xs ${selected ? 'bg-teal-100 text-teal-950 font-bold' : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200/70'}`}>
            <span className="flex h-5 w-5 items-center justify-center">{selected && <Check className="h-4 w-4 text-teal-800" aria-hidden="true" />}</span><span className="flex-1">{o.label}</span>
          </button>;
        })}
        <div className="my-1.5 h-px bg-slate-100" />
        <button type="button" role="menuitem" aria-label="تغيير اتجاه الترتيب"
          onClick={() => onDirectionChange(direction === 'asc' ? 'desc' : 'asc')}
          className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-right text-xs font-bold text-slate-700 hover:bg-slate-100 active:bg-slate-200/70">
          <Icon className="h-4 w-4 text-teal-700" aria-hidden="true" /><span className="flex-1">{direction === 'asc' ? 'تصاعدي' : 'تنازلي'}</span><span className="text-[10px] font-medium text-slate-400">تبديل</span>
        </button>
      </div>}
    </div>
  );
}
