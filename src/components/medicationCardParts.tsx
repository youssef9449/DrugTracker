import { DEFAULT_MEDICATION_UNIT } from '../constants/medicationDefaults';
import type { FC } from 'react';
import {
  Layers,
  Box,
  PauseCircle,
  Bell,
  BellOff,
  PillBottle,
  Pill,
  Droplets,
  Syringe,
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  Clock,
  ListChecks,
  RotateCcw,
  Calendar,
  ShoppingCart,
} from 'lucide-react';
import type { ConsumptionLog, Medication, MedicationStatusInfo } from '../types';
import { getCardDoseToggleTarget } from '../utils/doseSchedule';
import { getHistoricalRestoreDisplayAmount } from '../utils/medActions';
import { getTodayDateString } from '../utils/dateCalculations';
import { MedicationOverflowMenu } from './MedicationMenu';
import { AUTO_DEDUCT_PAUSED_NOTE } from '../lib/styles';
/**
 * Shared presentational sub-components for MedicationCard.
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
  onToggle?: (() => void) | undefined;
  size?: 'xs' | 'sm' | undefined;
  medicationId?: string | undefined;
  className?: string | undefined;
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
  onToggle?: (() => void) | undefined;
  type: 'dose' | 'critical';
  size?: 'xs' | 'sm' | undefined;
  medicationId?: string | undefined;
}
/**
 * Per-medication notification control rendered as an icon-only pill button.
 * The full state remains available through aria-label/title; visible text is
 * intentionally omitted so the controls stay compact on phone-width cards.
 */
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
      ? 'إشعار موعد الجرعة مفعّل'
      : 'إشعار موعد الجرعة متوقف'
    : enabled
      ? 'إشعار المخزون الحرج مفعّل'
      : 'إشعار المخزون الحرج متوقف';
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
      className={`font-medium rounded-full inline-flex items-center justify-center shrink-0 transition-all cursor-pointer active:scale-95 border select-none ${
        isXs ? 'w-5 h-5' : 'w-6 h-6'
      } ${
        enabled
          ? 'bg-teal-100 text-teal-800 border-teal-300/70 hover:bg-teal-200 hover:border-teal-400'
          : 'bg-slate-200/90 text-slate-600 border-slate-300 hover:bg-slate-300 hover:text-slate-700'
      }`}
    >
      {isDose ? (
        enabled ? (
          <Bell className={`${isXs ? 'w-3 h-3' : 'w-3.5 h-3.5'} fill-teal-600/30`} aria-hidden />
        ) : (
          <BellOff className={`${isXs ? 'w-3 h-3' : 'w-3.5 h-3.5'}`} aria-hidden />
        )
      ) : (
        <PillBottle className={`${isXs ? 'w-3 h-3' : 'w-3.5 h-3.5'} ${enabled ? 'fill-teal-600/30' : ''}`} aria-hidden />
      )}
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

type Density = 'compact' | 'detailed';

const densityText: Record<Density, string> = {
  compact: 'text-[8px]',
  detailed: 'text-[9px]',
};
const densityIcon: Record<Density, string> = {
  compact: 'w-2 h-2',
  detailed: 'w-2.5 h-2.5',
};
const densityBtn: Record<Density, string> = {
  compact: 'w-5 h-5',
  detailed: 'w-6 h-6',
};
const densityBtnIcon: Record<Density, string> = {
  compact: 'w-3 h-3',
  detailed: 'w-3.5 h-3.5',
};

export interface MedicationCardHeaderProps {
  medication: Medication;
  density: Density;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onOpenHistory?: ((medication: Medication) => void) | undefined;
  onRegisterBackHandler?: ((id: string, close: () => void, priority?: number) => () => void) | undefined;
}

