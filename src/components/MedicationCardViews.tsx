import type { FC } from 'react';
import type { Medication, ConsumptionLog } from '../types';
import { calculateMedicationStatus } from '../utils/medicationStatus';
import { pluralizeArabic } from '../lib/arabicPlural';
import { DAYS_PER_MONTH } from '../utils/time';
import { formatDepletionDate } from '../utils/medicationPresentation';
import { Plus, Calendar, CheckCircle2, ShoppingCart } from 'lucide-react';
import { MedicationMenu, MedicationOverflowMenu } from './MedicationMenu';
import { ReminderBadge } from './ReminderBadge';
import {
  StripsBadge,
  PackageSizeBadge,
  AutoDeductPausedNote,
  MedicationCardHeader,
  MedicationCardStatusBadges,
  MedicationCardDoseActions,
  MedicationCardStockSummary,
  MedicationCardProgress,
} from './medicationCardParts';

type StatusInfo = ReturnType<typeof calculateMedicationStatus>;
type Depletion = ReturnType<typeof import('../utils/dateCalculations').getDepletionDate>;
type Tag = { bg: string; border: string; badge: string };

export interface MedicationCardViewProps {
  medication: Medication;
  isAutoActive: boolean;
  statusInfo: StatusInfo;
  depletion: Depletion;
  isSolid: boolean;
  hasStrips: boolean;
  currentPills: number;
  stripsDesc: string | null;
  nonSolidPackageDesc: string | null;
  tag: Tag;
  percentLeft: number;
  progressColor: string;
  onOpenRefill: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
  onToggleMedicationReminder?: (id: string) => void;
  onToggleMedicationCriticalStockAlerts?: (id: string) => void;
  onNavigateToShopping?: () => void;
  onConsumeDose?: (medicationId: string, doseId?: string) => void;
  onRestoreDose?: (medicationId: string, doseId?: string) => void;
  onOpenHistory?: (medication: Medication) => void;
  logs: ConsumptionLog[];
  onRegisterBackHandler?: (id: string, close: () => void, priority?: number) => () => void;
}

