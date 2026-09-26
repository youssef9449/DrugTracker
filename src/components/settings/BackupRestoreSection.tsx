import { useState, useRef, type FC, type ChangeEvent } from 'react';
import {
  Download,
  Upload,
  Database,
  Pill,
  Archive,
} from 'lucide-react';
import type { ConsumptionLog, Medication, PharmacySettings } from '../../types';
import {
  createBackupPayload,
  downloadBackupFile,
  parseAndValidateBackupFile,
  type BackupScope,
  type ParsedBackupData,
} from '../../utils/backupRestore';
import { RestoreBackupModal } from './RestoreBackupModal';
import { playSuccessChime } from '../../utils/sound';

export interface BackupRestoreSectionProps {
  medications: Medication[];
  logs?: ConsumptionLog[] | undefined;
  pharmacySettings?: PharmacySettings | undefined;
  onRestore: (opts: {
    backupMedications: Medication[];
    backupLogs?: ConsumptionLog[] | undefined;
    restoreLogs: boolean;
    mode: 'replace' | 'merge';
    pharmacySettings?: PharmacySettings | undefined;
    onApplyPharmacySettings?: ((settings: PharmacySettings) => Promise<boolean> | boolean) | undefined;
  }) => Promise<boolean> | boolean;
  onSavePharmacySettings?: ((settings: PharmacySettings) => Promise<boolean> | boolean) | undefined;
  soundEnabled: boolean;
  showToast?: ((message: string) => void) | undefined;
}

