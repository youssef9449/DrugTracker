import type { FC } from 'react';
import { CalendarX2 } from 'lucide-react';
import type { Medication } from '../types';

interface AutoScheduleMissingBannerProps {
  /** Medications that are Auto enabled but carry no usable doseSchedule. */
  affectedMedications: Medication[];
}

/**
 * #502: explicit runtime status for "Auto enabled + missing/invalid
 * doseSchedule". Auto-Deduction is UNSUPPORTED for these medications — the
 * canonical definition produces zero occurrences and this banner surfaces
 * the state instead of silently looking healthy. The three runtime states
 * remain distinguishable:
 * - Auto enabled + valid schedule → no banner (normal Auto behavior);
 * - Auto enabled + missing/invalid schedule → THIS banner;
 * - Auto disabled → no banner and no Auto occurrences by definition.
 */
export const AutoScheduleMissingBanner: FC<AutoScheduleMissingBannerProps> = ({
  affectedMedications,
}) => {
  if (affectedMedications.length === 0) return null;

  const names = affectedMedications.map((m) => m.name).join('، ');

  return (
    <div
      role="status"
      data-testid="auto-schedule-missing-banner"
      className="mx-3 mt-2.5 p-3 bg-amber-50/70 border border-amber-200/80 rounded-2xl flex items-start gap-2.5 shadow-2xs"
    >
      <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">
        <CalendarX2 className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <h4 className="text-xs font-bold text-amber-950">
          {affectedMedications.length === 1
            ? 'الخصم التلقائي غير مكتمل لهذا الدواء'
            : `الخصم التلقائي غير مكتمل لـ ${affectedMedications.length} أدوية`}
        </h4>
        <p className="text-[11px] text-amber-800 mt-0.5 break-words">
          لا يوجد جدول جرعات صالح لـ «{names}»، لذلك لن يُخصم أي جرعة تلقائياً.
          أضف جدول جرعات صالحاً لتفعيل الخصم التلقائي.
        </p>
      </div>
    </div>
  );
};
