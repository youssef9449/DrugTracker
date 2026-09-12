import type { FC } from 'react';
import {
  Pill,
  Plus,
  Calendar,
  Zap,
  AlertCircle,
  CheckCircle2,
  CheckCircle,
  ShoppingCart,
  Clock,
  ShieldCheck,
} from 'lucide-react';
import { Medication, calculateMedicationStatus, describeStockInStrips, isSolidUnit } from '../types';
import { getDepletionDate, getTodayDateString, effectiveCurrentPills } from '../utils/dateCalculations';
import { pluralizeArabic } from '../lib/arabicPlural';
import { VISUAL_RANGE_MULTIPLIER, MIN_VISUAL_RANGE_DAYS, DAYS_PER_MONTH } from '../utils/time';
import { MedicationMenu } from './MedicationMenu';
import { ReminderBadge } from './ReminderBadge';
import { StripsBadge, PackageSizeBadge, AutoDeductPausedNote } from './medicationCardParts';

/**
 * Map a medication's `colorTag` (the user-selected card color from the
 * AddMedicationModal color picker) to Tailwind classes used for the card's
 * icon box + left border accent. The status-based color (red/rose/amber
 * for out-of-stock/critical/warning) still takes priority for the icon
 * box in the alerts view, but the left border always shows the user's
 * chosen color so the selection has a visible effect.
 *
 * Returns a { bg, border } pair of class strings. Unknown tags default
 * to teal (the app's primary theme).
 */
