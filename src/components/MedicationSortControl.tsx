import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from 'lucide-react';
import type { MedicationSortDirection, MedicationSortField } from '../utils/medicationSorting';

interface MedicationSortControlProps {
  field: MedicationSortField;
  direction: MedicationSortDirection;
  onFieldChange: (field: MedicationSortField) => void;
  onDirectionChange: (direction: MedicationSortDirection) => void;
}

const OPTIONS: { value: MedicationSortField; label: string }[] = [
  { value: 'name', label: 'الاسم' },
  { value: 'quantity', label: 'الكمية المتاحة' },
  { value: 'category', label: 'التصنيف' },
  { value: 'duration', label: 'فترة الاستخدام' },
];

function getDirectionDescription(field: MedicationSortField, direction: MedicationSortDirection, short = false): string {
  if (field === 'name') {
    if (short) return direction === 'asc' ? 'A-Z / أ-ي' : 'Z-A / ي-أ';
    return direction === 'asc' ? 'تصاعدي (A-Z ثم أ-ي)' : 'تنازلي (ي-أ ثم Z-A)';
  }
  if (field === 'quantity') {
    if (short) return direction === 'asc' ? 'الأقل أولاً' : 'الأكثر أولاً';
    return direction === 'asc' ? 'تصاعدي (من الأقل للأكثر)' : 'تنازلي (من الأكثر للأقل)';
  }
  if (field === 'duration') {
    if (short) return direction === 'asc' ? 'الأقصر أولاً' : 'الأطول أولا';
    return direction === 'asc' ? 'تصاعدي (الكورس الأقصر ثم المزمن)' : 'تنازلي (المزمن ثم الكورس الأطول)';
  }
  // category
  if (short) return direction === 'asc' ? 'أ-ي' : 'ي-أ';
  return direction === 'asc' ? 'تصاعدي (أ-ي)' : 'تنازلي (ي-أ)';
}

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
  const shortDesc = getDirectionDescription(field, direction, true);
  const fullDesc = getDirectionDescription(field, direction, false);
  const DirectionIcon = direction === 'asc' ? ArrowUp : ArrowDown;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`ترتيب الأدوية حسب ${label} — ${fullDesc}`}
        onClick={() => setOpen((v) => !v)}
        className="h-[30px] inline-flex items-center gap-1.5 rounded-full border border-slate-300/90 bg-white hover:bg-slate-50 active:bg-slate-100 px-2.5 text-xs font-medium text-slate-700 transition-colors cursor-pointer shadow-2xs focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30"
      >
        <ArrowUpDown className="h-3.5 w-3.5 text-teal-700 shrink-0" aria-hidden="true" />
        <span>ترتيب: {label} ({shortDesc})</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="ترتيب الأدوية"
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-56 overflow-hidden rounded-2xl bg-white p-1.5 shadow-xl border border-slate-200/90 animate-in fade-in zoom-in-95 duration-150"
        >
          <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400">ترتيب حسب</div>
          {OPTIONS.map((o) => {
            const selected = o.value === field;
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onFieldChange(o.value);
                  setOpen(false);
                }}
                className={`flex h-8.5 w-full items-center gap-2 rounded-xl px-2.5 text-right text-xs transition-colors cursor-pointer ${
                  selected
                    ? 'bg-teal-100 text-teal-950 font-semibold'
                    : 'text-slate-700 hover:bg-slate-100 active:bg-slate-200/70'
                }`}
              >
                <span className="flex h-4 w-4 items-center justify-center shrink-0">
                  {selected && <Check className="h-3.5 w-3.5 text-teal-900 stroke-[2.5]" aria-hidden="true" />}
                </span>
                <span className="flex-1">{o.label}</span>
              </button>
            );
          })}
          <div className="my-1 h-px bg-slate-100" />
          <button
            type="button"
            role="menuitem"
            aria-label="تغيير اتجاه الترتيب"
            onClick={() => onDirectionChange(direction === 'asc' ? 'desc' : 'asc')}
            className="flex h-auto min-h-8.5 py-1.5 w-full items-center gap-2 rounded-xl px-2.5 text-right text-xs font-medium text-slate-700 hover:bg-slate-100 active:bg-slate-200/70 transition-colors cursor-pointer"
          >
            <DirectionIcon className="h-3.5 w-3.5 text-teal-700 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-[11px] leading-tight">
              {fullDesc}
            </span>
            <span className="text-[10px] font-normal text-slate-400 shrink-0">تبديل</span>
          </button>
        </div>
      )}
    </div>
  );
}
