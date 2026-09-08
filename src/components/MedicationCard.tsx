import React, { useState } from 'react';
import {
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
  const isAutoActive = medication.autoDeductEnabled !== false;
  const soundOption = NOTIFICATION_SOUND_OPTIONS.find(
    (s) => s.id === (medication.notificationSound || 'classic_chime')
  );

  const maxVisualRange = Math.max(medication.warningThresholdDays * 3, 20);
  const percentLeft = Math.min(100, Math.max(0, Math.round((statusInfo.daysLeft / maxVisualRange) * 100)));

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

  const playOrTrigger = () => {
    if (onTriggerAlarm) {
      onTriggerAlarm(medication);
    } else {
      playNotificationSound(medication.notificationSound || 'classic_chime');
    }
  };

  const cardTone =
    viewFilter === 'alerts'
      ? statusInfo.status === 'out_of_stock'
        ? 'bg-red-50/40 border-red-200'
        : statusInfo.status === 'critical'
        ? 'bg-rose-50/40 border-rose-200'
        : 'bg-amber-50/30 border-amber-200'
      : viewFilter === 'sufficient'
      ? 'bg-white border-emerald-200/80'
      : 'bg-white border-slate-200/80';

  return (
    <div id={`med-card-${medication.id}`} className={`rounded-2xl border p-4 shadow-xs transition relative overflow-hidden ${cardTone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 shadow-xs ${
              statusInfo.status === 'out_of_stock'
                ? 'bg-red-600 text-white'
                : statusInfo.status === 'critical'
                ? 'bg-rose-600 text-white'
                : statusInfo.status === 'warning'
                ? 'bg-amber-500 text-white'
                : 'bg-emerald-50 text-emerald-700 border border-emerald-100'
            }`}
          >
            {statusInfo.status === 'out_of_stock' ? (
              <AlertCircle className="w-5 h-5 animate-pulse" />
            ) : statusInfo.status === 'sufficient' ? (
              <ShieldCheck className="w-6 h-6 text-emerald-600" />
            ) : (
              <Clock className="w-5 h-5" />
            )}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h3 className="text-base font-bold text-slate-900 leading-snug">{medication.name}</h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusInfo.badgeBg} border`}>
                {statusInfo.status === 'sufficient' ? (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> مخزون آمن
                  </span>
                ) : (
                  statusInfo.badgeText
                )}
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 flex-wrap">
              {medication.category && (
                <span className="font-medium bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px]">
                  {medication.category}
                </span>
              )}
              <span>
                معدل الخصم: {medication.dailyDose} {medication.unit}/يوم
              </span>
              {medication.stripsPerBox && medication.pillsPerStrip && (
                <span className="text-[10px] text-teal-800 bg-teal-50 px-1.5 py-0.5 rounded flex items-center gap-0.5 font-medium border border-teal-200/50">
                  <Layers className="w-3 h-3 text-teal-600" />
                  <span>
                    العلبة: {medication.stripsPerBox} أشرطة × {medication.pillsPerStrip} {medication.unit}
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>

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
              <div className="absolute left-0 top-8 z-30 w-48 bg-white border border-slate-200 rounded-xl shadow-xl py-1 text-xs">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onEdit(medication);
                  }}
                  className="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                >
                  <Edit3 className="w-3.5 h-3.5 text-slate-500" />
                  <span>تعديل التفاصيل والتنبيه</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    playOrTrigger();
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

      <div className="mt-3 p-3 bg-white rounded-xl border border-slate-200/90 flex items-center justify-between gap-3 text-xs">
        <div>
          <span className="text-[11px] text-slate-500 block">المتبقي حالياً:</span>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span
              className={`text-2xl font-extrabold font-mono ${
                statusInfo.status === 'out_of_stock' || statusInfo.status === 'critical'
                  ? 'text-rose-600'
                  : 'text-teal-800'
              }`}
            >
              {medication.currentPills}
            </span>
            <span className="text-xs text-slate-600 font-medium">{medication.unit}</span>
          </div>
          {stripsDesc && <span className="text-[11px] text-slate-500 font-medium block mt-0.5">({stripsDesc})</span>}
        </div>
        <div className="text-left">
          <span className="text-[11px] text-slate-500 block flex items-center gap-1 justify-end">
            <Calendar className="w-3 h-3" /> تاريخ النفاد التقديري
          </span>
          <span className="font-bold text-slate-900 block mt-0.5 text-xs">{depletion.formattedArabic}</span>
          <span className="text-[10px] text-slate-500 font-mono">
            {statusInfo.status === 'out_of_stock' ? '(المخزون نفد بالكامل)' : `(${statusInfo.daysLeft} يوم)`}
          </span>
        </div>
      </div>

      {viewFilter === 'all' && (
        <div className="mt-2.5 h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div className={`h-full ${getProgressColor()} transition-all`} style={{ width: `${percentLeft}%` }} />
        </div>
      )}

      {medication.reminderEnabled && medication.reminderTime ? (
        <div className="mt-2.5 p-2 bg-amber-50/80 rounded-xl border border-amber-200 flex items-center justify-between text-xs flex-wrap gap-1">
          <div className="flex items-center gap-1.5 text-amber-950">
            <Bell className="w-3.5 h-3.5 text-amber-600 shrink-0" />
            <span className="font-bold text-[11px]">تنبيه يومي: {formatTimeArabic(medication.reminderTime)}</span>
            <span className="text-[10px] text-amber-900 bg-amber-100 px-1.5 py-0.5 rounded-md font-medium">
              {soundOption?.icon} {soundOption?.name || 'نغمة كلاسيكية'}
            </span>
          </div>
          <button
            type="button"
            onClick={playOrTrigger}
            className="px-2 py-0.5 rounded-lg bg-white hover:bg-amber-100 border border-amber-200 text-[11px] font-bold text-amber-900 flex items-center gap-1 shrink-0 active:scale-95 transition"
          >
            <Volume2 className="w-3 h-3 text-amber-700" />
            <span>تجربة الآن</span>
          </button>
        </div>
      ) : medication.notificationSound ? (
        <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-500 px-0.5">
          <span className="flex items-center gap-1">
            <Volume2 className="w-3 h-3" />
            نغمة محفوظة: {soundOption?.name}
          </span>
          <button type="button" onClick={playOrTrigger} className="text-teal-700 font-bold hover:underline">
            استماع
          </button>
        </div>
      ) : null}

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
            className="py-2 px-3 rounded-xl bg-white hover:bg-slate-50 text-teal-800 border border-teal-300 font-bold text-xs flex items-center justify-center gap-1.5 transition active:scale-98 shrink-0"
          >
            <ShoppingCart className="w-3.5 h-3.5 text-teal-700" />
            <span>طلب واتساب</span>
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center gap-1 text-[10px] text-slate-400">
        {isAutoActive ? (
          <>
            <Zap className="w-3 h-3 text-teal-600" />
            <span>الخصم التلقائي نشط</span>
          </>
        ) : (
          <>
            <PauseCircle className="w-3 h-3 text-amber-600" />
            <span>الخصم التلقائي متوقف</span>
          </>
        )}
      </div>
    </div>
  );
};