function colorTagClasses(colorTag: string | undefined): { bg: string; border: string } {
  switch (colorTag) {
    case 'rose':
      return { bg: 'bg-rose-50 text-rose-700', border: 'border-r-rose-400' };
    case 'amber':
      return { bg: 'bg-amber-50 text-amber-700', border: 'border-r-amber-400' };
    case 'sky':
      return { bg: 'bg-sky-50 text-sky-700', border: 'border-r-sky-400' };
    case 'violet':
      return { bg: 'bg-violet-50 text-violet-700', border: 'border-r-violet-400' };
    case 'teal':
    default:
      return { bg: 'bg-teal-50 text-teal-700', border: 'border-r-teal-400' };
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
  onNavigateToShopping?: () => void;
  onTriggerAlarm?: (medication: Medication) => void;
  onConsumeDose?: (medicationId: string) => void;
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
  onNavigateToShopping,
  onConsumeDose,
  lastRefillQuantity,
  onUndoRefill,
}) => {
  const statusInfo = calculateMedicationStatus(medication);
  const depletion = getDepletionDate(medication);
  const isSolid = isSolidUnit(medication.unit);
  const hasStrips = isSolid && Boolean(medication.stripsPerBox && medication.pillsPerStrip);
  // Use the DYNAMIC balance (projected from currentPills + lastSyncDate)
  // — never the raw snapshot. This keeps the displayed count correct
  // even if the app was closed for many days and the snapshot hasn't
  // been re-settled yet.
  const effPills = effectiveCurrentPills(medication);
  const stripsDesc = isSolid
    ? describeStockInStrips(
        effPills,
        medication.pillsPerStrip,
        medication.stripsPerBox,
        medication.unit
      )
    : null;

  // Maximum visual scale for the stock progress bar.
  // Prefer one full package worth of days so a just-refilled box reads
  // near 100% and partial stock (e.g. 22 days left on a 30-day pack)
  // maps to a proportional fill instead of always clamping to full.
  const packageDays =
    medication.packageSize && medication.packageSize > 0 && medication.dailyDose > 0
      ? medication.packageSize / medication.dailyDose
      : DAYS_PER_MONTH;
  const maxVisualRange = Math.max(
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

  const isAutoActive = medication.autoDeductEnabled !== false;
  const undoRefillAction = lastRefillQuantity && onUndoRefill ? (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
      <span>آخر تعبئة: +{lastRefillQuantity} {medication.unit}</span>
      <button type="button" onClick={onUndoRefill} className="shrink-0 rounded-lg border border-rose-200 bg-white px-2.5 py-1 font-bold text-rose-700 hover:bg-rose-50">
        تراجع عن التعبئة
      </button>
    </div>
  ) : null;

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
        {/* Header: Name + Urgency Badge + Menu */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-xs ${
                isOut
                  ? 'bg-red-600 text-white'
                  : isCrit
                  ? 'bg-rose-600 text-white'
                  : 'bg-amber-500 text-white'
              }`}
            >
              {isOut ? (
                <AlertCircle className="w-5 h-5 animate-pulse" />
              ) : (
                <Clock className="w-5 h-5" />
              )}
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-base font-bold text-slate-900 leading-snug">
                  {medication.name}
                </h3>
                <span
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
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
              </div>

              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 flex-wrap">
                {medication.category && (
                  <span className="font-medium bg-white/80 border border-slate-200 px-1.5 py-0.2 rounded text-[10px] text-slate-600">
                    {medication.category}
                  </span>
                )}
                <span>معدل الخصم: {medication.dailyDose} {medication.unit}/يوم</span>
                {hasStrips && (
                  <StripsBadge medication={medication} className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded" />
                )}
                {!isSolid && medication.packageSize && medication.packageSize > 0 && (
                  <PackageSizeBadge medication={medication} className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded" />
                )}
              </div>
            </div>
          </div>

          {/* Quick Menu (extracted — see MedicationMenu.tsx) */}
          <MedicationMenu
            medication={medication}
            isAutoActive={isAutoActive}
            showRefillInMenu={false}
            onOpenRefill={onOpenRefill}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleAutoDeduct={onToggleAutoDeduct}
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
                {effPills}
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
            className="flex-1 py-2 px-3 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-xs"
          >
            <Plus className="w-4 h-4" />
            <span>تعبئة رصيد (+ {medication.unit === 'مل' ? 'عبوة' : 'علبة'})</span>
          </button>

          {onNavigateToShopping && (
            <button
              onClick={onNavigateToShopping}
              className="py-2 px-3 rounded-xl bg-white hover:bg-slate-50 text-teal-800 border border-teal-300 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-2xs shrink-0"
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
        {undoRefillAction}
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
        {/* Header: Name + Safety Indicator */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center justify-center shrink-0 shadow-inner">
              <ShieldCheck className="w-6 h-6 text-emerald-600" />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-base font-bold text-slate-900 leading-snug">
                  {medication.name}
                </h3>
                <span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                  <span>مخزون آمن ومريح</span>
                </span>
              </div>

              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 flex-wrap">
                {medication.category && (
                  <span className="font-medium bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded text-[10px]">
                    {medication.category}
                  </span>
                )}
                {hasStrips && (
                  <StripsBadge medication={medication} className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50" />
                )}
                {!isSolid && medication.packageSize && medication.packageSize > 0 && (
                  <PackageSizeBadge medication={medication} className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50" />
                )}
                {medication.notes && (
                  <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                    {medication.notes}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Options Menu (extracted — see MedicationMenu.tsx) */}
          <MedicationMenu
            medication={medication}
            isAutoActive={isAutoActive}
            showRefillInMenu={false}
            onOpenRefill={onOpenRefill}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleAutoDeduct={onToggleAutoDeduct}
          />
        </div>

        {/* Coverage & Stability metrics */}
        <div className="mt-3 p-2.5 bg-emerald-50/40 rounded-xl border border-emerald-100/80 grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-[10px] text-slate-500 block">المخزون المتوفر</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-extrabold font-mono text-emerald-900">
                {effPills}
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
        {undoRefillAction}
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW 3: "جميع الأدوية" (ALL) - Comprehensive Inventory Management
  // -------------------------------------------------------------
  // The user-selected colorTag drives the icon box background (when
  // status is normal) and the card's right accent border (always, so
  // the color choice is visible even when the status color overrides
  // the icon box).
  const tag = colorTagClasses(medication.colorTag);

  // -------------------------------------------------------------
  // COMPACT VIEW: "جميع الأدوية" (ALL - COMPACT MODE)
  // Dense layout: reduces height by ~70% while keeping all critical
  // details (Name, Stock, Unit, Strips, Daily Dose, Depletion date,
  // status badge, visual progress bar, refill, consume, and menu).
  // -------------------------------------------------------------
  if (isCompact && viewFilter === 'all') {
    const isOut = statusInfo.status === 'out_of_stock';
    const isCrit = statusInfo.status === 'critical';
    const isWarn = statusInfo.status === 'warning';
    const isConsumedToday = medication.lastConsumedDate === getTodayDateString();

    return (
      <div
        id={`med-card-${medication.id}`}
        className={`bg-white rounded-2xl border border-slate-200/90 p-3 shadow-2xs hover:shadow-xs transition relative overflow-hidden border-r-4 ${tag.border} ${
          isOut
            ? 'bg-red-50/20'
            : isCrit
            ? 'bg-rose-50/20'
            : isWarn
            ? 'bg-amber-50/15'
            : ''
        }`}
      >
        {/* Top line: Name + Category + Status Badge + Actions */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h3 className="text-sm font-bold text-slate-900 leading-tight truncate max-w-[150px] sm:max-w-xs">
              {medication.name}
            </h3>
            {medication.category && (
              <span className="text-[10px] font-medium bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded-md">
                {medication.category}
              </span>
            )}
            {isOut ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700 flex items-center gap-1 shrink-0">
                <AlertCircle className="w-3 h-3" />
                <span>نفد المخزون</span>
              </span>
            ) : isCrit ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 flex items-center gap-1 shrink-0">
                <Clock className="w-3 h-3" />
                <span>حرج ({statusInfo.daysLeft} {statusInfo.daysLeft === 1 ? 'يوم' : statusInfo.daysLeft === 2 ? 'يومان' : 'أيام'})</span>
              </span>
            ) : isWarn ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 flex items-center gap-1 shrink-0">
                <Clock className="w-3 h-3" />
                <span>تنبيه ({statusInfo.daysLeft} أيام)</span>
              </span>
            ) : (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1 shrink-0">
                <CheckCircle2 className="w-3 h-3" />
                <span>آمن ({statusInfo.daysLeft} يوم)</span>
              </span>
            )}
          </div>

          {/* Quick Actions at top left */}
          <div className="flex items-center gap-1 shrink-0">
            {onConsumeDose && (
              isConsumedToday ? (
                <span
                  title="تم تناول جرعة اليوم"
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 text-xs"
                >
                  <CheckCircle className="w-3.5 h-3.5" />
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onConsumeDose(medication.id)}
                  disabled={effPills <= 0 || medication.dailyDose <= 0}
                  title={`تناول جرعة اليوم (-${medication.dailyDose} ${medication.unit})`}
                  className={`w-7 h-7 flex items-center justify-center rounded-lg border text-xs transition active:scale-95 ${
                    effPills <= 0 || medication.dailyDose <= 0
                      ? 'bg-slate-100 text-slate-300 border-slate-200 cursor-not-allowed'
                      : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'
                  }`}
                >
                  <Pill className="w-3.5 h-3.5 rotate-45" />
                </button>
              )
            )}

            <button
              type="button"
              onClick={() => onOpenRefill(medication)}
              title="تعبئة رصيد"
              className="w-7 h-7 flex items-center justify-center rounded-lg bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 transition active:scale-95"
            >
              <Plus className="w-4 h-4" />
            </button>

            <MedicationMenu
              medication={medication}
              isAutoActive={isAutoActive}
              showRefillInMenu={false}
              onOpenRefill={onOpenRefill}
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleAutoDeduct={onToggleAutoDeduct}
            />
          </div>
        </div>

        {/* Second line: Crucial details (Remaining stock, daily dose, depletion date) */}
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between gap-2 text-xs flex-wrap">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] text-slate-500 font-medium">المتبقي:</span>
            <span
              className={`font-extrabold font-mono text-sm ${
                effPills === 0
                  ? 'text-red-600'
                  : effPills <= medication.dailyDose * 2
                  ? 'text-rose-600'
                  : 'text-slate-800'
              }`}
            >
              {effPills}
            </span>
            <span className="text-[11px] text-slate-600 font-medium">
              {medication.unit || 'قرص'}
            </span>
            {stripsDesc && (
              <span className="text-[10px] text-slate-400 font-medium truncate">
                ({stripsDesc})
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-600">
            <div className="flex items-center gap-1">
              <span className="text-slate-400">الجرعة:</span>
              <span className="font-mono font-bold text-teal-800">{medication.dailyDose}</span>
              <span className="text-slate-400 text-[10px]">/يوم</span>
            </div>

            <span className="text-slate-300">•</span>

            <div className="flex items-center gap-1">
              <Calendar className="w-3 h-3 text-slate-400" />
              <span className="text-slate-400">النفاذ:</span>
              <span className="font-bold text-slate-800">{depletion.formattedArabic}</span>
            </div>
          </div>
        </div>

        {/* Mini Visual Stock Progress Bar */}
        <div className="mt-2 w-full h-1 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${getProgressColor()}`}
            style={{ width: `${percentLeft}%` }}
          />
        </div>

        <div
          className={`mt-1.5 text-[10px] px-2 py-0.5 rounded-md flex items-center gap-1 border ${
            isAutoActive
              ? 'text-teal-700 bg-teal-50 border-teal-200/70'
              : 'text-amber-700 bg-amber-50 border-amber-200/70'
          }`}
        >
          {isAutoActive ? (
            <>
              <Zap className="w-3 h-3 shrink-0" />
              <span>الخصم التلقائي مفعّل</span>
            </>
          ) : (
            <span>الخصم التلقائي متوقف لهذا الدواء</span>
          )}
        </div>
        {undoRefillAction}
      </div>
    );
  }

  return (
    <div
      id={`med-card-${medication.id}`}
      className={`bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs hover:shadow-md transition relative overflow-hidden border-r-4 ${tag.border}`}
    >
      {/* Top row: Name, Category, Menu */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-inner ${
              statusInfo.status === 'out_of_stock'
                ? 'bg-red-100 text-red-600'
                : statusInfo.status === 'critical'
                ? 'bg-rose-100 text-rose-600'
                : statusInfo.status === 'warning'
                ? 'bg-amber-100 text-amber-600'
                : tag.bg
            }`}
          >
            <Pill className="w-5 h-5 rotate-45" />
          </div>

          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900 leading-snug truncate">
              {medication.name}
            </h3>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap text-xs">
              {medication.category && (
                <span className="text-[11px] font-medium bg-slate-100 text-slate-600 px-2 py-0.5 rounded-md">
                  {medication.category}
                </span>
              )}
              {hasStrips && (
                <StripsBadge medication={medication} className="text-[11px] text-teal-800 bg-teal-50 border border-teal-200/60 px-2 py-0.5 rounded-md gap-1" />
              )}
              {!isSolid && medication.packageSize && medication.packageSize > 0 && (
                <PackageSizeBadge medication={medication} className="text-[11px] text-teal-800 bg-teal-50 border border-teal-200/60 px-2 py-0.5 rounded-md gap-1" />
              )}
              {medication.notes && (
                <span className="text-[11px] text-slate-500 truncate max-w-[170px]">
                  {medication.notes}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Options Menu (extracted — see MedicationMenu.tsx) */}
        <MedicationMenu
          medication={medication}
          isAutoActive={isAutoActive}
          showRefillInMenu={false}
          onOpenRefill={onOpenRefill}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleAutoDeduct={onToggleAutoDeduct}
        />
      </div>

      {/* Pill count & Auto deduction rate display */}
      <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 bg-slate-50/80 p-2.5 rounded-xl">
        <div>
          <span className="text-[11px] text-slate-500 block">المخزون الحالي</span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span
              className={`text-2xl font-extrabold font-mono ${
                effPills === 0
                  ? 'text-red-600'
                  : effPills <= medication.dailyDose * 2
                  ? 'text-rose-600'
                  : 'text-slate-800'
              }`}
            >
              {effPills}
            </span>
            <span className="text-xs text-slate-600 font-medium">
              {medication.unit || 'قرص'}
            </span>
          </div>
          {stripsDesc && (
            <span className="text-[11px] text-slate-500 font-medium block mt-0.5">
              ({stripsDesc})
            </span>
          )}
        </div>

        <div>
          <span className="text-[11px] text-slate-500 block flex items-center gap-1">
            <Zap className="w-3 h-3 text-teal-600" />
            <span>الخصم اليومي</span>
          </span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="text-2xl font-extrabold font-mono text-teal-800">
              {medication.dailyDose}
            </span>
            <span className="text-xs text-slate-600 font-medium">
              {medication.unit} / يوم
            </span>
          </div>
        </div>
      </div>

      {/* Depletion calculation card */}
      <div className="mt-2.5 p-2 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-slate-600">
          <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span className="text-[11px]">موعد النفاذ المتوقع:</span>
        </div>
        <span
          className={`font-bold text-[11px] px-2 py-0.5 rounded-md border ${
            statusInfo.status === 'out_of_stock'
              ? 'bg-red-50 text-red-700 border-red-200'
              : statusInfo.status === 'critical'
              ? 'bg-rose-50 text-rose-700 border-rose-200 font-bold'
              : statusInfo.status === 'warning'
              ? 'bg-amber-50 text-amber-700 border-amber-200'
              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
          }`}
        >
          {depletion.formattedArabic} ({statusInfo.daysLeft} {statusInfo.daysLeft === 1 ? 'يوم' : statusInfo.daysLeft === 2 ? 'يومين' : 'أيام'})
        </span>
      </div>

      {/* Visual Stock Progress Bar */}
      <div className="mt-2.5">
        <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${getProgressColor()}`}
            style={{ width: `${percentLeft}%` }}
          />
        </div>
      </div>

      {/* Status note if paused */}
      {!isAutoActive && <AutoDeductPausedNote />}
      {undoRefillAction}

      {/* Scheduled Reminder Badge (extracted — see ReminderBadge.tsx) */}
      <ReminderBadge
        medication={medication}
        containerClass="bg-teal-50/70 border-teal-200/80 mt-2.5"
        textClass="text-teal-950"
        badgeClass="text-teal-900 bg-teal-100"
      />

      {/* Consume-pill feature: "تناول جرعة" button + consumed-today badge.
          When the user clicks it, the dailyDose is subtracted from
          currentPills and the auto-deduction for today is blocked. */}
      {onConsumeDose && (
        <div className="mt-2.5">
          {medication.lastConsumedDate === getTodayDateString() ? (
            <div className="w-full py-2 px-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-center justify-center gap-1.5">
              <CheckCircle className="w-4 h-4" />
              <span>تم تناول جرعة اليوم — لن يتم الخصم التلقائي</span>
            </div>
          ) : (
            <button
              onClick={() => onConsumeDose(medication.id)}
              disabled={effPills <= 0 || medication.dailyDose <= 0}
              className={`w-full py-2 px-3 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 ${
                effPills <= 0 || medication.dailyDose <= 0
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200'
              }`}
            >
              <Pill className="w-4 h-4 text-emerald-600" />
              <span>تناول جرعة (-{medication.dailyDose} {medication.unit})</span>
            </button>
          )}
        </div>
      )}

      {/* Action: Refill button upon purchasing new medicine */}
      <div className="mt-3 pt-2 flex items-center gap-2">
        <button
          onClick={() => onOpenRefill(medication)}
          className="w-full py-2 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-2xs"
        >
          <Plus className="w-4 h-4 text-teal-600" />
          <span>تعبئة رصيد</span>
        </button>
      </div>
    </div>
  );
};

