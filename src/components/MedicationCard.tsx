import type { FC } from 'react';
import {
  Pill,
  Plus,
  Calendar,
  AlertCircle,
  CheckCircle2,
  CheckCircle,
  RotateCcw,
  ShoppingCart,
  Clock,
  ListChecks,
} from 'lucide-react';
import type { ConsumptionLog } from '../types';
import { Medication, calculateMedicationStatus, describeStockInStrips, isSolidUnit } from '../types';
import {
  getDepletionDate,
  getTodayDateString,
} from '../utils/dateCalculations';
import {
  getCardDoseToggleTarget,
  isMedicationAutoDeductActive,
} from '../utils/doseSchedule';
import { getHistoricalRestoreDisplayAmount } from '../utils/medActions';
import { pluralizeArabic } from '../lib/arabicPlural';
import { VISUAL_RANGE_MULTIPLIER, MIN_VISUAL_RANGE_DAYS, DAYS_PER_MONTH } from '../utils/time';
import { MedicationMenu } from './MedicationMenu';
import { ReminderBadge } from './ReminderBadge';
import {
  StripsBadge,
  PackageSizeBadge,
  AutoDeductPausedNote,
  AutoDeductStatusBadge,
  MedicationNotificationStatusBadge,
} from './medicationCardParts';

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

/**
 * A SHORT depletion label for the tight "جميع الأدوية" card rows
 * (compact + detailed). `getDepletionDate().formattedArabic` includes
 * the full weekday name for far-future dates (e.g. "الأربعاء، ٣٠
 * سبتمبر"), which is too long for the small pill in these rows and
 * overlaps neighboring content. Here we drop the weekday and only
 * keep "يوم شهر" (e.g. "٣٠ سبتمبر"), while keeping the near-term
 * wording ("اليوم"/"غداً"/"بعد غد"/"نفد المخزون") unchanged.
 */