function shortDepletionLabel(depletion: { dateStr: string; daysLeft: number }, isOut: boolean): string {
  if (isOut) return 'نفد المخزون';
  if (depletion.daysLeft === 0) return 'اليوم';
  if (depletion.daysLeft === 1) return 'غداً';
  if (depletion.daysLeft === 2) return 'بعد غد';
  const target = new Date(`${depletion.dateStr}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return depletion.dateStr;
  return target.toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export const MedicationCardAlertsView: FC<MedicationCardViewProps> = (props) => {
  const {
    medication,
    isAutoActive,
    statusInfo,
    depletion,
    isSolid,
    hasStrips,
    currentPills,
    stripsDesc,
    tag,
    onOpenRefill,
    onEdit,
    onDelete,
    onToggleAutoDeduct,
    onNavigateToShopping,
    onOpenHistory,
    onRegisterBackHandler,
  } = props;
  const isOut = statusInfo.status === 'out_of_stock';
  const isCrit = statusInfo.status === 'critical';
  return (
    <div
      id={`med-card-${medication.id}`}
      className={
        `bg-white rounded-2xl border border-slate-200 p-2.5 shadow-sm `
        + `hover:shadow-md transition-shadow duration-200 relative overflow-hidden `
        + `border-r-[3px] ${tag.border} ${
          isOut ? 'bg-red-50/25' : isCrit ? 'bg-rose-50/20' : ''
        }`
      }
    >
      {/* Row 1: Name + Top-Left Overflow Menu */}
      <div className="flex items-center justify-between gap-2 mb-1.5 min-w-0">
        <h3 className="text-base font-bold text-slate-900 leading-snug tracking-tight truncate min-w-0 flex-1" title={medication.name}>
          {medication.name}
        </h3>
        <MedicationOverflowMenu
          medication={medication}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenHistory={onOpenHistory}
          onRegisterBackHandler={onRegisterBackHandler}
          size="sm"
        />
      </div>
      {/* Row 2: Badges (Status, Category, Strips) + Quick Menu */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 text-xs text-slate-500 flex-wrap min-w-0">
          <span
            className={
              `bg-white rounded-2xl border border-slate-200 p-2.5 shadow-sm `
              + `hover:shadow-md transition-shadow duration-200 relative overflow-hidden `
              + `border-r-[3px] ${tag.border} ${
                isOut ? 'bg-red-50/25' : isCrit ? 'bg-rose-50/20' : ''
              }`
            }
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
          ) : medication.isChronic === true ? (
            <span className="font-medium px-1.5 py-0.2 rounded text-[10px] shrink-0 bg-slate-100 text-slate-600 border border-slate-200">
              مزمن
            </span>
          ) : null}
          <span>معدل الخصم: {medication.dailyDose} {medication.unit}/يوم</span>
          {hasStrips && (
            <StripsBadge medication={medication} className={
              'text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 '
              + 'py-0.5 rounded shrink-0'
            } />
          )}
          {!isSolid && medication.packageSize && medication.packageSize > 0 && (
            <PackageSizeBadge medication={medication} className={
              'text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 '
              + 'py-0.5 rounded shrink-0'
            } />
          )}
        </div>
        {/* Quick Menu (extracted — see MedicationMenu.tsx) */}
        <MedicationMenu
          medication={medication}
          isAutoActive={isAutoActive}
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleAutoDeduct={onToggleAutoDeduct}
          onOpenHistory={onOpenHistory}
          onRegisterBackHandler={onRegisterBackHandler}
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
            {formatDepletionDate(depletion.dateStr, depletion.daysLeft, currentPills)}
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
      />
      {/* Quick Action: Immediate Refill + Shopping List CTA */}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onOpenRefill(medication)}
          className={
            'flex-1 h-9 px-4 rounded-full bg-teal-700 hover:bg-teal-800 text-white '
            + 'font-semibold text-xs flex items-center justify-center gap-1.5 '
            + 'transition active:scale-98 shadow-2xs cursor-pointer'
          }
        >
          <Plus className="w-4 h-4" />
          <span>تعبئة رصيد</span>
        </button>
        {onNavigateToShopping && (
          <button
            onClick={onNavigateToShopping}
            className={
              'h-9 px-4 rounded-full bg-white hover:bg-slate-50 text-teal-800 border '
              + 'border-teal-300 font-semibold text-xs flex items-center justify-center '
              + 'gap-1.5 transition active:scale-98 cursor-pointer shrink-0'
            }
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
};

export const MedicationCardSufficientView: FC<MedicationCardViewProps> = (props) => {
  const {
    medication,
    isAutoActive,
    statusInfo,
    depletion,
    isSolid,
    hasStrips,
    currentPills,
    stripsDesc,
    tag,
    onEdit,
    onDelete,
    onToggleAutoDeduct,
    onOpenHistory,
    onRegisterBackHandler,
  } = props;
  const safeDays = statusInfo.daysLeft;
  const monthlyUsage = medication.dailyDose * DAYS_PER_MONTH;
  return (
    <div
      id={`med-card-${medication.id}`}
      className="bg-white rounded-2xl border border-emerald-200/80 p-4 shadow-xs hover:shadow-md transition relative overflow-hidden"
    >
      {/* Row 1: Name + Top-Left Overflow Menu */}
      <div className="flex items-center justify-between gap-2 mb-1.5 min-w-0">
        <h3 className="text-base font-bold text-slate-900 leading-snug tracking-tight truncate min-w-0 flex-1" title={medication.name}>
          {medication.name}
        </h3>
        <MedicationOverflowMenu
          medication={medication}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenHistory={onOpenHistory}
          onRegisterBackHandler={onRegisterBackHandler}
          size="sm"
        />
      </div>
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
            <StripsBadge medication={medication} className={
              'text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border '
              + 'border-emerald-200/50 shrink-0'
            } />
          )}
          {!isSolid && medication.packageSize && medication.packageSize > 0 && (
            <PackageSizeBadge medication={medication} className={
              'text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border '
              + 'border-emerald-200/50 shrink-0'
            } />
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
          onEdit={onEdit}
          onDelete={onDelete}
          onToggleAutoDeduct={onToggleAutoDeduct}
          onOpenHistory={onOpenHistory}
          onRegisterBackHandler={onRegisterBackHandler}
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
          {formatDepletionDate(depletion.dateStr, depletion.daysLeft, currentPills)} ({safeDays} يوم أمان)
        </span>
      </div>
      {/* Scheduled Reminder Badge (extracted — see ReminderBadge.tsx) */}
      <ReminderBadge
        medication={medication}
        containerClass="bg-emerald-50/70 border-emerald-200/80 mt-2"
        textClass="text-emerald-950"
      />
      {/* Auto-deduct paused note */}
      {!isAutoActive && <AutoDeductPausedNote />}
    </div>
  );
};

export const MedicationCardCompactView: FC<MedicationCardViewProps> = (props) => {
  const {
    medication, isAutoActive, statusInfo, depletion, currentPills, tag, percentLeft,
    progressColor, onOpenRefill, onEdit, onDelete, onToggleAutoDeduct,
    onToggleMedicationReminder, onToggleMedicationCriticalStockAlerts,
    onConsumeDose, onRestoreDose, onOpenHistory, logs, onRegisterBackHandler,
  } = props;
  const isOut = statusInfo.status === 'out_of_stock';
  const isCrit = statusInfo.status === 'critical';
  const isTemporaryCourse = medication.isChronic === false;
  return (
    <div
      id={`med-card-${medication.id}`}
      className={
        `bg-white rounded-2xl border border-slate-200 p-2 shadow-sm `
        + `hover:shadow-md transition-shadow duration-200 relative overflow-hidden `
        + `border-r-[3px] ${tag.border} ${
          isOut ? 'bg-red-50/25' : isCrit ? 'bg-rose-50/20' : ''
        }`
      }
    >
      <MedicationCardHeader
        medication={medication}
        density="compact"
        onEdit={onEdit}
        onDelete={onDelete}
        onOpenHistory={onOpenHistory}
        onRegisterBackHandler={onRegisterBackHandler}
      />
      <MedicationCardStatusBadges
        medication={medication}
        statusInfo={statusInfo}
        tagBadge={tag.badge}
        density="compact"
      />
      <div className="w-full min-w-0 flex flex-wrap items-center justify-end gap-1">
        <MedicationCardDoseActions
          medication={medication}
          isAutoActive={isAutoActive}
          currentPills={currentPills}
          logs={logs}
          density="compact"
          onConsumeDose={onConsumeDose}
          onRestoreDose={onRestoreDose}
        />
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onOpenRefill(medication)}
            title="تعبئة"
            className={
              'w-5 h-5 flex items-center justify-center rounded-full bg-teal-100 '
              + 'text-teal-800 hover:bg-teal-200 transition-colors active:scale-95 '
              + 'cursor-pointer'
            }
          >
            <Plus className="w-3 h-3" />
          </button>
          <MedicationMenu
            medication={medication}
            isAutoActive={isAutoActive}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleAutoDeduct={onToggleAutoDeduct}
            onToggleMedicationReminder={onToggleMedicationReminder}
            onToggleMedicationCriticalStockAlerts={onToggleMedicationCriticalStockAlerts}
            onOpenHistory={onOpenHistory}
            onRegisterBackHandler={onRegisterBackHandler}
          />
        </div>
      </div>
      <MedicationCardStockSummary
        currentPills={currentPills}
        unit={medication.unit || 'قرص'}
        dailyDose={medication.dailyDose}
        depletionLabel={shortDepletionLabel(depletion, isOut)}
        depletionTitle={`النفاذ: ${formatDepletionDate(depletion.dateStr, depletion.daysLeft, currentPills)}`}
        density="compact"
      />
      <MedicationCardProgress
        percentLeft={percentLeft}
        progressColor={progressColor}
        density="compact"
        title={
          isTemporaryCourse
            ? `كورس علاجي (${medication.durationDays} يوم): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
            : `دواء مزمن (مقياس شهري): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
        }
      />
    </div>
  );
};

export const MedicationCardDetailedView: FC<MedicationCardViewProps> = (props) => {
  const {
    medication, isAutoActive, statusInfo, depletion, currentPills, stripsDesc,
    nonSolidPackageDesc, tag, percentLeft, progressColor, onOpenRefill, onEdit,
    onDelete, onToggleAutoDeduct, onToggleMedicationReminder,
    onToggleMedicationCriticalStockAlerts, onConsumeDose, onRestoreDose,
    onOpenHistory, logs, onRegisterBackHandler,
  } = props;
  const isOut = statusInfo.status === 'out_of_stock';
  const isCrit = statusInfo.status === 'critical';
  const isTemporaryCourse = medication.isChronic === false;
  return (
    <div
      id={`med-card-${medication.id}`}
      className={
        `bg-white rounded-2xl border border-slate-200 p-2.5 shadow-sm `
        + `hover:shadow-md transition-shadow duration-200 relative overflow-hidden `
        + `border-r-[3px] ${tag.border} ${
          isOut ? 'bg-red-50/20' : isCrit ? 'bg-rose-50/20' : ''
        }`
      }
    >
      <MedicationCardHeader
        medication={medication}
        density="detailed"
        onEdit={onEdit}
        onDelete={onDelete}
        onOpenHistory={onOpenHistory}
        onRegisterBackHandler={onRegisterBackHandler}
      />
      <MedicationCardStatusBadges
        medication={medication}
        statusInfo={statusInfo}
        tagBadge={tag.badge}
        density="detailed"
      />
      <div className="w-full min-w-0 flex flex-wrap items-center justify-end gap-1 mt-1">
        <MedicationCardDoseActions
          medication={medication}
          isAutoActive={isAutoActive}
          currentPills={currentPills}
          logs={logs}
          density="detailed"
          onConsumeDose={onConsumeDose}
          onRestoreDose={onRestoreDose}
        />
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onOpenRefill(medication)}
            title="تعبئة رصيد"
            className={
              'w-6 h-6 flex items-center justify-center rounded-full bg-teal-100 '
              + 'text-teal-800 hover:bg-teal-200 transition-colors active:scale-95 '
              + 'cursor-pointer'
            }
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <MedicationMenu
            medication={medication}
            isAutoActive={isAutoActive}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggleAutoDeduct={onToggleAutoDeduct}
            onToggleMedicationReminder={onToggleMedicationReminder}
            onToggleMedicationCriticalStockAlerts={onToggleMedicationCriticalStockAlerts}
            onOpenHistory={onOpenHistory}
            onRegisterBackHandler={onRegisterBackHandler}
            size="sm"
          />
        </div>
      </div>
      <MedicationCardStockSummary
        currentPills={currentPills}
        unit={medication.unit || 'قرص'}
        dailyDose={medication.dailyDose}
        depletionLabel={shortDepletionLabel(depletion, isOut)}
        depletionTitle={`النفاذ: ${formatDepletionDate(depletion.dateStr, depletion.daysLeft, currentPills)}`}
        density="detailed"
        nonSolidPackageDesc={nonSolidPackageDesc}
        stripsDesc={stripsDesc}
      />
      <MedicationCardProgress
        percentLeft={percentLeft}
        progressColor={progressColor}
        density="detailed"
        title={
          isTemporaryCourse
            ? `كورس علاجي (${medication.durationDays} يوم): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
            : `دواء مزمن (مقياس شهري): متبقي ${statusInfo.daysLeft} يوماً (${percentLeft}%)`
        }
      />
    </div>
  );
};
