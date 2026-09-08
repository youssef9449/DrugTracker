import React, { useState } from 'react';
import {
  Pill,
  Plus,
  MoreVertical,
  Calendar,
  Zap,
  PauseCircle,
  PlayCircle,
  Edit3,
  Trash2,
  AlertCircle,
  CheckCircle2,
  ShoppingCart,
  Clock,
  ShieldCheck,
  Layers,
  Bell,
  Volume2,
} from 'lucide-react';
import { Medication, calculateMedicationStatus, describeStockInStrips, formatTimeArabic } from '../types';
import { getDepletionDate } from '../utils/dateCalculations';
import { NOTIFICATION_SOUND_OPTIONS, playNotificationSound } from '../utils/sound';

interface MedicationCardProps {
  medication: Medication;
  viewFilter?: 'all' | 'alerts' | 'sufficient';
  onOpenRefill: (medication: Medication) => void;
  onEdit: (medication: Medication) => void;
  onDelete: (id: string) => void;
  onToggleAutoDeduct: (id: string) => void;
  onNavigateToShopping?: () => void;
  onTriggerAlarm?: (medication: Medication) => void;
}

export const MedicationCard: React.FC<MedicationCardProps> = ({
  medication,
  viewFilter = 'all',
  onOpenRefill,
  onEdit,
  onDelete,
  onToggleAutoDeduct,
  onNavigateToShopping,
  onTriggerAlarm,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const statusInfo = calculateMedicationStatus(medication);
  const depletion = getDepletionDate(medication);
  const stripsDesc = describeStockInStrips(
    medication.currentPills,
    medication.pillsPerStrip,
    medication.stripsPerBox,
    medication.unit
  );

  // Maximum visual scale for progress
  const maxVisualRange = Math.max(medication.warningThresholdDays * 3, 20);
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

  // -------------------------------------------------------------
  // VIEW 1: "قارب على النفاد" (ALERTS) - Focus on Urgency & Refill
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
                    ? `حرج: ينفد خلال ${statusInfo.daysLeft} ${statusInfo.daysLeft === 1 ? 'يوم' : 'أيام'}`
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
                {medication.stripsPerBox && medication.pillsPerStrip && (
                  <span className="text-[10px] text-teal-800 bg-white/90 border border-teal-200 px-1.5 py-0.5 rounded flex items-center gap-0.5 font-medium">
                    <Layers className="w-3 h-3 text-teal-600" />
                    <span>العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Quick Menu */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white/80 transition"
              aria-label="خيارات"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute left-0 top-8 z-30 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1 text-xs">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit(medication);
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-slate-500" />
                    <span>تعديل تفاصيل الدواء</span>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      if (onTriggerAlarm) {
                        onTriggerAlarm(medication);
                      } else {
                        playNotificationSound(medication.notificationSound || 'classic_chime');
                      }
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Volume2 className="w-3.5 h-3.5 text-teal-600" />
                    <span>تجربة صوت وتنبيه الدواء</span>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      if (onTriggerAlarm) {
                        onTriggerAlarm(medication);
                      } else {
                        playNotificationSound(medication.notificationSound || 'classic_chime');
                      }
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Volume2 className="w-3.5 h-3.5 text-teal-600" />
                    <span>تجربة صوت وتنبيه الدواء</span>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleAutoDeduct(medication.id);
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    {isAutoActive ? (
                      <>
                        <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
                        <span>إيقاف الخصم مؤقتاً</span>
                      </>
                    ) : (
                      <>
                        <PlayCircle className="w-3.5 h-3.5 text-emerald-600" />
                        <span>تفعيل الخصم</span>
                      </>
                    )}
                  </button>
                  <hr className="my-1 border-slate-100" />
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete(medication.id);
                    }}
                    className="w-full text-right px-3 py-2 text-rose-600 hover:bg-rose-50 flex items-center gap-2"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف الدواء</span>
                  </button>
                </div>
              </>
            )}
          </div>
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
                {medication.currentPills}
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
            <span className="text-[11px] text-slate-500 block">تاريخ النفاد التقديري:</span>
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

        {/* Scheduled Reminder & Custom Sound Badge */}
        {medication.reminderEnabled && medication.reminderTime && (
          <div className="mt-2.5 p-2 bg-white/90 rounded-xl border border-amber-200 flex items-center justify-between text-xs flex-wrap gap-1">
            <div className="flex items-center gap-1.5 text-amber-950">
              <Bell className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span className="font-bold text-[11px]">
                تنبيه يومي: {formatTimeArabic(medication.reminderTime)}
              </span>
              <span className="text-[10px] text-amber-900 bg-amber-100 px-1.5 py-0.2 rounded-md font-medium">
                {NOTIFICATION_SOUND_OPTIONS.find((s) => s.id === (medication.notificationSound || 'classic_chime'))?.name || 'نغمة كلاسيكية'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => {
                if (onTriggerAlarm) {
                  onTriggerAlarm(medication);
                } else {
                  playNotificationSound(medication.notificationSound || 'classic_chime');
                }
              }}
              className="px-2 py-0.5 rounded-lg bg-amber-50 hover:bg-amber-100 border border-amber-200 text-[11px] font-bold text-amber-900 flex items-center gap-1 shrink-0 active:scale-95 transition"
              title="تجربة صوت التنبيه"
            >
              <Volume2 className="w-3 h-3 text-amber-700" />
              <span>تجربة الصوت</span>
            </button>
          </div>
        )}

        {/* Quick Action: Immediate Refill + Shopping List CTA */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => onOpenRefill(medication)}
            className="flex-1 py-2 px-3 rounded-xl bg-teal-700 hover:bg-teal-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-xs"
          >
            <Plus className="w-4 h-4" />
            <span>تعبئة رصيد (+ علبة)</span>
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
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW 2: "المخزون الكافي" (SUFFICIENT) - Focus on Safety & Duration
  // -------------------------------------------------------------
  if (viewFilter === 'sufficient') {
    const safeDays = statusInfo.daysLeft;
    const monthlyUsage = medication.dailyDose * 30;

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
                {medication.stripsPerBox && medication.pillsPerStrip && (
                  <span className="text-[10px] text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded flex items-center gap-0.5 font-medium border border-emerald-200/50">
                    <Layers className="w-3 h-3 text-emerald-600" />
                    <span>العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}</span>
                  </span>
                )}
                {medication.notes && (
                  <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                    {medication.notes}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Options Menu */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              aria-label="خيارات"
            >
              <MoreVertical className="w-4 h-4" />
            </button>

            {menuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute left-0 top-8 z-30 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1 text-xs">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenRefill(medication);
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Plus className="w-3.5 h-3.5 text-teal-600" />
                    <span>إضافة علبة للمخزون</span>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit(medication);
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Edit3 className="w-3.5 h-3.5 text-slate-500" />
                    <span>تعديل الجرعة والتفاصيل</span>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      if (onTriggerAlarm) {
                        onTriggerAlarm(medication);
                      } else {
                        playNotificationSound(medication.notificationSound || 'classic_chime');
                      }
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <Volume2 className="w-3.5 h-3.5 text-teal-600" />
                    <span>تجربة صوت وتنبيه الدواء</span>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onToggleAutoDeduct(medication.id);
                    }}
                    className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                  >
                    {isAutoActive ? (
                      <>
                        <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
                        <span>تعليق الخصم التلقائي</span>
                      </>
                    ) : (
                      <>
                        <PlayCircle className="w-3.5 h-3.5 text-emerald-600" />
                        <span>تفعيل الخصم التلقائي</span>
                      </>
                    )}
                  </button>
                  <hr className="my-1 border-slate-100" />
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete(medication.id);
                    }}
                    className="w-full text-right px-3 py-2 text-rose-600 hover:bg-rose-50 flex items-center gap-2"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف الدواء</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Coverage & Stability metrics */}
        <div className="mt-3 p-2.5 bg-emerald-50/40 rounded-xl border border-emerald-100/80 grid grid-cols-3 gap-2 text-xs">
          <div>
            <span className="text-[10px] text-slate-500 block">المخزون المتوفر</span>
            <div className="flex items-baseline gap-1 mt-0.5">
              <span className="text-xl font-extrabold font-mono text-emerald-900">
                {medication.currentPills}
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

        {/* Scheduled Reminder & Custom Sound Badge */}
        {medication.reminderEnabled && medication.reminderTime && (
          <div className="mt-2 p-2 bg-emerald-50/70 rounded-xl border border-emerald-200/80 flex items-center justify-between text-xs flex-wrap gap-1">
            <div className="flex items-center gap-1.5 text-emerald-950">
              <Bell className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              <span className="font-bold text-[11px]">
                تنبيه يومي: {formatTimeArabic(medication.reminderTime)}
              </span>
              <span className="text-[10px] text-emerald-900 bg-emerald-100 px-1.5 py-0.2 rounded-md font-medium">
                {NOTIFICATION_SOUND_OPTIONS.find((s) => s.id === (medication.notificationSound || 'classic_chime'))?.name || 'نغمة كلاسيكية'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => {
                if (onTriggerAlarm) {
                  onTriggerAlarm(medication);
                } else {
                  playNotificationSound(medication.notificationSound || 'classic_chime');
                }
              }}
              className="px-2 py-0.5 rounded-lg bg-white hover:bg-emerald-100 border border-emerald-300 text-[11px] font-bold text-emerald-900 flex items-center gap-1 shrink-0 active:scale-95 transition"
              title="تجربة صوت التنبيه"
            >
              <Volume2 className="w-3 h-3 text-emerald-700" />
              <span>تجربة الصوت</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------
  // VIEW 3: "جميع الأدوية" (ALL) - Comprehensive Inventory Management
  // -------------------------------------------------------------
  return (
    <div
      id={`med-card-${medication.id}`}
      className="bg-white rounded-2xl border border-slate-200/80 p-4 shadow-xs hover:shadow-md transition relative overflow-hidden"
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
                : 'bg-teal-50 text-teal-700'
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
              {medication.stripsPerBox && medication.pillsPerStrip && (
                <span className="text-[11px] text-teal-800 bg-teal-50 border border-teal-200/60 px-2 py-0.5 rounded-md flex items-center gap-1 font-medium">
                  <Layers className="w-3 h-3 text-teal-600" />
                  <span>العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}</span>
                </span>
              )}
              {medication.notes && (
                <span className="text-[11px] text-slate-500 truncate max-w-[170px]">
                  {medication.notes}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Options Menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
            aria-label="خيارات"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {menuOpen && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute left-0 top-8 z-30 w-44 bg-white border border-slate-200 rounded-xl shadow-xl py-1 text-xs">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenRefill(medication);
                  }}
                  className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Plus className="w-3.5 h-3.5 text-teal-600" />
                  <span>تعبئة مخزون (+ علبة)</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit(medication);
                  }}
                  className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Edit3 className="w-3.5 h-3.5 text-slate-500" />
                  <span>تعديل تفاصيل الدواء</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleAutoDeduct(medication.id);
                  }}
                  className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  {isAutoActive ? (
                    <>
                      <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
                      <span>إيقاف الخصم التلقائي مؤقتاً</span>
                    </>
                  ) : (
                    <>
                      <PlayCircle className="w-3.5 h-3.5 text-emerald-600" />
                      <span>تفعيل الخصم التلقائي</span>
                    </>
                  )}
                </button>
                <hr className="my-1 border-slate-100" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete(medication.id);
                  }}
                  className="w-full text-right px-3 py-2 text-rose-600 hover:bg-rose-50 flex items-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>حذف الدواء</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Pill count & Auto deduction rate display */}
      <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2 bg-slate-50/80 p-2.5 rounded-xl">
        <div>
          <span className="text-[11px] text-slate-500 block">المخزون الحالي</span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span
              className={`text-2xl font-extrabold font-mono ${
                medication.currentPills === 0
                  ? 'text-red-600'
                  : medication.currentPills <= medication.dailyDose * 2
                  ? 'text-rose-600'
                  : 'text-slate-800'
              }`}
            >
              {medication.currentPills}
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
          <span className="text-[11px]">موعد النفاد المتوقع:</span>
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
      {!isAutoActive && (
        <div className="mt-2 text-[11px] bg-amber-50 text-amber-800 p-2 rounded-lg flex items-center gap-1.5 border border-amber-200">
          <PauseCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span>الخصم التلقائي معلق مؤقتاً لهذا الدواء.</span>
        </div>
      )}

      {/* Scheduled Reminder & Custom Sound Badge */}
      {medication.reminderEnabled && medication.reminderTime && (
        <div className="mt-2.5 p-2 bg-teal-50/70 rounded-xl border border-teal-200/80 flex items-center justify-between text-xs flex-wrap gap-1">
          <div className="flex items-center gap-1.5 text-teal-950">
            <Bell className="w-3.5 h-3.5 text-teal-700 shrink-0" />
            <span className="font-bold text-[11px]">
              تنبيه يومي: {formatTimeArabic(medication.reminderTime)}
            </span>
            <span className="text-[10px] text-teal-900 bg-teal-100 px-1.5 py-0.2 rounded-md font-medium">
              {NOTIFICATION_SOUND_OPTIONS.find((s) => s.id === (medication.notificationSound || 'classic_chime'))?.name || 'نغمة كلاسيكية'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              if (onTriggerAlarm) {
                onTriggerAlarm(medication);
              } else {
                playNotificationSound(medication.notificationSound || 'classic_chime');
              }
            }}
            className="px-2 py-0.5 rounded-lg bg-white hover:bg-teal-100 border border-teal-300 text-[11px] font-bold text-teal-900 flex items-center gap-1 shrink-0 active:scale-95 transition"
            title="تجربة صوت التنبيه"
          >
            <Volume2 className="w-3 h-3 text-teal-700" />
            <span>تجربة الصوت</span>
          </button>
        </div>
      )}

      {/* Action: Refill button upon purchasing new medicine */}
      <div className="mt-3 pt-2 flex items-center gap-2">
        <button
          onClick={() => onOpenRefill(medication)}
          className="w-full py-2 px-3 rounded-xl bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-200 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shadow-2xs"
        >
          <Plus className="w-4 h-4 text-teal-600" />
          <span>تعبئة رصيد عند الشراء (+ عبوة جديدة)</span>
        </button>
      </div>
    </div>
  );
};

