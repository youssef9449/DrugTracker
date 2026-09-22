import type { FC } from 'react';
import { Layers, Box, PauseCircle, Bell, BellOff, AlertTriangle } from 'lucide-react';
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
 * Note shown when effective auto-deduction is inactive (!isAutoActive).
 * Describes only that auto-deduct is stopped — never that manual Take is
 * disabled (manual Take remains available whenever doseToggle.canTake).
 */
export const AutoDeductPausedNote: FC = () => (
  <div className={AUTO_DEDUCT_PAUSED_NOTE}>
    <PauseCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
    <span>الخصم التلقائي متوقف حاليًا — يمكنك تسجيل الجرعة يدويًا.</span>
  </div>
);

interface AutoDeductStatusBadgeProps {
  isAutoActive: boolean;
  onToggle?: () => void;
  size?: 'xs' | 'sm';
  medicationId?: string;
  className?: string;
}

/**
 * Status card / badge indicating the medication's Auto-Deduction state.
 * Rendered alongside the category badge in "All Medications" view.
 */
export const AutoDeductStatusBadge: FC<AutoDeductStatusBadgeProps> = ({
  isAutoActive,
  onToggle,
  size = 'sm',
  medicationId,
  className = '',
}) => {
  const isXs = size === 'xs';
  const label = isAutoActive ? 'خصم تلقائي: مفعّل' : 'خصم تلقائي: متوقف';
  const title = isAutoActive
    ? 'الخصم التلقائي مفعّل (انقر للتعطيل)'
    : 'الخصم التلقائي متوقف (انقر للتفعيل)';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      data-testid={medicationId ? `auto-deduct-badge-${medicationId}` : 'auto-deduct-badge'}
      title={title}
      aria-label={label}
      className={`font-medium rounded-full inline-flex items-center shrink-0 transition-all cursor-pointer active:scale-95 border select-none ${
        isXs
          ? 'text-[8px] px-1.5 py-0.5'
          : 'text-[9px] px-2 py-0.5'
      } ${
        isAutoActive
          ? 'bg-teal-50 text-teal-800 border-teal-200/90 hover:bg-teal-100 hover:border-teal-300'
          : 'bg-amber-50 text-amber-800 border-amber-200/90 hover:bg-amber-100 hover:border-amber-300'
      } ${className}`}
    >
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
};
/**
 * Small per-medication notification toggle with the same geometry and visual
 * language as AutoDeductStatusBadge. The feature-specific color identifies
 * the notification type while the disabled state becomes neutral.
 */
interface MedicationNotificationStatusBadgeProps {
  enabled: boolean;
  onToggle?: () => void;
  type: 'dose' | 'critical';
  size?: 'xs' | 'sm';
  medicationId?: string;
}

export const MedicationNotificationStatusBadge: FC<MedicationNotificationStatusBadgeProps> = ({
  enabled,
  onToggle,
  type,
  size = 'sm',
  medicationId,
}) => {
  const isXs = size === 'xs';
  const isDose = type === 'dose';
  const label = isDose
    ? enabled
      ? 'إشعار الجرعة: مفعّل'
      : 'إشعار الجرعة: متوقف'
    : enabled
      ? 'مخزون حرج: مفعّل'
      : 'مخزون حرج: متوقف';
  const title = enabled
    ? `${isDose ? 'إشعار موعد الجرعة' : 'إشعار المخزون الحرج'} مفعّل (انقر للتعطيل)`
    : `${isDose ? 'إشعار موعد الجرعة' : 'إشعار المخزون الحرج'} متوقف (انقر للتفعيل)`;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      title={title}
      aria-label={label}
      aria-pressed={enabled}
      data-testid={
        medicationId
          ? `${isDose ? 'dose-reminder-badge' : 'critical-stock-alert-badge'}-${medicationId}`
          : undefined
      }
      className={`font-medium rounded-full inline-flex items-center shrink-0 transition-all cursor-pointer active:scale-95 border select-none ${
        isXs ? 'text-[8px] px-1.5 py-0.5' : 'text-[9px] px-2 py-0.5'
      } ${
        enabled
          ? isDose
            ? 'bg-teal-50 text-teal-800 border-teal-200/90 hover:bg-teal-100 hover:border-teal-300'
            : 'bg-rose-50 text-rose-800 border-rose-200/90 hover:bg-rose-100 hover:border-rose-300'
          : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
      }`}
    >
      {isDose ? (
        enabled ? <Bell className="w-3 h-3" aria-hidden /> : <BellOff className="w-3 h-3" aria-hidden />
      ) : (
        <AlertTriangle className="w-3 h-3" aria-hidden />
      )}
      <span className="whitespace-nowrap mr-0.5">{label}</span>
    </button>
  );
};



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
      className="shrink-0 rounded-full border border-rose-200 bg-white px-3 py-1 font-bold text-rose-700 hover:bg-rose-50 active:bg-rose-100 transition-colors cursor-pointer"
    >
      تراجع عن التعبئة
    </button>
  </div>
);

