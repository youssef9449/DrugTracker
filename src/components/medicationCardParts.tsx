import type { FC } from 'react';
import { Layers, Box, PauseCircle } from 'lucide-react';
import { Medication } from '../types';
import { AUTO_DEDUCT_PAUSED_NOTE } from '../lib/styles';

/**
 * Shared presentational sub-components for MedicationCard (audit #82).
 *
 * These blocks were duplicated 3× across the alerts/sufficient/all view
 * branches. Extracted here as small components that accept a `className`
 * prop for per-view color/size variation while sharing the content
 * (icon + text).
 */

interface StripsBadgeProps {
  medication: Medication;
  className: string;
}

/** "العلبة: {stripsPerBox} أشرطة × {pillsPerStrip} {unit}" badge. */
export const StripsBadge: FC<StripsBadgeProps> = ({ medication, className }) => (
  <span className={`flex items-center gap-0.5 font-medium ${className}`}>
    <Layers className="w-3 h-3" />
    <span>العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}</span>
  </span>
);

interface PackageSizeBadgeProps {
  medication: Medication;
  className: string;
}

/** "سعة العبوة: {packageSize} {unit}" badge. */
export const PackageSizeBadge: FC<PackageSizeBadgeProps> = ({ medication, className }) => (
  <span className={`flex items-center gap-0.5 font-medium ${className}`}>
    <Box className="w-3 h-3" />
    <span>سعة العبوة: {medication.packageSize} {medication.unit}</span>
  </span>
);

/**
 * "الخصم التلقائي معلق" note — shown on every view when auto-deduction
 * is disabled. Uses the AUTO_DEDUCT_PAUSED_NOTE class constant (#86).
 * Previously the third site (all view, L575) had the same class string
 * inline — a Wave 4 regression fixed here.
 */
export const AutoDeductPausedNote: FC = () => (
  <div className={AUTO_DEDUCT_PAUSED_NOTE}>
    <PauseCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
    <span>الخصم التلقائي معلق — الجرعة اليدوية والخصم التلقائي معطلان لهذا اليوم.</span>
  </div>
);

export interface UndoRefillBannerProps {
  lastRefillQuantity: number;
  unit: string;
  onUndoRefill: () => void;
}

/**
 * Undo refill bar — preserved for future standalone / modal usage.
 */
export const UndoRefillBanner: FC<UndoRefillBannerProps> = ({
  lastRefillQuantity,
  unit,
  onUndoRefill,
}) => (
  <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
    <span>آخر تعبئة: +{lastRefillQuantity} {unit}</span>
    <button
      type="button"
      onClick={onUndoRefill}
      className="shrink-0 rounded-lg border border-rose-200 bg-white px-2.5 py-1 font-bold text-rose-700 hover:bg-rose-50"
    >
      تراجع عن التعبئة
    </button>
  </div>
);