/** Shared name + overflow menu row for compact/detailed cards. */
export const MedicationCardHeader: FC<MedicationCardHeaderProps> = ({
  medication,
  density,
  onEdit,
  onDelete,
  onOpenHistory,
  onRegisterBackHandler,
}) => (
  <div className={`flex items-center justify-between ${density === 'compact' ? 'gap-1.5 mb-1' : 'gap-2 mb-1'} min-w-0`}>
    <h3
      className={`${density === 'compact' ? 'text-[11px]' : 'text-xs'} font-bold text-slate-900 leading-tight tracking-tight truncate min-w-0 flex-1`}
      title={medication.name}
    >
      {medication.name}
    </h3>
    <MedicationOverflowMenu
      medication={medication}
      onEdit={onEdit}
      onDelete={onDelete}
      onOpenHistory={onOpenHistory}
      onRegisterBackHandler={onRegisterBackHandler}
      size={density === 'compact' ? 'xs' : 'sm'}
    />
  </div>
);

export interface MedicationCardStatusBadgesProps {
  medication: Medication;
  statusInfo: MedicationStatusInfo;
  tagBadge: string;
  density: Density;
}

/** Shared category + chronic/course + stock-status badges. */
export const MedicationCardStatusBadges: FC<MedicationCardStatusBadgesProps> = ({
  medication,
  statusInfo,
  tagBadge,
  density,
}) => {
  const isOut = statusInfo.status === 'out_of_stock';
  const isCrit = statusInfo.status === 'critical';
  const t = densityText[density];
  const icon = densityIcon[density];
  return (
    <div className={`flex items-center ${density === 'compact' ? 'gap-1 mb-1' : 'gap-1.5 mt-1'} flex-wrap min-w-0`}>
      {medication.category && (
        <span className={`${t} font-medium px-1.5 ${density === 'compact' ? 'py-0.2' : 'py-0.5'} rounded-full shrink-0 ${tagBadge}`}>
          {medication.category}
        </span>
      )}
      {medication.isChronic === false && medication.durationDays ? (
        <span className={`${t} font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-blue-50 text-blue-800 border border-blue-200`}>
          كورس {medication.durationDays} يوم
        </span>
      ) : medication.isChronic === true ? (
        <span className={`${t} font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-slate-100 text-slate-600 border border-slate-200`}>
          مزمن
        </span>
      ) : null}
      {isOut ? (
        <span className={`${t} font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 flex items-center gap-0.5 shrink-0 ${density === 'compact' ? 'w-fit' : ''}`}>
          <AlertCircle className={icon} />
          <span>نفد</span>
        </span>
      ) : isCrit ? (
        <span className={`${t} font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-800 flex items-center gap-0.5 shrink-0 ${density === 'compact' ? 'w-fit' : ''}`}>
          <Clock className={icon} />
          <span>حرج ({statusInfo.daysLeft}ي)</span>
        </span>
      ) : (
        <span className={`${t} font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 flex items-center gap-0.5 shrink-0 ${density === 'compact' ? 'w-fit' : ''}`}>
          <CheckCircle2 className={icon} />
          <span>آمن ({statusInfo.daysLeft}ي)</span>
        </span>
      )}
    </div>
  );
};

export interface MedicationCardDoseActionsProps {
  medication: Medication;
  isAutoActive: boolean;
  currentPills: number;
  logs?: ConsumptionLog[] | undefined;
  density: Density;
  onConsumeDose?: ((medicationId: string, doseId?: string) => void) | undefined;
  onRestoreDose?: ((medicationId: string, doseId?: string) => void) | undefined;
}

/**
 * Shared Take / Restore / multi-dose manage actions.
 * Single implementation of dose-action semantics for compact and detailed views.
 */
