import type { FC } from 'react';

const COLOR_TAGS = [
  { id: 'teal', label: 'تيل', className: 'bg-teal-500' },
  { id: 'rose', label: 'وردي', className: 'bg-rose-500' },
  { id: 'amber', label: 'ذهبي', className: 'bg-amber-500' },
  { id: 'sky', label: 'سماوي', className: 'bg-sky-500' },
  { id: 'violet', label: 'بنفسجي', className: 'bg-violet-500' },
];

interface Props {
  colorTag: string;
  setColorTag: (value: string) => void;
}

export const AddMedicationColorSection: FC<Props> = ({ colorTag, setColorTag }) => (
  <section className="pt-2 border-t border-slate-100">
    <div>
      <label className="block text-xs font-bold text-slate-700 mb-1.5">لون البطاقة</label>
      <div className="flex items-center gap-1.5 h-[42px]">
        {COLOR_TAGS.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.label}
            onClick={() => setColorTag(c.id)}
            className={`w-7 h-7 rounded-full ${c.className} ${colorTag === c.id ? 'ring-2 ring-offset-2 ring-slate-700 scale-110' : 'opacity-70'} transition`}
          />
        ))}
      </div>
    </div>
  </section>
);
