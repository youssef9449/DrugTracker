import type { FC } from 'react';
import type { ConsumptionLog, Medication } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { describeStockInStrips, isSolidUnit } from '../utils/medicationPackaging';
import { getDepletionDate } from '../utils/dateCalculations';
import { isMedicationAutoDeductActive } from '../utils/doseSchedule';
import { pluralizeArabic } from '../lib/arabicPlural';
import { VISUAL_RANGE_MULTIPLIER, MIN_VISUAL_RANGE_DAYS, DAYS_PER_MONTH } from '../utils/time';
import {
  MedicationCardAlertsView,
  MedicationCardSufficientView,
  MedicationCardCompactView,
  MedicationCardDetailedView,
} from './MedicationCardViews';

/**
 * Map a medication's `colorTag` (the user-selected card color from the
 * AddMedicationModal color picker) to Tailwind classes used for the card's
 * icon box + left border accent + category badge. The status-based color
 * (red/rose/amber for out-of-stock/critical/warning) still takes priority
 * for the icon box in the alerts view, but the left border and category
 * badge always show the user's chosen color so the selection has a visible effect.
 *
 * Returns a { bg, border, badge } triplet of class strings. Unknown tags default
 * to teal (the app's primary theme).
 */
function colorTagClasses(colorTag: string | undefined): { bg: string; border: string; badge: string } {
  switch (colorTag) {
    case 'rose':
      return {
        bg: 'bg-rose-50 text-rose-700',
        border: 'border-r-rose-400',
        badge: 'bg-rose-50 text-rose-800 border border-rose-200/80',
      };
    case 'amber':
      return {
        bg: 'bg-amber-50 text-amber-700',
        border: 'border-r-amber-400',
        badge: 'bg-amber-50 text-amber-900 border border-amber-200/80',
      };
    case 'sky':
      return {
        bg: 'bg-sky-50 text-sky-700',
        border: 'border-r-sky-400',
        badge: 'bg-sky-50 text-sky-800 border border-sky-200/80',
      };
    case 'violet':
      return {
        bg: 'bg-violet-50 text-violet-700',
        border: 'border-r-violet-400',
        badge: 'bg-violet-50 text-violet-800 border border-violet-200/80',
      };
    case 'teal':
    default:
      return {
        bg: 'bg-teal-50 text-teal-700',
        border: 'border-r-teal-400',
        badge: 'bg-teal-50 text-teal-800 border border-teal-200/80',
      };
  }
}
interface MedicationCardProps {
  medication: Medication;
  viewFilter?: 'all' | 'alerts' | 'sufficient';
  isCompact?: boolean;
  onOpenRefill: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
  onToggleMedicationReminder?: (id: string) => void;
  onToggleMedicationCriticalStockAlerts?: (id: string) => void;
  onNavigateToShopping?: () => void;
  onTriggerAlarm?: (medication: Medication) => void;
  onConsumeDose?: (medicationId: string, doseId?: string) => void;
  /** Restore a manually consumed dose via the same App path as logs. */
  onRestoreDose?: (medicationId: string, doseId?: string) => void;
  onOpenHistory?: (medication: Medication) => void;
  /** Durable stock logs used to display the exact historical Restore amount. */
  logs?: ConsumptionLog[];
  lastRefillQuantity?: number;
  onUndoRefill?: () => void;
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void;
}
export const MedicationCard: FC<MedicationCardProps> = ({
  medication,
  viewFilter = 'all',
  isCompact = false,
  onOpenRefill,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
  onToggleMedicationReminder,
  onToggleMedicationCriticalStockAlerts,
  onNavigateToShopping,
  onConsumeDose,
  onRestoreDose,
  onOpenHistory,
  logs = [],
  lastRefillQuantity,
  onUndoRefill,
  onRegisterBackHandler,
}) => {
  const isAutoActive = isMedicationAutoDeductActive(medication);
  // Durable currentPills is the sole live stock balance.
  const statusInfo = calculateMedicationStatus(medication);
  const depletion = getDepletionDate(medication);
  const isSolid = isSolidUnit(medication.unit);
  const hasStrips = isSolid && Boolean(medication.stripsPerBox && medication.pillsPerStrip);
  const currentPills = Number(medication.currentPills) || 0;
  const stripsDesc = isSolid
    ? describeStockInStrips(
        currentPills,
        medication.pillsPerStrip,
        medication.stripsPerBox,
        medication.unit
      )
    : null;
  // For non-solid medications, show only the number of complete packages
  // when at least one full package exists. Partial packages stay unlabelled.
  const nonSolidPackageCount =
    !isSolid &&
    medication.packageSize &&
    medication.packageSize > 0
      ? Math.floor(currentPills / medication.packageSize)
      : 0;
  const nonSolidPackageDesc =
    nonSolidPackageCount > 0
      ? pluralizeArabic(nonSolidPackageCount, medication.unit === 'مل' ? 'عبوة' : 'علبة')
      : null;
  // The user-selected colorTag drives the icon box background, accent border, and category badge
  const tag = colorTagClasses(medication.colorTag);
  // Maximum visual scale for the stock progress bar.
  // If the medication has an explicit temporary treatment duration (not chronic),
  // the visual range is determined by its duration of use.
  // If it is chronic (or default), the visual range remains month-based (≈ 30 days).
  const isTemporaryCourse =
    medication.isChronic === false &&
    typeof medication.durationDays === 'number' &&
    medication.durationDays > 0;
  const packageDays =
    medication.packageSize && medication.packageSize > 0 && medication.dailyDose > 0
      ? medication.packageSize / medication.dailyDose
      : DAYS_PER_MONTH;
  const maxVisualRange = isTemporaryCourse
    ? medication.durationDays!
    : Math.max(
        packageDays,
        medication.warningThresholdDays * VISUAL_RANGE_MULTIPLIER,
        MIN_VISUAL_RANGE_DAYS
      );
  const percentLeft = Math.min(
    100,
    Math.max(0, Math.round((statusInfo.daysLeft / maxVisualRange) * 100))
  );
  const getProgressColor = () => {
    switch (statusInfo.status) {
      case 'out_of_stock':
        return 'bg-red-500';
      case 'critical':
        return 'bg-rose-500';
      case 'warning':
        return 'bg-amber-500';
      default:
        return 'bg-teal-600';
    }
  };
  // Retained for future use (per user instruction, not rendered inside cards):
  void lastRefillQuantity;
  void onUndoRefill;
  // -------------------------------------------------------------
  // VIEW 1: "قارب على النفاذ" (ALERTS) - Focus on Urgency & Refill
  // -------------------------------------------------------------
  const viewProps = {
    medication,
    isAutoActive,
    statusInfo,
    depletion,
    isSolid,
    hasStrips,
    currentPills,
    stripsDesc,
    nonSolidPackageDesc,
    tag,
    percentLeft,
    getProgressColor,
    onOpenRefill,
    onEdit,
    onDelete,
    onToggleAutoDeduct,
    onToggleMedicationReminder,
    onToggleMedicationCriticalStockAlerts,
    onNavigateToShopping,
    onConsumeDose,
    onRestoreDose,
    onOpenHistory,
    logs,
    onRegisterBackHandler,
  };

  if (viewFilter === 'alerts') {
    return <MedicationCardAlertsView {...viewProps} />;
  }

  if (viewFilter === 'sufficient') {
    return <MedicationCardSufficientView {...viewProps} />;
  }

  if (isCompact && viewFilter === 'all') {
    return <MedicationCardCompactView {...viewProps} />;
  }

  return <MedicationCardDetailedView {...viewProps} />;

};