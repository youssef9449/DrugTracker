import { useState, type FC } from 'react';
import {
  AlertTriangle,
  Calendar,
  Check,
  FileCheck,
  Layers,
  MapPin,
  Pill,
  Phone,
  RefreshCw,
  Store,
  X,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Checkbox } from '../ui/Checkbox';
import type { ConsumptionLog, Medication, PharmacySettings } from '../../types';
import type { ParsedBackupData } from '../../utils/backupRestore';
import { pluralizeArabic } from '../../lib/arabicPlural';

export interface RestoreBackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  backupData: ParsedBackupData;
  currentMedicationsCount: number;
  onConfirmRestore: (opts: {
    backupMedications: Medication[];
    backupLogs?: ConsumptionLog[] | undefined;
    restoreLogs: boolean;
    mode: 'replace' | 'merge';
    pharmacySettings?: PharmacySettings | undefined;
    restorePharmacySettings: boolean;
  }) => Promise<boolean> | boolean;
}

export const RestoreBackupModal: FC<RestoreBackupModalProps> = ({
  isOpen,
  onClose,
  backupData,
  currentMedicationsCount,
  onConfirmRestore,
}) => {
  const [mode, setMode] = useState<'replace' | 'merge'>('replace');
  const [includeMedications, setIncludeMedications] = useState(true);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [includePharmacy, setIncludePharmacy] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const { medications, logs, pharmacySettings, exportedAt } = backupData;

  const formattedDate = exportedAt
    ? new Date(exportedAt).toLocaleDateString('ar-EG', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'تاريخ غير معروف';

  const pharmaciesCount = pharmacySettings?.pharmacies?.length ?? 0;
  const contactsCount = pharmacySettings?.whatsappContacts?.length ?? 0;
  const addressesCount = pharmacySettings?.whatsappAddresses?.length ?? 0;
  const hasUserDataOrPharmacy = Boolean(
    pharmacySettings && (pharmaciesCount > 0 || contactsCount > 0 || addressesCount > 0)
  );

  const logsSelectable =
    backupData.scope === 'all' && (mode === 'merge' || includeMedications);
  const hasAnySelection =
    (includeMedications && medications.length > 0) ||
    (includeLogs && logsSelectable) ||
    (includePharmacy && Boolean(pharmacySettings));

  const handleConfirm = async () => {
    if (!hasAnySelection || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const restoreLogs = includeLogs && logsSelectable;
      const result = await onConfirmRestore({
        backupMedications: includeMedications ? medications : [],
        backupLogs: restoreLogs ? logs : undefined,
        restoreLogs,
        mode,
        pharmacySettings: includePharmacy ? pharmacySettings : undefined,
        restorePharmacySettings: includePharmacy && Boolean(pharmacySettings),
      });
      if (result !== false) {
        onClose();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} label="استعادة النسخة الاحتياطية">
      <div
        className="w-full sm:max-w-lg bg-white rounded-t-[28px] sm:rounded-[28px] shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in slide-in-from-bottom duration-200"
        dir="rtl"
      >
        {/* Header */}
        <div className="px-5 py-4 bg-teal-800 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-full bg-teal-700/90 flex items-center justify-center">
              <RefreshCw className="w-5 h-5 text-teal-100" />
            </div>
            <div>
              <h3 className="font-bold text-base">استعادة النسخة الاحتياطية</h3>
              <p className="text-xs text-teal-200">معاينة وتأكيد استعادة بيانات الأدوية والنظام</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full text-teal-200 hover:text-white hover:bg-teal-700/80 transition flex items-center justify-center cursor-pointer"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-slate-800 text-sm">
          {/* File summary banner */}
          <div className="bg-teal-50/80 border border-teal-200/90 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-teal-900 font-bold text-sm">
              <FileCheck className="w-4 h-4 text-teal-700" />
              <span>ملف النسخة الاحتياطية تم فحصه وسليم تماماً</span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
              <div className="bg-white/80 rounded-xl p-2.5 border border-teal-100 flex items-center gap-2">
                <Pill className="w-4 h-4 text-teal-600 shrink-0" />
                <div>
                  <span className="text-[11px] text-slate-500 block">الأدوية في الملف</span>
                  <span className="font-bold text-slate-800">{medications.length} دواء</span>
                </div>
              </div>
              <div className="bg-white/80 rounded-xl p-2.5 border border-teal-100 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-teal-600 shrink-0" />
                <div>
                  <span className="text-[11px] text-slate-500 block">تاريخ التصدير</span>
                  <span className="font-bold text-slate-800 text-[11px] truncate block" title={formattedDate}>
                    {formattedDate}
                  </span>
                </div>
              </div>
            </div>

            {/* Additional data stats */}
            <div className="space-y-1.5 pt-1 border-t border-teal-100 text-xs text-slate-600">
              {logs && logs.length > 0 && (
                <div className="flex items-center justify-between px-1">
                  <span>سجلات الاستهلاك السابقة:</span>
                  <span className="font-bold text-slate-800">{logs.length} سجل</span>
                </div>
              )}
              {hasUserDataOrPharmacy && (
                <div className="grid grid-cols-3 gap-1.5 pt-1 text-[11px]">
                  {pharmaciesCount > 0 && (
                    <div className="bg-white/90 p-1.5 rounded-lg border border-teal-100 flex items-center gap-1.5">
                      <Store className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                      <span>{pharmaciesCount} صيدلية</span>
                    </div>
                  )}
                  {contactsCount > 0 && (
                    <div className="bg-white/90 p-1.5 rounded-lg border border-teal-100 flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                      <span>{contactsCount} أرقام هاتف</span>
                    </div>
                  )}
                  {addressesCount > 0 && (
                    <div className="bg-white/90 p-1.5 rounded-lg border border-teal-100 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                      <span>{addressesCount} عناوين</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Strategy selection */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold text-slate-800">
              طريقة الاستعادة:
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {/* Replace option */}
              <button
                type="button"
                onClick={() => setMode('replace')}
                className={`p-3.5 rounded-2xl border text-right transition cursor-pointer flex flex-col justify-between ${
                  mode === 'replace'
                    ? 'border-teal-600 bg-teal-50/60 ring-2 ring-teal-600/20'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1.5">
                  <span className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 text-teal-700" />
                    استبدال شامل (إحلال)
                  </span>
                  <div
                    className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                      mode === 'replace' ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'
                    }`}
                  >
                    {mode === 'replace' && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  حذف البيانات الحالية واستبدالها بما في الملف. موصى به عند النقل لجهاز جديد.
                </p>
              </button>

              {/* Merge option */}
              <button
                type="button"
                onClick={() => setMode('merge')}
                className={`p-3.5 rounded-2xl border text-right transition cursor-pointer flex flex-col justify-between ${
                  mode === 'merge'
                    ? 'border-teal-600 bg-teal-50/60 ring-2 ring-teal-600/20'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1.5">
                  <span className="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-teal-700" />
                    دمج مع البيانات الحالية
                  </span>
                  <div
                    className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                      mode === 'merge' ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'
                    }`}
                  >
                    {mode === 'merge' && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  الاحتفاظ بالبيانات الحالية وإضافة الجديد من الملف وتحديث المشترك منها.
                </p>
              </button>
            </div>
          </div>

          {/* Warning banner for Replace Mode if current meds exist and medications are to be replaced */}
          {mode === 'replace' && includeMedications && currentMedicationsCount > 0 && (
            <div className="bg-amber-50 border border-amber-200/90 rounded-2xl p-3 flex items-start gap-2.5 text-amber-900 text-xs">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-tight">
                تنبيه: سيتم استبدال <strong>{currentMedicationsCount} دواء</strong> حالي بالأدوية المستوردة ({medications.length} دواء).
              </p>
            </div>
          )}

          {/* Data restoration inclusions using Checkbox component */}
          <div className="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-2.5">
            <span className="text-xs font-bold text-slate-800 block">خيارات استعادة البيانات:</span>

            {/* Medications Checkbox (always first in the list) */}
            <label className="flex items-center gap-2.5 bg-white rounded-xl border border-slate-200 px-3 py-2.5 cursor-pointer shadow-2xs hover:border-slate-300 transition">
              <Checkbox
                checked={includeMedications}
                onChange={(e) => setIncludeMedications(e.target.checked)}
                aria-label="استعادة الأدوية والمواعيد"
              />
              <div className="min-w-0">
                <span className="text-xs font-bold text-slate-800 block">
                  استعادة الأدوية والمواعيد
                </span>
                <span className="text-[11px] text-slate-500 block">
                  {medications.length} دواء مع جرعاتها ومواعيد التنبيه
                </span>
              </div>
            </label>

            {/* Consumption Logs Checkbox */}
            {backupData.scope === 'all' && (
              <label
                className={
                  "flex items-center gap-2.5 bg-white rounded-xl border border-slate-200 px-3 py-2.5 transition " +
                  (logsSelectable
                    ? "cursor-pointer shadow-2xs hover:border-slate-300"
                    : "cursor-not-allowed opacity-60")
                }
              >
                <Checkbox
                  checked={includeLogs && logsSelectable}
                  onChange={(e) => {
                    if (logsSelectable) setIncludeLogs(e.target.checked);
                  }}
                  disabled={!logsSelectable}
                  aria-label="استعادة سجلات الاستهلاك السابقة"
                />
                <div className="min-w-0">
                  <span className="text-xs font-bold text-slate-800 block">
                    استعادة سجلات الاستهلاك السابقة
                  </span>
                  <span className="text-[11px] text-slate-500 block">
                    {logs?.length ?? 0} سجل استهلاك وجرعات
                    {!logsSelectable ? ' — اختر استعادة الأدوية أولاً في وضع الاستبدال' : ''}
                  </span>
                </div>
              </label>
            )}

            {/* Pharmacy and Personal Info Checkbox */}
            {pharmacySettings && (
              <label className="flex items-center gap-2.5 bg-white rounded-xl border border-slate-200 px-3 py-2.5 cursor-pointer shadow-2xs hover:border-slate-300 transition">
                <Checkbox
                  checked={includePharmacy}
                  onChange={(e) => setIncludePharmacy(e.target.checked)}
                  aria-label="استعادة بيانات الصيدليات وأرقام الهاتف والعناوين"
                />
                <div className="min-w-0">
                  <span className="text-xs font-bold text-slate-800 block">
                    استعادة بيانات الصيدليات وأرقام الهاتف والعناوين
                  </span>
                  <span className="text-[11px] text-slate-500 block">
                    {pharmaciesCount} صيدلية، {contactsCount} أرقام هاتف، و{addressesCount} عناوين من صفحة بياناتي
                  </span>
                </div>
              </label>
            )}
          </div>

          {/* Medications list preview — shown when medications are selected for restore */}
          {includeMedications && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-slate-700">
                  معاينة الأدوية التي ستستعاد ({medications.length}):
                </span>
              </div>
              <div className="max-h-44 overflow-y-auto space-y-1.5 p-1 border border-slate-100 rounded-xl bg-slate-50/50">
                {medications.map((m) => (
                  <div
                    key={m.id}
                    className="bg-white border border-slate-200/80 rounded-xl p-2.5 flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: m.colorTag || '#0d9488' }}
                      />
                      <span className="font-bold text-slate-900 truncate">{m.name}</span>
                      {m.category && (
                        <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-md truncate max-w-[90px]">
                          {m.category}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-slate-500 text-[11px] shrink-0">
                      <span>
                        {pluralizeArabic(m.currentPills, m.unit)}
                      </span>
                      <span className="text-slate-300">•</span>
                      <span>جرعة: {m.dailyDose}/يومياً</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-10 px-4 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-semibold transition cursor-pointer"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={() => { void handleConfirm(); }}
            disabled={isSubmitting || !hasAnySelection}
            className="h-10 px-6 rounded-full bg-teal-700 hover:bg-teal-800 active:scale-98 text-white text-xs font-bold flex items-center gap-2 shadow-2xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>جاري الاستعادة...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                <span>تأكيد استعادة البيانات</span>
              </>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};
