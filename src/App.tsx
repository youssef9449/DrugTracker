import React, { useState, useEffect, useMemo } from 'react';
import {
  Medication,
  ConsumptionLog,
  PharmacySettings,
  DEFAULT_PHARMACY_SETTINGS,
  calculateMedicationStatus,
} from './types';
import { INITIAL_MEDICATIONS, INITIAL_LOGS } from './data/initialData';
import { AndroidStatusBar } from './components/AndroidStatusBar';
import { AndroidNavBar } from './components/AndroidNavBar';
import { AndroidBottomNav, ActiveTab } from './components/AndroidBottomNav';
import { AppHeader } from './components/AppHeader';
import { LowStockBanner } from './components/LowStockBanner';
import { MedicationCard } from './components/MedicationCard';
import { PharmacyShoppingView } from './components/PharmacyShoppingView';
import { ConsumptionLogView } from './components/ConsumptionLogView';
import { AddMedicationModal } from './components/AddMedicationModal';
import { RefillModal } from './components/RefillModal';
import { PharmacySettingsModal } from './components/PharmacySettingsModal';
import { AndroidFab } from './components/AndroidFab';
import { EmptyState } from './components/EmptyState';
import { DoseAlarmModal } from './components/DoseAlarmModal';
import { playSuccessChime, playAlertChime } from './utils/sound';
import { requestNotificationPermission, sendMedicineAlert } from './utils/notifications';
import { getTodayDateString, syncAutoDailyDeductions } from './utils/dateCalculations';
import { useDoseReminders } from './hooks/useDoseReminders';
import { Zap } from 'lucide-react';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_PHARMACY_KEY = 'android_med_tracker_pharmacy_v2';
const SOUND_KEY = 'android_med_tracker_sound_v1';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('stock');

  const [medications, setMedications] = useState<Medication[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_MEDS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // ignore
    }
    return INITIAL_MEDICATIONS;
  });

  const [logs, setLogs] = useState<ConsumptionLog[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_LOGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return INITIAL_LOGS;
  });

  const [pharmacySettings, setPharmacySettings] = useState<PharmacySettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PHARMACY_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return { ...DEFAULT_PHARMACY_SETTINGS, ...parsed, customerCode: parsed.customerCode || '14739' };
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_PHARMACY_SETTINGS;
  });

  const [filter, setFilter] = useState<'all' | 'alerts' | 'sufficient'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [editingMedication, setEditingMedication] = useState<Medication | null>(null);
  const [refillMedication, setRefillMedication] = useState<Medication | null>(null);

  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    return typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted';
  });

  const [isPhoneFrame, setIsPhoneFrame] = useState(true);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  const { alarmingMedication, dismissAlarm, snoozeAlarm, testAlarm } = useDoseReminders({
    medications,
    soundEnabled,
    notificationsEnabled,
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_MEDS_KEY, JSON.stringify(medications));
    } catch {
      // ignore
    }
  }, [medications]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_LOGS_KEY, JSON.stringify(logs));
    } catch {
      // ignore
    }
  }, [logs]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PHARMACY_KEY, JSON.stringify(pharmacySettings));
    } catch {
      // ignore
    }
  }, [pharmacySettings]);

  useEffect(() => {
    try {
      localStorage.setItem(SOUND_KEY, String(soundEnabled));
    } catch {
      // ignore
    }
  }, [soundEnabled]);

  const showToast = (message: string) => {
    const id = Date.now();
    setToast({ id, message });
    setTimeout(() => {
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 4000);
  };

  useEffect(() => {
    const today = getTodayDateString();
    const result = syncAutoDailyDeductions(medications, today);

    if (result.newLogs.length > 0) {
      setMedications(result.updatedMeds);
      setLogs((prev) => [...result.newLogs, ...prev]);
      const totalPills = result.deductedSummary.reduce((sum, item) => sum + item.pillsDeducted, 0);
      showToast(`تم الخصم التلقائي للاستهلاك: خصم ${totalPills} قرص لمرور الأيام.`);
    }

    if (notificationsEnabled) {
      result.updatedMeds.forEach((med) => {
        const { status, daysLeft } = calculateMedicationStatus(med);
        if (status === 'critical' || status === 'warning') {
          sendMedicineAlert(med.name, daysLeft, med.currentPills);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSimulateDaysPassed = (days: number) => {
    if (days <= 0) return;
    const newLogs: ConsumptionLog[] = [];
    const today = getTodayDateString();

    setMedications((prev) =>
      prev.map((med) => {
        if (med.autoDeductEnabled === false || med.dailyDose <= 0) return med;
        const pillsToDeduct = Math.min(med.currentPills, days * med.dailyDose);
        const newPills = Math.max(0, med.currentPills - pillsToDeduct);
        if (pillsToDeduct > 0) {
          newLogs.push({
            id: 'sim-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
            medicationId: med.id,
            medicationName: med.name,
            type: 'auto_daily',
            amount: -pillsToDeduct,
            date: today,
            timestamp: new Date().toISOString(),
            description: `محاكاة مرور ${days} ${days === 1 ? 'يوم' : 'أيام'} (-${pillsToDeduct} ${med.unit})`,
          });
        }
        return { ...med, currentPills: newPills };
      })
    );

    if (newLogs.length > 0) setLogs((prev) => [...newLogs, ...prev]);
    if (soundEnabled) playAlertChime();
    showToast(`تمت محاكاة مرور ${days} ${days === 1 ? 'يوم' : 'أيام'} وخصم الاستهلاك تلقائياً`);
  };

  const handleRestoreDose = (medicationId: string, reason: string) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    const restoredAmount = med.dailyDose;
    setMedications((prev) =>
      prev.map((m) => (m.id === medicationId ? { ...m, currentPills: m.currentPills + restoredAmount } : m))
    );
    setLogs((prev) => [
      {
        id: 'restore-' + Date.now(),
        medicationId: med.id,
        medicationName: med.name,
        type: 'skipped_day',
        amount: restoredAmount,
        date: getTodayDateString(),
        timestamp: new Date().toISOString(),
        description: `استرجاع جرعة (${reason}) (+${restoredAmount} ${med.unit})`,
      },
      ...prev,
    ]);
    if (soundEnabled) playSuccessChime();
  };

  const handleConfirmRefill = (medicationId: string, addedPills: number) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;
    setMedications((prev) =>
      prev.map((m) => (m.id === medicationId ? { ...m, currentPills: m.currentPills + addedPills } : m))
    );
    setLogs((prev) => [
      {
        id: 'refill-' + Date.now(),
        medicationId: med.id,
        medicationName: med.name,
        type: 'refill',
        amount: addedPills,
        date: getTodayDateString(),
        timestamp: new Date().toISOString(),
        description: `شراء وتعبئة مخزون (+${addedPills} ${med.unit})`,
      },
      ...prev,
    ]);
    if (soundEnabled) playSuccessChime();
  };

  const handleToggleAutoDeduct = (medicationId: string) => {
    setMedications((prev) =>
      prev.map((m) => {
        if (m.id === medicationId) {
          const newState = m.autoDeductEnabled === false;
          showToast(
            newState ? `تم تفعيل الخصم التلقائي لـ "${m.name}"` : `تم إيقاف الخصم التلقائي مؤقتاً لـ "${m.name}"`
          );
          return { ...m, autoDeductEnabled: newState };
        }
        return m;
      })
    );
  };

  const handleSaveMedication = (medData: Omit<Medication, 'id' | 'createdAt'>, editId?: string) => {
    if (editId) {
      setMedications((prev) => prev.map((m) => (m.id === editId ? { ...m, ...medData } : m)));
      showToast(
        medData.reminderEnabled
          ? `تم حفظ "${medData.name}" مع تذكير يومي الساعة ${medData.reminderTime}`
          : `تم تعديل بيانات "${medData.name}" بنجاح`
      );
    } else {
      const newMed: Medication = {
        ...medData,
        id: 'med-' + Date.now(),
        createdAt: new Date().toISOString(),
        lastSyncDate: getTodayDateString(),
        autoDeductEnabled: true,
      };
      setMedications((prev) => [newMed, ...prev]);
      showToast(
        newMed.reminderEnabled
          ? `تمت إضافة "${newMed.name}" مع تنبيه الساعة ${newMed.reminderTime}`
          : `تمت إضافة "${newMed.name}"، وسيحسب استهلاكه تلقائياً`
      );
    }
    if (soundEnabled) playSuccessChime();
    setEditingMedication(null);
  };

  const handleSavePharmacySettings = (newSettings: PharmacySettings) => {
    setPharmacySettings(newSettings);
    showToast('تم حفظ إعدادات الصيدلية ورقم العميل والكميات بنجاح!');
    if (soundEnabled) playSuccessChime();
  };

  const handleDeleteMedication = (id: string) => {
    const med = medications.find((m) => m.id === id);
    if (!med) return;
    setMedications((prev) => prev.filter((m) => m.id !== id));
    showToast(`تم حذف "${med.name}" من القائمة`);
  };

  const handleToggleNotifications = async () => {
    if (!notificationsEnabled) {
      const granted = await requestNotificationPermission();
      setNotificationsEnabled(granted);
      showToast(granted ? 'تم تفعيل إشعارات الهاتف بنجاح' : 'يرجى السماح بالإشعارات في إعدادات المتصفح');
    } else {
      setNotificationsEnabled(false);
      showToast('تم إيقاف التنبيهات');
    }
  };

  const handleTakeDoseFromAlarm = (med: Medication) => {
    dismissAlarm();
    showToast(`تم تسجيل جرعة "${med.name}". الخصم اليومي يتم تلقائياً بمرور اليوم.`);
    if (soundEnabled) playSuccessChime();
  };

  const handleSnoozeFromAlarm = (med: Medication) => {
    snoozeAlarm(10);
    showToast(`تم تأجيل تنبيه "${med.name}" عشر دقائق`);
  };

  const filteredMedications = useMemo(() => {
    return medications.filter((med) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = med.name.toLowerCase().includes(q);
        const matchCat = med.category?.toLowerCase().includes(q) || false;
        const matchNotes = med.notes?.toLowerCase().includes(q) || false;
        if (!matchName && !matchCat && !matchNotes) return false;
      }
      const { status } = calculateMedicationStatus(med);
      if (filter === 'alerts') return status === 'out_of_stock' || status === 'critical' || status === 'warning';
      if (filter === 'sufficient') return status === 'sufficient';
      return true;
    });
  }, [medications, searchQuery, filter]);

  const alertsCount = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    }).length;
  }, [medications]);

  const sufficientCount = useMemo(() => {
    return medications.filter((m) => calculateMedicationStatus(m).status === 'sufficient').length;
  }, [medications]);

  const totalPillsCount = useMemo(() => {
    return medications.reduce((acc, m) => acc + m.currentPills, 0);
  }, [medications]);

  const openAdd = () => {
    setEditingMedication(null);
    setIsAddModalOpen(true);
  };

  return (
    <div
      dir="rtl"
      className="min-h-screen bg-slate-900 text-slate-800 flex items-center justify-center p-0 md:p-6 font-sans selection:bg-teal-200"
    >
      <div
        className={`w-full bg-slate-100 flex flex-col transition-all duration-300 relative ${
          isPhoneFrame
            ? 'max-w-md h-[100dvh] md:h-[860px] md:max-h-[92vh] md:rounded-[42px] md:border-8 md:border-slate-800 md:shadow-2xl overflow-hidden'
            : 'max-w-4xl min-h-screen md:min-h-[90vh] md:rounded-3xl md:border md:border-slate-300 md:shadow-xl overflow-hidden'
        }`}
      >
        <AndroidStatusBar />
        <AppHeader
          activeTab={activeTab}
          filter={filter}
          onFilterChange={setFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          alertsCount={alertsCount}
          notificationsEnabled={notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          soundEnabled={soundEnabled}
          onToggleSound={() => setSoundEnabled(!soundEnabled)}
          isPhoneFrame={isPhoneFrame}
          onTogglePhoneFrame={() => setIsPhoneFrame(!isPhoneFrame)}
          onOpenSettings={() => setIsSettingsModalOpen(true)}
          onOpenAddModal={openAdd}
        />

        <main className="flex-1 overflow-y-auto pb-24 relative">
          {activeTab === 'stock' && (
            <div>
              {filter === 'all' && (
                <div>
                  <div className="mx-4 mt-3 p-3 bg-teal-50 border border-teal-200/90 rounded-2xl flex items-center justify-between text-xs shadow-xs">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0">
                        <Zap className="w-4 h-4" />
                      </div>
                      <div>
                        <span className="font-bold text-teal-950 block text-[11px]">الخصم التلقائي اليومي نشط</span>
                        <p className="text-[10px] text-teal-800">يتم احتساب الجرعات بمرور الأيام لتحديث رصيدك وموعد النفاد بدقة.</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setActiveTab('logs')}
                      className="text-[11px] font-bold text-teal-700 hover:text-teal-900 bg-teal-100/70 px-2.5 py-1 rounded-lg shrink-0"
                    >
                      عرض السجل
                    </button>
                  </div>
                  <div className="mx-4 mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
                      <span className="text-[10px] text-slate-500 block">إجمالي الأدوية</span>
                      <span className="text-base font-extrabold font-mono text-slate-800">{medications.length}</span>
                    </div>
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
                      <span className="text-[10px] text-slate-500 block">المخزون الكلي</span>
                      <span className="text-base font-extrabold font-mono text-teal-800">{totalPillsCount}</span>
                    </div>
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs">
                      <span className="text-[10px] text-slate-500 block">حالة المخزون</span>
                      <div className="flex items-center justify-center gap-1.5 mt-0.5 text-[11px]">
                        <span className="text-emerald-700 font-bold font-mono">{sufficientCount} آمن</span>
                        <span className="text-slate-300">•</span>
                        <span className={`font-mono font-bold ${alertsCount > 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                          {alertsCount} ناقص
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {filter === 'alerts' && (
                <LowStockBanner medications={medications} onNavigateToShopping={() => setActiveTab('shopping')} />
              )}

              <div className="p-4 space-y-3">
                {filteredMedications.length === 0 ? (
                  <EmptyState
                    hasSearch={Boolean(searchQuery.trim())}
                    onClearSearch={() => setSearchQuery('')}
                    filter={filter}
                    onFilterChange={setFilter}
                    onOpenAddModal={openAdd}
                  />
                ) : (
                  filteredMedications.map((med) => (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      viewFilter={filter}
                      onOpenRefill={setRefillMedication}
                      onEdit={(m) => {
                        setEditingMedication(m);
                        setIsAddModalOpen(true);
                      }}
                      onDelete={handleDeleteMedication}
                      onToggleAutoDeduct={handleToggleAutoDeduct}
                      onNavigateToShopping={() => setActiveTab('shopping')}
                      onTriggerAlarm={testAlarm}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {activeTab === 'shopping' && (
            <PharmacyShoppingView
              medications={medications}
              settings={pharmacySettings}
              onUpdateSettings={setPharmacySettings}
              onOpenSettings={() => setIsSettingsModalOpen(true)}
              onConfirmRefill={handleConfirmRefill}
              showToast={showToast}
            />
          )}

          {activeTab === 'logs' && (
            <ConsumptionLogView
              medications={medications}
              logs={logs}
              onAddLog={(log) => setLogs((prev) => [log, ...prev])}
              onSimulateDaysPassed={handleSimulateDaysPassed}
              onRestoreDose={handleRestoreDose}
              showToast={showToast}
            />
          )}
        </main>

        {activeTab === 'stock' && <AndroidFab onOpenAddModal={openAdd} />}
        <AndroidBottomNav activeTab={activeTab} onTabChange={setActiveTab} alertsCount={alertsCount} />
        <AndroidNavBar />

        {toast && (
          <div className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 max-w-[90%] px-4 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-2xl shadow-xl text-center">
            {toast.message}
          </div>
        )}
      </div>

      <AddMedicationModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingMedication(null);
        }}
        onSave={handleSaveMedication}
        initialData={editingMedication}
      />
      <RefillModal
        medication={refillMedication}
        isOpen={Boolean(refillMedication)}
        onClose={() => setRefillMedication(null)}
        onConfirmRefill={handleConfirmRefill}
      />
      <PharmacySettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        settings={pharmacySettings}
        medications={medications}
        onSaveSettings={handleSavePharmacySettings}
      />
      <DoseAlarmModal
        isOpen={Boolean(alarmingMedication)}
        medication={alarmingMedication}
        onTakeDose={handleTakeDoseFromAlarm}
        onSnooze={handleSnoozeFromAlarm}
        onDismiss={dismissAlarm}
      />
    </div>
  );
}