export const BackupRestoreSection: FC<BackupRestoreSectionProps> = ({
  medications,
  logs,
  pharmacySettings,
  onRestore,
  onSavePharmacySettings,
  soundEnabled,
  showToast,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [exportScope, setExportScope] = useState<BackupScope>('all');
  const [activeBackupData, setActiveBackupData] = useState<ParsedBackupData | null>(null);

  // Trigger file download according to selected scope
  const handleExportBackup = () => {
    if (medications.length === 0) {
      showToast?.('لا توجد أدوية حالياً لحفظها في النسخة الاحتياطية.');
      return;
    }
    const backup = createBackupPayload(exportScope, medications, logs, pharmacySettings);
    const result = downloadBackupFile(backup);

    if (result.ok) {
      if (soundEnabled) playSuccessChime();
      const scopeLabel = exportScope === 'all' ? 'كامل البيانات' : 'الأدوية فقط';
      showToast?.(`تم حفظ النسخة الاحتياطية بنجاح (${scopeLabel})`);
    } else {
      showToast?.(`تعذر تنزيل الملف: ${result.error || 'خطأ غير معروف'}`);
    }
  };

  // Open native file selector
  const handleTriggerFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  // Process chosen JSON file
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      const validation = parseAndValidateBackupFile(content);

      if (!validation.ok) {
        showToast?.(validation.error);
        return;
      }

      setActiveBackupData(validation.data);
    };

    reader.onerror = () => {
      showToast?.('تعذر قراءة الملف المحدد.');
    };

    reader.readAsText(file);
  };

  // Confirm and execute the restore
  const handleConfirmRestore = async (opts: {
    backupMedications: Medication[];
    backupLogs?: ConsumptionLog[] | undefined;
    restoreLogs: boolean;
    mode: 'replace' | 'merge';
    pharmacySettings?: PharmacySettings | undefined;
    restorePharmacySettings: boolean;
  }): Promise<boolean> => {
    return onRestore({
      backupMedications: opts.backupMedications,
      backupLogs: opts.backupLogs,
      restoreLogs: opts.restoreLogs,
      mode: opts.mode,
      pharmacySettings: opts.restorePharmacySettings ? opts.pharmacySettings : undefined,
      onApplyPharmacySettings: onSavePharmacySettings,
    });
  };

  const pharmaciesCount = pharmacySettings?.pharmacies?.length ?? 0;
  const contactsCount = pharmacySettings?.whatsappContacts?.length ?? 0;
  const addressesCount = pharmacySettings?.whatsappAddresses?.length ?? 0;

  return (
    <>
      <div className="bg-slate-50 border border-slate-200/90 rounded-2xl p-4 space-y-4" dir="rtl">
        {/* Section header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-teal-100 text-teal-800">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-slate-800">النسخ الاحتياطي والاستعادة</h4>
              <p className="text-[11px] text-slate-500">حفظ بياناتك بأمان واسترجاعها بأي وقت عبر ملف</p>
            </div>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-teal-100 text-teal-800">
            {medications.length} {medications.length === 1 ? 'دواء' : 'أدوية'}
          </span>
        </div>

        {/* Scope Selector: Segmented Control / Choice */}
        <div className="bg-white border border-slate-200/90 rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="backup-scope-select" className="text-xs font-bold text-slate-700">
              نطاق النسخة الاحتياطية:
            </label>
            <span className="text-[11px] text-slate-400">
              {exportScope === 'all' ? 'شامل لكل البيانات' : 'الأدوية فقط'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {/* Medications only option */}
            <button
              type="button"
              onClick={() => setExportScope('medications')}
              className={`p-2.5 rounded-xl border text-right transition cursor-pointer flex items-center gap-2 ${
                exportScope === 'medications'
                  ? 'border-teal-600 bg-teal-50/70 text-teal-900 font-bold shadow-2xs'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                  exportScope === 'medications' ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500'
                }`}
              >
                <Pill className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="text-xs block leading-tight">الأدوية فقط</span>
                <span className="text-[10px] text-slate-500 block truncate font-normal">
                  {medications.length} دواء
                </span>
              </div>
            </button>

            {/* All data option */}
            <button
              type="button"
              onClick={() => setExportScope('all')}
              className={`p-2.5 rounded-xl border text-right transition cursor-pointer flex items-center gap-2 ${
                exportScope === 'all'
                  ? 'border-teal-600 bg-teal-50/70 text-teal-900 font-bold shadow-2xs'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                  exportScope === 'all' ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-500'
                }`}
              >
                <Archive className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <span className="text-xs block leading-tight">كل البيانات</span>
                <span className="text-[10px] text-slate-500 block truncate font-normal">
                  أدوية + صيدليات + عناويني
                </span>
              </div>
            </button>
          </div>

          {/* Fixed-height description line to prevent height jumps when toggling */}
          <div
            className={`min-h-[38px] flex items-center text-[10px] p-2 rounded-lg leading-relaxed border transition-opacity duration-150 ${
              exportScope === 'all'
                ? 'opacity-100 text-slate-600 bg-slate-50 border-slate-100'
                : 'opacity-0 pointer-events-none select-none border-transparent'
            }`}
            aria-hidden={exportScope !== 'all'}
          >
            <span>
              يتضمن: {medications.length} دواء، {logs?.length ?? 0} سجل استهلاك، {pharmaciesCount} صيدلية، {contactsCount} أرقام هاتف، و{addressesCount} عناوين من صفحة بياناتي.
            </span>
          </div>
        </div>

        {/* Buttons Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-0.5">
          {/* Export Button */}
          <button
            type="button"
            onClick={handleExportBackup}
            className="w-full h-11 px-4 rounded-xl bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 text-xs font-bold flex items-center justify-center gap-2 shadow-2xs transition active:scale-98 cursor-pointer"
          >
            <Download className="w-4 h-4 text-teal-700" />
            <span>
              {exportScope === 'all' ? 'حفظ نسخة (كل البيانات)' : 'حفظ نسخة (الأدوية)'}
            </span>
          </button>

          {/* Import / Restore Button */}
          <div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".json,application/json,text/plain"
              className="hidden"
            />
            <button
              type="button"
              onClick={handleTriggerFileInput}
              className="w-full h-11 px-4 rounded-xl bg-teal-700 hover:bg-teal-800 active:scale-98 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-2xs transition cursor-pointer"
            >
              <Upload className="w-4 h-4 text-teal-100" />
              <span>استعادة من ملف</span>
            </button>
          </div>
        </div>
      </div>

      {/* Restore Confirmation & Preview Modal */}
      {activeBackupData && (
        <RestoreBackupModal
          isOpen={Boolean(activeBackupData)}
          onClose={() => setActiveBackupData(null)}
          backupData={activeBackupData}
          currentMedicationsCount={medications.length}
          onConfirmRestore={handleConfirmRestore}
        />
      )}
    </>
  );
};
