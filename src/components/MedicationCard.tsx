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
import { getDepletionDate, getTodayDateString, effectiveCurrentPills, isDoseConsumedOnDate } from '../utils/dateCalculations';
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
  onConsumeDose?: (medicationId: string, doseId?: string) => void;
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
  const effPills = effectiveCurrentPills(medication);
  const stripsDesc = isSolid
    ? describeStockInStrips(
        effPills,
        medication.pillsPerStrip,
        medication.stripsPerBox,
        medication.unit
      )
    : null;

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
    <button
      type="button"
      onClick={onUndoRefill}
      className="medication-undo-action"
      title={`التراجع عن آخر تعبئة (+${lastRefillQuantity} ${medication.unit})`}
      aria-label={`التراجع عن آخر تعبئة (+${lastRefillQuantity} ${medication.unit})`}
    >
      تراجع +{lastRefillQuantity}
    </button>
  ) : null;

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
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-xs ${
                isOut ? 'bg-red-600 text-white' : isCrit ? 'bg-rose-600 text-white' : 'bg-amber-500 text-white'
              }`}
            >
              {isOut ? <AlertCircle className="w-5 h-5 animate-pulse" /> : <Clock className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3 className="text-base font-bold text-slate-900 leading-snug">{medication.name}</h3>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  isOut ? 'bg-red-600 text-white' : isCrit ? 'bg-rose-600 text-white' : 'bg-amber-600 text-white'
                }`}>
                  {isOut ? 'نفد المخزون بالكامل' : isCrit ? `حرج: ينفد خلال ${pluralizeArabic(statusInfo.daysLeft, 'يوم')}` : `تنبيه: متبقي ${statusInfo.daysLeft} أيام`}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 flex-wrap">
                {medication.category && <span className="font-medium bg-white/80 border border-slate-200 px-1.5 py-0.2 rounded text-[10px] text-slate-600">{medication.category}</span>}
                <span>معدل الخصم: {medication.dailyDose} {medication.unit}/يوم</span>
                {hasStrips && <StripsBadge medication={medication} className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded" />}
                {!isSolid && medication.packageSize && medication.packageSize > 0 && <PackageSizeBadge medication={medication} className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded" />}
              </div>
            </div>
          </div>
          <MedicationMenu medication={medication} isAutoActive={isAutoActive} showRefillInMenu={false} onOpenRefill={onOpenRefill} onEdit={onEdit} onDelete={onDelete} onToggleAutoDeduct={onToggleAutoDeduct} />
        </div>

        <div className="mt-3 p-3 bg-white rounded-xl border border-slate-200/90 flex items-center justify-between gap-3 text-xs">
          <div>
            <span className="text-[11px] text-slate-500 block">المتبقي حالياً:</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className={`text-2xl font-extrabold font-mono ${isOut ? 'text-red-600' : 'text-rose-600'}`}>{effPills}</span>
              <span className="text-xs text-slate-600 font-medium">{medication.unit}</span>
            </div>
            {stripsDesc && <span className="text-[11px] text-slate-500 font-medium block mt-0.5">({stripsDesc})</span>}
          </div>
          <div className="text-left">
            <span className="text-[11px] text-slate-500 block">تاريخ النفاذ التقديري:</span>
            <span className="font-bold text-slate-900 block mt-0.5 text-xs">{depletion.formattedArabic}</span>
            <span className="text-[10px] text-slate-500 font-mono">
              {isOut ? '(المخزون نفد بالكامل)' : statusInfo.daysLeft === 1 ? '(يوم واحد متبقي)' : statusInfo.daysLeft === 2 ? '(يومان متبقيان)' : statusInfo.daysLeft <= 10 ? `(${statusInfo.daysLeft} أيام متبقية)` : `(${statusInfo.daysLeft} يوماً متبقياً)`}
            </span>
          </div>
        </div>

        <ReminderBadge medication={medication} containerClass="bg-white/90 border-amber-200 mt-2" textClass="text-amber-950" badgeClass="text-amber-900 bg-amber-100" />
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => onOpenRefill(medication)} className="flex-1 py-2 px-3 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-xs"><Plus className="w-4 h-4" /><span>تعبئة رصيد (+ {medication.unit === 'مل' ? 'عبوة' : 'علبة'})</span></button>
          {onNavigateToShopping && <button onClick={onNavigateToShopping} className="py-2 px-3 rounded-xl bg-white hover:bg-slate-50 text-teal-800 border border-teal-300 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-2xs shrink-0" title="تجهيز طلب الشراء في الواتساب"><ShoppingCart className="w-3.5 h-3.5 text-teal-700" /><span>طلب واتساب</span></button>}
        </div>
        {!isAutoActive && <AutoDeductPausedNote />}
        {undoRefillAction}
      </div>
    );
  }

  if (viewFilter === 'sufficient') {
    const safeDays = statusInfo.daysLeft;
    const monthlyUsage = medication.dailyDose * DAYS_PER_MONTH;
    return (
      <div id={`med-card-${medication.id}`} className="bg-white rounded-2xl border border-emerald-200/80 p-4 shadow-xs hover:shadow-md transition relative overflow-hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center justify-center shrink-0 shadow-inner"><ShieldCheck className="w-6 h-6 text-emerald-600" /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap"><h3 className="text-base font-bold text-slate-900 leading-snug">{medication.name}</h3><span className="text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-600" /><span>مخزون آمن ومريح</span></span></div>
              <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 flex-wrap">
                {medication.category && <span className="font-medium bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded text-[10px]">{medication.category}</span>}
                {hasStrips && <StripsBadge medication={medication} className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50" />}
                {!isSolid && medication.packageSize && medication.packageSize > 0 && <PackageSizeBadge medication={medication} className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/50" />}
                {medication.notes && <span className="text-[11px] text-slate-400 truncate max-w-[180px]">{medication.notes}</span>}
              </div>
            </div>
          </div>
          <MedicationMenu medication={medication} isAutoActive={isAutoActive} showRefillInMenu={false} onOpenRefill={onOpenRefill} onEdit={onEdit} onDelete={onDelete} onToggleAutoDeduct={onToggleAutoDeduct} />
        </div>
        <div className="mt-3 p-2.5 bg-emerald-50/40 rounded-xl border border-emerald-100/80 grid grid-cols-3 gap-2 text-xs">
          <div><span className="text-[10px] text-slate-500 block">المخزون المتوفر</span><div className="flex items-baseline gap-1 mt-0.5"><span className="text-xl font-extrabold font-mono text-emerald-900">{effPills}</span><span className="text-[11px] text-slate-600">{medication.unit}</span></div>{stripsDesc && <span className="text-[10px] text-emerald-800 font-medium block truncate mt-0.5">({stripsDesc})</span>}</div>
          <div><span className="text-[10px] text-slate-500 block">الاستهلاك اليومي</span><div className="flex items-baseline gap-1 mt-0.5"><span className="text-xl font-extrabold font-mono text-teal-800">{medication.dailyDose}</span><span className="text-[11px] text-slate-600">/ يوم</span></div></div>
          <div><span className="text-[10px] text-slate-500 block">الاستهلاك الشهري</span><div className="flex items-baseline gap-1 mt-0.5"><span className="text-xl font-extrabold font-mono text-slate-700">{monthlyUsage}</span><span className="text-[11px] text-slate-600">/ شهر</span></div></div>
        </div>
        <div className="mt-2.5 p-2 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between text-xs"><div className="flex items-center gap-1.5 text-slate-600"><Calendar className="w-3.5 h-3.5 text-emerald-600 shrink-0" /><span className="text-[11px]">مخزونك يكفي حتى:</span></div><span className="font-bold text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-md">{depletion.formattedArabic} ({safeDays} يوم أمان)</span></div>
        <ReminderBadge medication={medication} containerClass="bg-emerald-50/70 border-emerald-200/80 mt-2" textClass="text-emerald-950" badgeClass="text-emerald-900 bg-emerald-100" />
        {!isAutoActive && <AutoDeductPausedNote />}
        {undoRefillAction}
      </div>
    );
  }

  const tag = colorTagClasses(medication.colorTag);

  if (isCompact && viewFilter === 'all') {
    const isOut = statusInfo.status === 'out_of_stock';
    const isCrit = statusInfo.status === 'critical';
    const isWarn = statusInfo.status === 'warning';
    const todayStr = getTodayDateString();
    const isConsumedToday = Array.isArray(medication.doseSchedule) && medication.doseSchedule.length > 0
      ? medication.doseSchedule.every((d) => isDoseConsumedOnDate(medication, d.id, todayStr))
      : medication.lastConsumedDate === todayStr;
    const statusLabel = isOut ? 'نفد' : isCrit ? `حرج ${statusInfo.daysLeft}ي` : isWarn ? `تنبيه ${statusInfo.daysLeft}ي` : `آمن ${statusInfo.daysLeft}ي`;
    const statusClass = isOut ? 'bg-red-100 text-red-700' : isCrit ? 'bg-rose-100 text-rose-700' : isWarn ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800';

    return (
      <div id={`med-card-${medication.id}`} className={`medication-card-compact bg-white rounded-lg border border-slate-200/90 p-1.5 shadow-2xs transition relative overflow-hidden border-r-2 ${tag.border} ${isOut ? 'bg-red-50/25' : isCrit ? 'bg-rose-50/20' : isWarn ? 'bg-amber-50/10' : ''}`}>
        <div className="medication-card-compact-header flex items-center gap-1 min-w-0">
          <h3 className="flex-1 min-w-0 text-[10px] font-bold text-slate-900 leading-tight truncate" title={medication.name}>{medication.name}</h3>
          <span className={`shrink-0 text-[8px] font-bold px-1 py-px rounded ${statusClass}`}>{statusLabel}</span>
          <div className="medication-card-compact-actions flex items-center shrink-0">
            {onConsumeDose && (isConsumedToday ? <span title="تم تناول جرعة اليوم" className="w-5 h-5 flex items-center justify-center text-emerald-600"><CheckCircle className="w-3 h-3" /></span> : <button type="button" onClick={() => onConsumeDose(medication.id)} disabled={effPills <= 0 || medication.dailyDose <= 0} title={`تناول جرعة (-${medication.dailyDose})`} className={`w-5 h-5 flex items-center justify-center rounded ${effPills <= 0 || medication.dailyDose <= 0 ? 'text-slate-300 cursor-not-allowed' : 'text-emerald-700 hover:bg-emerald-50'}`}><Pill className="w-3 h-3 rotate-45" /></button>)}
            <button type="button" onClick={() => onOpenRefill(medication)} title="تعبئة" className="w-5 h-5 flex items-center justify-center rounded text-teal-700 hover:bg-teal-50"><Plus className="w-3 h-3" /></button>
            <MedicationMenu medication={medication} isAutoActive={isAutoActive} showRefillInMenu={false} onOpenRefill={onOpenRefill} onEdit={onEdit} onDelete={onDelete} onToggleAutoDeduct={onToggleAutoDeduct} />
          </div>
        </div>
        <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-600 leading-none truncate">
          <span className={`font-mono font-bold ${effPills === 0 ? 'text-red-600' : 'text-slate-800'}`}>{effPills}</span>
          <span className="text-slate-400">{medication.unit || 'قرص'}</span><span className="text-slate-300">·</span><span className="font-mono text-teal-800">{medication.dailyDose}/ي</span><span className="text-slate-300">·</span><span className="truncate text-slate-500">{depletion.formattedArabic}</span>
        </div>
        <div className="mt-1 flex items-center gap-1"><div className="flex-1 h-0.5 bg-slate-100 rounded-full overflow-hidden min-w-0"><div className={`h-full ${getProgressColor()}`} style={{ width: `${percentLeft}%` }} /></div></div>
        {undoRefillAction}
      </div>
    );
  }

  if (viewFilter === 'all') {
    const isOut = statusInfo.status === 'out_of_stock';
    const isCrit = statusInfo.status === 'critical';
    const isWarn = statusInfo.status === 'warning';
    const todayStr = getTodayDateString();
    const isConsumedToday = Array.isArray(medication.doseSchedule) && medication.doseSchedule.length > 0
      ? medication.doseSchedule.every((d) => isDoseConsumedOnDate(medication, d.id, todayStr))
      : medication.lastConsumedDate === todayStr;

    return (
      <div id={`med-card-${medication.id}`} className={`medication-card-detailed bg-white rounded-xl border border-slate-200/90 p-2.5 shadow-2xs hover:shadow-xs transition relative overflow-hidden border-r-4 ${tag.border} ${isOut ? 'bg-red-50/20' : isCrit ? 'bg-rose-50/20' : isWarn ? 'bg-amber-50/15' : ''}`}>
        <div className="medication-card-detailed-header flex items-center gap-2 min-w-0">
          <div className="medication-card-detailed-title flex items-center gap-2 min-w-0 flex-1">
            <h3 className="text-xs font-bold text-slate-900 leading-tight truncate" title={medication.name}>{medication.name}</h3>
            {medication.category && <span className="text-[9px] font-medium bg-slate-100 text-slate-600 px-1 py-0.5 rounded shrink-0">{medication.category}</span>}
            {isOut ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 flex items-center gap-0.5 shrink-0"><AlertCircle className="w-2.5 h-2.5" /><span>نفد</span></span> : isCrit ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 flex items-center gap-0.5 shrink-0"><Clock className="w-2.5 h-2.5" /><span>حرج ({statusInfo.daysLeft}ي)</span></span> : isWarn ? <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 flex items-center gap-0.5 shrink-0"><Clock className="w-2.5 h-2.5" /><span>تنبيه ({statusInfo.daysLeft}ي)</span></span> : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-0.5 shrink-0"><CheckCircle2 className="w-2.5 h-2.5" /><span>آمن ({statusInfo.daysLeft}ي)</span></span>}
          </div>
          <div className="medication-card-detailed-actions flex items-center gap-1 shrink-0">
            {onConsumeDose && (isConsumedToday ? <span title="تم تناول جرعة اليوم" className="w-6 h-6 flex items-center justify-center rounded-md bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle className="w-3 h-3" /></span> : <button type="button" onClick={() => onConsumeDose(medication.id)} disabled={effPills <= 0 || medication.dailyDose <= 0} title={`تناول جرعة اليوم (-${medication.dailyDose} ${medication.unit})`} className={`w-6 h-6 flex items-center justify-center rounded-md border transition active:scale-95 ${effPills <= 0 || medication.dailyDose <= 0 ? 'bg-slate-100 text-slate-300 border-slate-200 cursor-not-allowed' : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200'}`}><Pill className="w-3 h-3 rotate-45" /></button>)}
            <button type="button" onClick={() => onOpenRefill(medication)} title="تعبئة رصيد" className="w-6 h-6 flex items-center justify-center rounded-md bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 transition active:scale-95"><Plus className="w-3.5 h-3.5" /></button>
            <MedicationMenu medication={medication} isAutoActive={isAutoActive} showRefillInMenu={false} onOpenRefill={onOpenRefill} onEdit={onEdit} onDelete={onDelete} onToggleAutoDeduct={onToggleAutoDeduct} />
          </div>
        </div>
        <div className="mt-1.5 pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2 text-[11px] flex-wrap">
          <div className="flex items-center gap-1 min-w-0"><span className="text-[10px] text-slate-500 font-medium">المتبقي:</span><span className={`font-extrabold font-mono text-xs ${effPills === 0 ? 'text-red-600' : effPills <= medication.dailyDose * 2 ? 'text-rose-600' : 'text-slate-800'}`}>{effPills}</span><span className="text-[10px] text-slate-600 font-medium">{medication.unit || 'قرص'}</span>{stripsDesc && <span className="text-[9px] text-slate-400 font-medium truncate">({stripsDesc})</span>}</div>
          <div className="flex items-center gap-1.5 text-[10px] text-slate-600"><div className="flex items-center gap-0.5"><span className="text-slate-400">الجرعة:</span><span className="font-mono font-bold text-teal-800">{medication.dailyDose}</span><span className="text-slate-400">/يوم</span></div><span className="text-slate-300">•</span><div className="flex items-center gap-0.5"><Calendar className="w-2.5 h-2.5 text-slate-400" /><span className="text-slate-400">النفاذ:</span><span className="font-bold text-slate-800">{depletion.formattedArabic}</span></div></div>
        </div>
        <div className="mt-1.5 w-full h-0.5 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full transition-all duration-500 ${getProgressColor()}`} style={{ width: `${percentLeft}%` }} /></div>
        {undoRefillAction}
      </div>
    );
  }

  return null;
};