export const MedicationCardDoseActions: FC<MedicationCardDoseActionsProps> = ({
  medication,
  isAutoActive,
  currentPills,
  logs = [],
  density,
  onConsumeDose,
  onRestoreDose,
}) => {
  const doseToggle = getCardDoseToggleTarget(
    medication,
    new Date(),
    getTodayDateString(),
    false
  );
  const todayStr = getTodayDateString();
  const manualRestoreAmount = getHistoricalRestoreDisplayAmount(
    logs,
    medication.id,
    doseToggle.doseId,
    todayStr
  );
  const takeAmount = doseToggle.amount;
  const btn = densityBtn[density];
  const btnIcon = densityBtnIcon[density];

  if (
    Array.isArray(medication.doseSchedule) &&
    medication.doseSchedule.length > 1 &&
    onConsumeDose
  ) {
    return (
      <button
        type="button"
        onClick={() => onConsumeDose(medication.id, undefined)}
        title="إدارة الجرعات"
        aria-label="إدارة الجرعات"
        data-testid={`manage-doses-${medication.id}`}
        className={`${btn} flex items-center justify-center rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer`}
      >
        <ListChecks className={btnIcon} strokeWidth={2.25} aria-hidden />
      </button>
    );
  }

  if (
    (onConsumeDose || onRestoreDose) &&
    doseToggle.canRestore &&
    onRestoreDose &&
    manualRestoreAmount != null
  ) {
    return (
      <button
        type="button"
        onClick={() => onRestoreDose(medication.id, doseToggle.doseId)}
        title={`استرجاع الجرعة (+${manualRestoreAmount})`}
        aria-label={`استرجاع الجرعة (+${manualRestoreAmount})`}
        className={`${btn} flex items-center justify-center rounded-full bg-emerald-100 text-emerald-900 hover:bg-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer`}
        data-testid={`restore-dose-${medication.id}`}
      >
        <RotateCcw className={btnIcon} strokeWidth={2.25} aria-hidden />
      </button>
    );
  }

  // Manual Take availability is intentionally independent of Auto state.
  // Auto already produced durable evidence is still represented by Restore
  // above, preventing a duplicate manual action for the same occurrence.
  if (doseToggle.canTake && onConsumeDose) {
    return (
      <button
        type="button"
        onClick={() => onConsumeDose(medication.id, doseToggle.doseId)}
        disabled={currentPills <= 0 || takeAmount <= 0}
        title={`تناول جرعة (-${takeAmount})`}
        aria-label={`تناول جرعة (-${takeAmount})`}
        className={`${btn} flex items-center justify-center rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer`}
        data-testid={`take-dose-${medication.id}`}
      >
        {medication.unit === 'مل' ? (
          <Droplets className={btnIcon} strokeWidth={2.25} aria-hidden />
        ) : medication.unit === 'جرعة' ? (
          <Syringe className={btnIcon} strokeWidth={2.25} aria-hidden />
        ) : (
          <Pill className={btnIcon} strokeWidth={2.25} aria-hidden />
        )}
      </button>
    );
  }

  if (!isAutoActive && (onConsumeDose || onRestoreDose)) {
    return (
      <span
        title="تم تناول جرعة اليوم"
        className={`${btn} flex items-center justify-center rounded-full bg-emerald-100 text-emerald-700`}
      >
        <CheckCircle className={btnIcon} />
      </span>
    );
  }

  return null;
};


export interface MedicationCardStockSummaryProps {
  currentPills: number;
  unit: string;
  dailyDose: number;
  depletionLabel: string;
  depletionTitle: string;
  density: 'compact' | 'detailed';
  nonSolidPackageDesc?: string | null | undefined;
  stripsDesc?: string | null | undefined;
}

