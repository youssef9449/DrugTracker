import {
  Zap,
  Pill,
  Droplets,
  Syringe,
  Package,
} from 'lucide-react';
import type { Medication } from '../types';
import './MedicationCardMaterial.css';
import { MedicationNotificationStatusBadge } from './medicationCardParts';
import { MedicationOverflowMenu } from './MedicationOverflowMenu';
export { MedicationOverflowMenu } from './MedicationOverflowMenu';
export type { MedicationOverflowMenuProps } from './MedicationOverflowMenu';

export interface MedicationMenuProps {
  medication: Medication;
  /** Effective Auto-Deduct (global ∧ medication). Used for runtime state only. */
  isAutoActive: boolean;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
  onToggleMedicationReminder?: ((id: string) => void) | undefined;
  onToggleMedicationCriticalStockAlerts?: ((id: string) => void) | undefined;
  onOpenHistory?: ((medication: Medication) => void) | undefined;
  onRegisterBackHandler?: ((id: string, close: () => void, priority?: number) => () => void) | undefined;
  size?: 'xs' | 'sm' | 'md' | undefined;
  showTypeIcon?: boolean | undefined;
  showOverflow?: boolean | undefined;
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


export function MedicationMenu({
  medication,
  isAutoActive,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
  onToggleMedicationReminder,
  onToggleMedicationCriticalStockAlerts,
  onOpenHistory,
  onRegisterBackHandler,
  size = 'sm',
  showTypeIcon = false,
  showOverflow = false,
}: MedicationMenuProps) {
  // The button edits and displays only the medication-level preference.
  // The global kill switch affects runtime execution, not this per-med UI.
  const isMedicationAutoDeductEnabled = medication.autoDeductEnabled === true;
  const autoTogglePressed = isMedicationAutoDeductEnabled;
  const autoToggleAriaLabel = isMedicationAutoDeductEnabled
    ? 'إيقاف الخصم التلقائي لهذا الدواء'
    : 'تفعيل الخصم التلقائي لهذا الدواء';
  const autoToggleTitle =
    isMedicationAutoDeductEnabled
      ? isAutoActive
        ? 'الخصم التلقائي مفعّل لهذا الدواء — اضغط للإيقاف'
        : 'إعداد الخصم التلقائي لهذا الدواء مفعّل، لكن المفتاح العام متوقف — اضغط لتغيير إعداد الدواء'
      : 'الخصم التلقائي متوقف لهذا الدواء — اضغط للتفعيل';
  const autoToggleClass = isMedicationAutoDeductEnabled
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
          className={`${iconDims} ${isMedicationAutoDeductEnabled ? 'fill-teal-600/30' : 'text-amber-600 fill-amber-400/20'}`}
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
          enabled={medication.criticalStockAlertsEnabled === true}
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