function shortDepletionLabel(
  depletion: { dateStr: string; daysLeft: number },
  isOut: boolean
): string {
  if (isOut) return 'نفد المخزون';
  if (depletion.daysLeft === 0) return 'اليوم';
  if (depletion.daysLeft === 1) return 'غداً';
  if (depletion.daysLeft === 2) return 'بعد غد';
  const target = new Date(`${depletion.dateStr}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return depletion.dateStr;
  return target.toLocaleDateString('ar-EG', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
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
}) => {
  const isAutoActive = isMedicationAutoDeductActive(medication);
  // Issue #266: durable currentPills is the sole live stock balance.
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
  if (viewFilter === 'alerts') {
    const isOut = statusInfo.status === 'out_of_stock';
    const isCrit = statusInfo.status === 'critical';

    return (
      <div
        id={`med-card-${medication.id}`}
        className={`rounded-2xl border p-4 shadow-xs transition relative overflow-hidden ${
          isOut
            ? 'bg-red-50/40 border-red-200'
            : isCrit
            ? 'bg-rose-50/40 border-rose-200'
            : 'bg-amber-50/30 border-amber-200'
        }`}
      >
        {/* Row 1: Name — alone on its own full-width line */}
        <h3 className="text-base font-bold text-slate-900 leading-snug tracking-tight truncate mb-1.5 block w-full" title={medication.name}>
          {medication.name}
        </h3>

        {/* Row 2: Badges (Status, Category, Strips) + Quick Menu */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 flex-wrap min-w-0">
            <span
              className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                isOut
                  ? 'bg-red-600 text-white'
                  : isCrit
                  ? 'bg-rose-600 text-white'
                  : 'bg-amber-600 text-white'
              }`}
            >
              {isOut
                ? 'نفد المخزون بالكامل'
                : isCrit
                ? `حرج: ينفد خلال ${pluralizeArabic(statusInfo.daysLeft, 'يوم')}`
                : `تنبيه: متبقي ${statusInfo.daysLeft} أيام`}
            </span>
            {medication.category && (
              <span className={`font-medium px-1.5 py-0.2 rounded text-[10px] shrink-0 ${tag.badge}`}>
                {medication.category}
              </span>
            )}
            {medication.isChronic === false && medication.durationDays ? (
              <span className="font-medium px-1.5 py-0.2 rounded text-[10px] shrink-0 bg-blue-50 text-blue-800 border border-blue-200">
                كورس {medication.durationDays} يوم
              </span>
            ) : medication.isChronic !== false ? (
              <span className="font-medium px-1.5 py-0.2 rounded text-[10px] shrink-0 bg-slate-100 text-slate-600 border border-slate-200">
                مزمن
              </span>
            ) : null}
            <span>معدل الخصم: {medication.dailyDose} {medication.unit}/يوم</span>
            {hasStrips && (
              <StripsBadge medication={medication} className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded shrink-0" />
            )}
            {!isSolid && medication.packageSize && medication.packageSize > 0 && (
              <PackageSizeBadge medication={medication} className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded shrink-0" />
            )}
          </div>

          {/* Quick Menu (extracted — see MedicationMenu.tsx) */}
          <MedicationMenu
            medication={medication}
            isAutoActive={isAutoActive}
            onOpenRefill={onOpenRefill}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleAutoDeduct={onToggleAutoDeduct}
            onOpenHistory={onOpenHistory}
          />
        </div>

        {/* Urgency Highlight Card: Days left countdown + Exact depletion date */}
        <div className="mt-3 p-3 bg-white rounded-xl border border-slate-200/90 flex items-center justify-between gap-3 text-xs">
          <div>
            <span className="text-[11px] text-slate-500 block">المتبقي حالياً:</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span
                className={`text-2xl font-extrabold font-mono ${
                  isOut ? 'text-red-600' : 'text-rose-600'
                }`}
              >
                {currentPills}
              </span>
              <span className="text-xs text-slate-600 font-medium">
                {medication.unit}
              </span>
            </div>
            {stripsDesc && (
              <span className="text-[11px] text-slate-500 font-medium block mt-0.5">
                ({stripsDesc})
              </span>
            )}
          </div>

          <div className="text-left">
            <span className="text-[11px] text-slate-500 block">تاريخ النفاذ التقديري:</span>
            <span className="font-bold text-slate-900 block mt-0.5 text-xs">
              {depletion.formattedArabic}
            </span>
            <span className="text-[10px] text-slate-500 font-mono">
              {isOut
                ? '(المخزون نفد بالكامل)'
                : statusInfo.daysLeft === 1
                ? '(يوم واحد متبقي)'
                : statusInfo.daysLeft === 2
                ? '(يومان متبقيان)'
                : statusInfo.daysLeft <= 10
                ? `(${statusInfo.daysLeft} أيام متبقية)`
                : `(${statusInfo.daysLeft} يوماً متبقياً)`}
            </span>
          </div>
        </div>

        {/* Scheduled Reminder Badge (extracted — see ReminderBadge.tsx) */}
        <ReminderBadge
          medication={medication}
          containerClass="bg-white/90 border-amber-200 mt-2"
          textClass="text-amber-950"
          badgeClass="text-amber-900 bg-amber-100"
        />

        {/* Quick Action: Immediate Refill + Shopping List CTA */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => onOpenRefill(medication)}
            className="flex-1 h-9 px-4 rounded-full bg-teal-700 hover:bg-teal-800 text-white font-semibold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-2xs cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>تعبئة رصيد</span>
          </button>

          {onNavigateToShopping && (
            <button
              onClick={onNavigateToShopping}
              className="h-9 px-4 rounded-full bg-white hover:bg-slate-50 text-teal-800 border border-teal-300 font-semibold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 cursor-pointer shrink-0"
              title="تجهيز طلب الشراء في الواتساب"
            >
              <ShoppingCart className="w-3.5 h-3.5 text-teal-700" />
              <span>طلب واتساب</span>
            </button>
          )}
        </div>

        {/* Auto-deduct paused note — shown on every view when the
            auto-deduction is disabled, with the dose-taken status. */}
        {!isAutoActive && <AutoDeductPausedNote />}
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW 2: "المخزون الكافي" (SUFFICIENT) - Focus on Safety & Duration
  // -------------------------------------------------------------
  if (viewFilter === 'sufficient') {
    const safeDays = statusInfo.daysLeft;
    const monthlyUsage = medication.dailyDose * DAYS_PER_MONTH;

    return (
      <div
        id={`med-card-${medication.id}`}
        className="bg-white rounded-2xl border border-emerald-200/80 p-4 shadow-xs hover:shadow-md transition relative overflow-hidden"
      >
        {/* Row 1: Name — alone on its own full-width line */}
        <h3 className="text-base font-bold text-slate-900 leading-snug tracking-tight truncate mb-1.5 block w-full" title={medication.name}>
          {medication.name}
        </h3>

        {/* Row 2: Badges (Safety, Category, Strips) + Options Menu */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 flex-wrap min-w-0">
            <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1 shrink-0">
              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              <span>مخزون آمن ومريح</span>
            </span>
            {medication.category && (
              <span className={`font-medium px-1.5 py-0.2 rounded text-[10px] shrink-0 ${tag.badge}`}>
                {medication.category}
              </span>
            )}
            {hasStrips && (
              <StripsBadge medication={medication} className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50 shrink-0" />
            )}
            {!isSolid && medication.packageSize && medication.packageSize > 0 && (
              <PackageSizeBadge medication={medication} className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50 shrink-0" />
            )}
            {medication.notes && (
              <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                {medication.notes}
              </span>
            )}
          </div>

          {/* Options Menu (extracted — see MedicationMenu.tsx) */}
          <MedicationMenu
            medication={medication}
            isAutoActive={isAutoActive}
            onOpenRefill={onOpenRefill}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleAutoDeduct={onToggleAutoDeduct}
            onOpenHistory={onOpenHistory}
          />
        </div>

        {/* Coverage & Stability metrics */}
        <div className="mt-3 p-2.5 bg-emerald-50/40 rounded-xl border border-emerald-100/80 grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-[10px] text-slate-500 block">المخزون المتوفر</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-extrabold font-mono text-emerald-900">
                {currentPills}
              </span>
              <span className="text-[11px] text-slate-600">
                {medication.unit}
              </span>
            </div>
            {stripsDesc && (
              <span className="text-[10px] text-emerald-800 font-medium block truncate mt-0.5">
                ({stripsDesc})
              </span>
            )}
          </div>

          <div>
            <span className="text-[10px] text-slate-500 block">الاستهلاك اليومي</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-extrabold font-mono text-teal-800">
                {medication.dailyDose}
              </span>
              <span className="text-[11px] text-slate-600">
                / يوم
              </span>
            </div>
          </div>

          <div>
            <span className="text-[10px] text-slate-500 block">الاستهلاك الشهري</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-extrabold font-mono text-slate-700">
                {monthlyUsage}
              </span>
              <span className="text-[11px] text-slate-600">
                / شهر
              </span>
            </div>
          </div>
        </div>

        {/* Coverage Guarantee Statement */}
        <div className="mt-2.5 p-2 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-slate-600">
            <Calendar className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span className="text-[11px]">مخزونك يكفي حتى:</span>
          </div>
          <span className="font-bold text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">
            {depletion.formattedArabic} ({safeDays} يوم أمان)
          </span>
        </div>

        {/* Scheduled Reminder Badge (extracted — see ReminderBadge.tsx) */}
        <ReminderBadge
          medication={medication}
          containerClass="bg-emerald-50/70 border-emerald-200/80 mt-2"
          textClass="text-emerald-950"
          badgeClass="text-emerald-900 bg-emerald-100"
        />

        {/* Auto-deduct paused note */}
        {!isAutoActive && <AutoDeductPausedNote />}
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW 3: "جميع الأدوية" (ALL) - Comprehensive Inventory Management
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // COMPACT VIEW: "جميع الأدوية" (ALL - COMPACT MODE)
  // Dense layout: reduces height by ~70% while keeping all critical
  // details (Name, Stock, Unit, Strips, Daily Dose, Depletion date,
  // status badge, visual progress bar, refill, consume, and menu).
  // -------------------------------------------------------------
  // COMPACT (MINI) VIEW: same features, aggressively compressed height
  // -------------------------------------------------------------
  if (isCompact && viewFilter === 'all') {
    const isOut = statusInfo.status === 'out_of_stock';
    const isCrit = statusInfo.status === 'critical';
    const isWarn = statusInfo.status === 'warning';
    const doseToggle = getCardDoseToggleTarget(medication, new Date(), getTodayDateString());
    const todayStr = getTodayDateString();
    // Manual Restore display amount: exact active deduction for doseToggle.doseId only.
    // No schedule fallback when evidence is missing (durable layer fail-closes).
    const manualRestoreAmount = getHistoricalRestoreDisplayAmount(
      logs,
      medication.id,
      doseToggle.doseId,
      todayStr
    );
    // Take uses current schedule slot amount from the manual toggle target.
    const takeAmount = doseToggle.amount;

    return (
      <div
        id={`med-card-${medication.id}`}
        className={`bg-white rounded-2xl border border-slate-200 p-2 shadow-sm hover:shadow-md transition-shadow duration-200 relative overflow-hidden border-r-[3px] ${tag.border} ${
          isOut ? 'bg-red-50/25' : isCrit ? 'bg-rose-50/20' : isWarn ? 'bg-amber-50/10' : ''
        }`}
      >
        {/* Row 1: name — alone on its own full-width line */}
        <h3 className="block w-full text-[11px] font-bold text-slate-900 leading-tight tracking-tight truncate mb-1" title={medication.name}>
          {medication.name}
        </h3>

        {/* Row 2: Category + Auto-Deduct Status + Stock Status (independent of name and actions) */}
        <div className="flex items-center gap-1 flex-wrap min-w-0 mb-1">
          {medication.category && (
            <span className={`text-[8px] font-medium px-1.5 py-0.2 rounded-full shrink-0 ${tag.badge}`}>
              {medication.category}
            </span>
          )}
          {medication.isChronic === false && medication.durationDays ? (
            <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-blue-50 text-blue-800 border border-blue-200">
              كورس {medication.durationDays} يوم
            </span>
          ) : medication.isChronic !== false ? (
            <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-slate-100 text-slate-600 border border-slate-200">
              مزمن
            </span>
          ) : null}

          {isOut ? (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 flex items-center gap-0.5 shrink-0 w-fit">
              <AlertCircle className="w-2 h-2" />
              <span>نفد</span>
            </span>
          ) : isCrit ? (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-800 flex items-center gap-0.5 shrink-0 w-fit">
              <Clock className="w-2 h-2" />
              <span>حرج ({statusInfo.daysLeft}ي)</span>
            </span>
          ) : isWarn ? (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900 flex items-center gap-0.5 shrink-0 w-fit">
              <Clock className="w-2 h-2" />
              <span>تنبيه ({statusInfo.daysLeft}ي)</span>
            </span>
          ) : (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 flex items-center gap-0.5 shrink-0 w-fit">
              <CheckCircle2 className="w-2 h-2" />
              <span>آمن ({statusInfo.daysLeft}ي)</span>
            </span>
          )}
        </div>

        {/* Actions row (independent of Category/Status) */}
        <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
            {Array.isArray(medication.doseSchedule) &&
            medication.doseSchedule.length > 1 &&
            onConsumeDose ? (
              <button
                type="button"
                onClick={() => onConsumeDose(medication.id, undefined)}
                title="إدارة الجرعات"
                aria-label="إدارة الجرعات"
                data-testid={`manage-doses-${medication.id}`}
                className="w-5 h-5 flex items-center justify-center rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer"
              >
                <ListChecks className="w-3 h-3" strokeWidth={2.25} aria-hidden />
              </button>
            ) : (onConsumeDose || onRestoreDose) ? (
              doseToggle.canRestore &&
              onRestoreDose &&
              manualRestoreAmount != null ? (
                <button
                  type="button"
                  onClick={() => onRestoreDose(medication.id, doseToggle.doseId)}
                  title={
                    manualRestoreAmount != null
                      ? `استرجاع الجرعة (+${manualRestoreAmount})`
                      : 'استرجاع الجرعة'
                  }
                  aria-label={
                    manualRestoreAmount != null
                      ? `استرجاع الجرعة (+${manualRestoreAmount})`
                      : 'استرجاع الجرعة'
                  }
                  className="w-5 h-5 flex items-center justify-center rounded-full bg-emerald-100 text-emerald-900 hover:bg-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer"
                  data-testid={`restore-dose-${medication.id}`}
                >
                  <RotateCcw className="w-3 h-3" strokeWidth={2.25} aria-hidden />
                </button>
              ) : !isAutoActive && doseToggle.canTake && onConsumeDose ? (
                <button
                  type="button"
                  onClick={() => onConsumeDose(medication.id, doseToggle.doseId)}
                  disabled={currentPills <= 0 || takeAmount <= 0}
                  title={`تناول جرعة (-${takeAmount})`}
                  aria-label={`تناول جرعة (-${takeAmount})`}
                  className={`w-5 h-5 flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 focus-visible:ring-offset-1 active:scale-95 cursor-pointer ${
                    currentPills <= 0 || takeAmount <= 0
                      ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                      : 'bg-emerald-600 text-white hover:bg-emerald-700'
                  }`}
                >
                  <Pill className="w-3 h-3 rotate-45" aria-hidden />
                </button>
              ) : !isAutoActive ? (
                <span
                  title="تم تناول جرعة اليوم"
                  className="w-5 h-5 flex items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                >
                  <CheckCircle className="w-3 h-3" />
                </span>
              ) : null
            ) : null}
            <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onOpenRefill(medication)}
              title="تعبئة"
              className="w-5 h-5 flex items-center justify-center rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 transition-colors active:scale-95 cursor-pointer"
            >
              <Plus className="w-3 h-3" />
            </button>
            <MedicationMenu
              medication={medication}
              isAutoActive={isAutoActive}
              onOpenRefill={onOpenRefill}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleAutoDeduct={onToggleAutoDeduct}
              onToggleMedicationReminder={onToggleMedicationReminder}
              onToggleMedicationCriticalStockAlerts={onToggleMedicationCriticalStockAlerts}
              onOpenHistory={onOpenHistory}
            />
            </div>
        </div>

        {/* Row 3: stock · dose · depletion — surface container */}
        <div className="mt-1.5 p-1 bg-slate-50 rounded-xl border border-slate-100 grid grid-cols-2 gap-1 text-[9px] min-w-0">
          <div className="flex min-w-0 items-baseline gap-0.5">
            <span className="text-[8px] text-slate-500">المتبقي:</span>
            <span className={`font-mono font-extrabold text-[11px] leading-none ${currentPills === 0 ? 'text-red-600' : 'text-slate-900'}`}>
              {currentPills}
            </span>
            <span className="text-[8px] text-slate-500 truncate">{medication.unit || 'قرص'}</span>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
            <div className="flex shrink-0 items-center gap-0.5 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 font-mono text-teal-800 font-bold" title={`الجرعة: ${medication.dailyDose}/يوم`}>
              <Clock className="w-2 h-2 text-teal-600" />
              <span>{medication.dailyDose}/ي</span>
            </div>
            <div className="flex min-w-0 max-w-full items-center gap-0.5 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 text-slate-600" title={`النفاذ: ${depletion.formattedArabic}`}>
              <Calendar className="w-2 h-2 text-slate-400 shrink-0" />
              <span className="truncate">{shortDepletionLabel(depletion, isOut)}</span>
            </div>
          </div>
        </div>

        {/* Row 3: progress only */}
        <div
          className="mt-1 w-full h-1 bg-slate-200/70 rounded-full overflow-hidden"
          title={
            isTemporaryCourse
              ? `كورس علاجي (${medication.durationDays} يوم): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
              : `دواء مزمن (مقياس شهري): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
          }
        >
          <div
            className={`h-full rounded-full transition-all duration-300 ${getProgressColor()}`}
            style={{ width: `${percentLeft}%` }}
          />
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------
  // DETAILED VIEW for "all": former compact card (medium density)
  // -------------------------------------------------------------
  if (viewFilter === 'all') {

    const isOut = statusInfo.status === 'out_of_stock';
    const isCrit = statusInfo.status === 'critical';
    const isWarn = statusInfo.status === 'warning';
    const doseToggle = getCardDoseToggleTarget(medication, new Date(), getTodayDateString());
    const todayStr = getTodayDateString();
    // Manual Restore display amount: exact active deduction for doseToggle.doseId only.
    // No schedule fallback when evidence is missing (durable layer fail-closes).
    const manualRestoreAmount = getHistoricalRestoreDisplayAmount(
      logs,
      medication.id,
      doseToggle.doseId,
      todayStr
    );
    // Take uses current schedule slot amount from the manual toggle target.
    const takeAmount = doseToggle.amount;

    return (
      <div
        id={`med-card-${medication.id}`}
        className={`bg-white rounded-2xl border border-slate-200 p-2.5 shadow-sm hover:shadow-md transition-shadow duration-200 relative overflow-hidden border-r-[3px] ${tag.border} ${
          isOut
            ? 'bg-red-50/20'
            : isCrit
            ? 'bg-rose-50/20'
            : isWarn
            ? 'bg-amber-50/15'
            : ''
        }`}
      >
        {/* Row 1: Name — alone on its own full-width line */}
        <h3 className="text-xs font-bold text-slate-900 leading-tight tracking-tight truncate" title={medication.name}>
          {medication.name}
        </h3>

        {/* Row 2: Category + Auto-Deduct Status + Stock Status (independent of name and actions) */}
        <div className="flex items-center gap-1.5 flex-wrap min-w-0 mt-1">
          {medication.category && (
            <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${tag.badge}`}>
              {medication.category}
            </span>
          )}
          {medication.isChronic === false && medication.durationDays ? (
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-blue-50 text-blue-800 border border-blue-200">
              كورس {medication.durationDays} يوم
            </span>
          ) : medication.isChronic !== false ? (
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full shrink-0 bg-slate-100 text-slate-600 border border-slate-200">
              مزمن
            </span>
          ) : null}

          {isOut ? (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 flex items-center gap-0.5 shrink-0">
              <AlertCircle className="w-2.5 h-2.5" />
              <span>نفد</span>
            </span>
          ) : isCrit ? (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-800 flex items-center gap-0.5 shrink-0">
              <Clock className="w-2.5 h-2.5" />
              <span>حرج ({statusInfo.daysLeft}ي)</span>
            </span>
          ) : isWarn ? (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900 flex items-center gap-0.5 shrink-0">
              <Clock className="w-2.5 h-2.5" />
              <span>تنبيه ({statusInfo.daysLeft}ي)</span>
            </span>
          ) : (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 flex items-center gap-0.5 shrink-0">
              <CheckCircle2 className="w-2.5 h-2.5" />
              <span>آمن ({statusInfo.daysLeft}ي)</span>
            </span>
          )}
        </div>

        {/* Actions row (independent of Category/Status) */}
        <div className="flex flex-wrap items-center justify-end gap-1 shrink-0 mt-1">
            {Array.isArray(medication.doseSchedule) &&
            medication.doseSchedule.length > 1 &&
            onConsumeDose ? (
              <button
                type="button"
                onClick={() => onConsumeDose(medication.id, undefined)}
                title="إدارة الجرعات"
                aria-label="إدارة الجرعات"
                data-testid={`manage-doses-${medication.id}`}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer"
              >
                <ListChecks className="w-3.5 h-3.5" strokeWidth={2.25} aria-hidden />
              </button>
            ) : (onConsumeDose || onRestoreDose) ? (
              doseToggle.canRestore &&
              onRestoreDose &&
              manualRestoreAmount != null ? (
                <button
                  type="button"
                  onClick={() => onRestoreDose(medication.id, doseToggle.doseId)}
                  title={
                    manualRestoreAmount != null
                      ? `استرجاع الجرعة (+${manualRestoreAmount})`
                      : 'استرجاع الجرعة'
                  }
                  aria-label={
                    manualRestoreAmount != null
                      ? `استرجاع الجرعة (+${manualRestoreAmount})`
                      : 'استرجاع الجرعة'
                  }
                  className="w-6 h-6 flex items-center justify-center rounded-full bg-emerald-100 text-emerald-900 hover:bg-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 focus-visible:ring-offset-1 transition-colors active:scale-95 cursor-pointer"
                  data-testid={`restore-dose-${medication.id}`}
                >
                  <RotateCcw className="w-3.5 h-3.5" strokeWidth={2.25} aria-hidden />
                </button>
              ) : !isAutoActive && doseToggle.canTake && onConsumeDose ? (
                <button
                  type="button"
                  onClick={() => onConsumeDose(medication.id, doseToggle.doseId)}
                  disabled={currentPills <= 0 || takeAmount <= 0}
                  title={`تناول جرعة (-${takeAmount})`}
                  aria-label={`تناول جرعة (-${takeAmount})`}
                  className={`w-6 h-6 flex items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/80 focus-visible:ring-offset-1 active:scale-95 cursor-pointer ${
                    currentPills <= 0 || takeAmount <= 0
                      ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                      : 'bg-emerald-600 text-white hover:bg-emerald-700'
                  }`}
                >
                  <Pill className="w-3.5 h-3.5 rotate-45" aria-hidden />
                </button>
              ) : !isAutoActive ? (
                <span
                  title="تم تناول جرعة اليوم"
                  className="w-6 h-6 flex items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
                >
                  <CheckCircle className="w-3.5 h-3.5" />
                </span>
              ) : null
            ) : null}

            <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onOpenRefill(medication)}
              title="تعبئة رصيد"
              className="w-6 h-6 flex items-center justify-center rounded-full bg-teal-100 text-teal-800 hover:bg-teal-200 transition-colors active:scale-95 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>

            <MedicationMenu
              medication={medication}
              isAutoActive={isAutoActive}
              onOpenRefill={onOpenRefill}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleAutoDeduct={onToggleAutoDeduct}
              onToggleMedicationReminder={onToggleMedicationReminder}
              onToggleMedicationCriticalStockAlerts={onToggleMedicationCriticalStockAlerts}
              onOpenHistory={onOpenHistory}
              size="sm"
            />
            </div>
        </div>

        {/* Second line: Crucial details — surface container */}
        <div className="mt-2 p-1.5 px-2 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between gap-2 text-[11px] flex-wrap">
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[10px] text-slate-500 font-medium">المتبقي:</span>
            <span
              className={`font-extrabold font-mono text-xs ${
                currentPills === 0
                  ? 'text-red-600'
                  : currentPills <= medication.dailyDose * 2
                  ? 'text-rose-600'
                  : 'text-slate-800'
              }`}
            >
              {currentPills}
            </span>
            <span className="text-[10px] text-slate-600 font-medium">
              {medication.unit || 'قرص'}
            </span>
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
              <span className="font-mono font-bold text-teal-800">{medication.dailyDose}</span>
              <span className="text-slate-400">/يوم</span>
            </div>

            <div className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded-full border border-slate-200/80 font-medium min-w-0">
              <Calendar className="w-2.5 h-2.5 text-slate-400 shrink-0" />
              <span className="text-slate-400 shrink-0">النفاذ:</span>
              <span className="font-bold text-slate-800 truncate max-w-[90px]">{shortDepletionLabel(depletion, isOut)}</span>
            </div>
          </div>
        </div>

        {/* Mini Visual Stock Progress Bar */}
        <div
          className="mt-2 w-full h-1 bg-slate-200/70 rounded-full overflow-hidden"
          title={
            isTemporaryCourse
              ? `كورس علاجي (${medication.durationDays} يوم): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
              : `دواء مزمن (مقياس شهري): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
          }
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${getProgressColor()}`}
            style={{ width: `${percentLeft}%` }}
          />
        </div>
      </div>
    );
  }


};