/** Shared remaining/dose/depletion summary for compact & detailed cards. */
export const MedicationCardStockSummary: FC<MedicationCardStockSummaryProps> = ({
  currentPills,
  unit,
  dailyDose,
  depletionLabel,
  depletionTitle,
  density,
  nonSolidPackageDesc,
  stripsDesc,
}) => {
  if (density === 'compact') {
    return (
      <div className="mt-1.5 p-1 bg-slate-50 rounded-xl border border-slate-100 grid grid-cols-2 gap-1 text-[9px] min-w-0">
        <div className="flex min-w-0 items-baseline gap-0.5">
          <span className="text-[8px] text-slate-500">المتبقي:</span>
          <span className={`font-mono font-extrabold text-[11px] leading-none ${currentPills === 0 ? 'text-red-600' : 'text-slate-900'}`}>
            {currentPills}
          </span>
          <span className="text-[8px] text-slate-500 truncate">{unit || DEFAULT_MEDICATION_UNIT}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
          <div className="flex shrink-0 items-center gap-0.5 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 font-mono text-teal-800 font-bold" title={`الجرعة: ${dailyDose}/يوم`}>
            <Clock className="w-2 h-2 text-teal-600" />
            <span>{dailyDose}/ي</span>
          </div>
          <div className="flex min-w-0 max-w-full items-center gap-0.5 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 text-slate-600" title={depletionTitle}>
            <Calendar className="w-2 h-2 text-slate-400 shrink-0" />
            <span className="truncate">{depletionLabel}</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-2 p-1.5 px-2 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between gap-2 text-[11px] flex-wrap">
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-[10px] text-slate-500 font-medium">المتبقي:</span>
        <span
          className={`font-extrabold font-mono text-xs ${
            currentPills === 0
              ? 'text-red-600'
              : currentPills <= dailyDose * 2
              ? 'text-rose-600'
              : 'text-slate-800'
          }`}
        >
          {currentPills}
        </span>
        <span className="text-[10px] text-slate-600 font-medium">{unit || DEFAULT_MEDICATION_UNIT}</span>
        {nonSolidPackageDesc && (
          <span className="text-[9px] text-teal-800 bg-teal-50 px-1.5 py-0.5 rounded-full border border-teal-100 font-medium truncate">
            ({nonSolidPackageDesc})
          </span>
        )}
        {stripsDesc && (
          <span className="text-[9px] text-teal-800 bg-teal-50 px-1.5 py-0.5 rounded-full border border-teal-100 font-medium truncate">
            ({stripsDesc})
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
        <div className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 font-medium">
          <Clock className="w-2.5 h-2.5 text-teal-600" />
          <span className="text-slate-400">الجرعة:</span>
          <span className="font-mono font-bold text-teal-800">{dailyDose}</span>
          <span className="text-slate-400">/يوم</span>
        </div>
        <div className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 font-medium min-w-0" title={depletionTitle}>
          <Calendar className="w-2.5 h-2.5 text-slate-400 shrink-0" />
          <span className="text-slate-400 shrink-0">النفاذ:</span>
          <span className="font-bold text-slate-800 truncate max-w-[90px]">{depletionLabel}</span>
        </div>
      </div>
    </div>
  );
};

export interface MedicationCardProgressProps {
  percentLeft: number;
  progressColor: string;
  title: string;
  density: 'compact' | 'detailed';
}

export const MedicationCardProgress: FC<MedicationCardProgressProps> = ({
  percentLeft,
  progressColor,
  title,
  density,
}) => (
  <div
    className={`${density === 'compact' ? 'mt-1' : 'mt-2'} w-full h-1 bg-slate-200/70 rounded-full overflow-hidden`}
    title={title}
  >
    <div
      className={`h-full rounded-full ${density === 'compact' ? 'transition-all duration-300' : 'transition-all duration-500'} ${progressColor}`}
      style={{ width: `${percentLeft}%` }}
    />
  </div>
);


export interface MedicationCardRefillButtonProps {
  medicationId: string;
  medicationName: string;
  density: 'compact' | 'detailed';
  onOpenRefill: () => void;
  className?: string | undefined;
}

/** Shared refill control for compact and detailed medication cards. */
export const MedicationCardRefillButton: FC<MedicationCardRefillButtonProps> = ({
  medicationId,
  medicationName,
  density,
  onOpenRefill,
  className = '',
}) => (
  <button
    type="button"
    onClick={onOpenRefill}
    className={
      className ||
      (density === 'compact'
        ? 'inline-flex h-7 items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2 text-[10px] font-semibold text-teal-800 hover:bg-teal-100 active:scale-95 transition cursor-pointer'
        : 'inline-flex h-8 items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-2.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-100 active:scale-95 transition cursor-pointer')
    }
    aria-label={`إعادة تعبئة ${medicationName}`}
    data-testid={`medication-refill-${medicationId}`}
  >
    <ShoppingCart className={density === 'compact' ? 'w-3.5 h-3.5 text-teal-700' : 'w-4 h-4 text-teal-700'} />
    <span>تعبئة</span>
  </button>
);
