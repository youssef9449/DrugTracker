import React, { useState, useEffect, useMemo } from 'react';
import { Medication, ConsumptionLog, PharmacySettings, DEFAULT_PHARMACY_SETTINGS, calculateMedicationStatus } from './types';
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
import { playSuccessChime, playAlertChime } from './utils/sound';
import { requestNotificationPermission, sendMedicineAlert } from './utils/notifications';
import { getTodayDateString, syncAutoDailyDeductions } from './utils/dateCalculations';
import { Zap, RotateCcw, CheckCircle2, ShoppingCart, Calendar, AlertCircle, ShieldCheck } from 'lucide-react';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_PHARMACY_KEY = 'android_med_tracker_pharmacy_v2';
const SOUND_KEY = 'android_med_tracker_sound_v1';

export default function App() {
  // Navigation State
  const [activeTab, setActiveTab] = useState<ActiveTab>('stock');

  // Medications State
  const [medications, setMedications] = useState<Medication[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_MEDS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Storage unavailable
    }
    return INITIAL_MEDICATIONS;
  });

  // Consumption Logs State
  const [logs, setLogs] = useState<ConsumptionLog[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_LOGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {
      // Storage unavailable
    }
    return INITIAL_LOGS;
  });

  // Pharmacy & WhatsApp Settings State
  const [pharmacySettings, setPharmacySettings] = useState<PharmacySettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PHARMACY_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return {
            ...DEFAULT_PHARMACY_SETTINGS,
            ...parsed,
            customerCode: parsed.customerCode || '14739',
          };
        }
      }
    } catch {
      // Storage unavailable
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

  // Sync with LocalStorage
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

  // 1. AUTOMATIC DAILY DEDUCTION ENGINE:
  // Runs once on application start and synchronizes any elapsed calendar days automatically
  useEffect(() => {
    const today = getTodayDateString();
    const result = syncAutoDailyDeductions(medications, today);

    if (result.newLogs.length > 0) {
      setMedications(result.updatedMeds);
      setLogs((prev) => [...result.newLogs, ...prev]);

      const totalPills = result.deductedSummary.reduce((sum, item) => sum + item.pillsDeducted, 0);
      showToast(`تم الخصم التلقائي للاستهلاك: خصم ${totalPills} قرص لمرور الأيام.`);
    }

    // Check low stock and alert
    if (notificationsEnabled) {
      result.updatedMeds.forEach((med) => {
        const { status, daysLeft } = calculateMedicationStatus(med);
        if (status === 'critical' || status === 'warning') {
          sendMedicineAlert(med.name, daysLeft, med.currentPills);
        }
      });
    }
  }, []);

  // Handler: Manual simulation of passing days (for testing & verification)
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
        return {
          ...med,
          currentPills: newPills,
        };
      })
    );

    if (newLogs.length > 0) {
      setLogs((prev) => [...newLogs, ...prev]);
    }

    if (soundEnabled) playAlertChime();
    showToast(`تمت محاكاة مرور ${days} ${days === 1 ? 'يوم' : 'أيام'} وخصم الاستهلاك تلقائياً`);
  };

  // Handler: "Didn't take dose today" / Restore dose
  const handleRestoreDose = (medicationId: string, reason: string) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;

    const restoredAmount = med.dailyDose;
    setMedications((prev) =>
      prev.map((m) =>
        m.id === medicationId ? { ...m, currentPills: m.currentPills + restoredAmount } : m
      )
    );

    const log: ConsumptionLog = {
      id: 'restore-' + Date.now(),
      medicationId: med.id,
      medicationName: med.name,
      type: 'skipped_day',
      amount: restoredAmount,
      date: getTodayDateString(),
      timestamp: new Date().toISOString(),
      description: `استرجاع جرعة (${reason}) (+${restoredAmount} ${med.unit})`,
    };

    setLogs((prev) => [log, ...prev]);
    if (soundEnabled) playSuccessChime();
  };

  // Handler: Refill upon purchase
  const handleConfirmRefill = (medicationId: string, addedPills: number) => {
    const med = medications.find((m) => m.id === medicationId);
    if (!med) return;

    setMedications((prev) =>
      prev.map((m) =>
        m.id === medicationId ? { ...m, currentPills: m.currentPills + addedPills } : m
      )
    );

    const log: ConsumptionLog = {
      id: 'refill-' + Date.now(),
      medicationId: med.id,
      medicationName: med.name,
      type: 'refill',
      amount: addedPills,
      date: getTodayDateString(),
      timestamp: new Date().toISOString(),
      description: `شراء وتعبئة مخزون (+${addedPills} ${med.unit})`,
    };

    setLogs((prev) => [log, ...prev]);
    if (soundEnabled) playSuccessChime();
  };

  // Handler: Toggle auto-deduct for a medication
  const handleToggleAutoDeduct = (medicationId: string) => {
    setMedications((prev) =>
      prev.map((m) => {
        if (m.id === medicationId) {
          const newState = m.autoDeductEnabled === false;
          showToast(
            newState
              ? `تم تفعيل الخصم التلقائي لـ "${m.name}"`
              : `تم إيقاف الخصم التلقائي مؤقتاً لـ "${m.name}"`
          );
          return { ...m, autoDeductEnabled: newState };
        }
        return m;
      })
    );
  };

  // Handler: Save or Update medication
  const handleSaveMedication = (
    medData: Omit<Medication, 'id' | 'createdAt'>,
    editId?: string
  ) => {
    if (editId) {
      setMedications((prev) =>
        prev.map((m) => (m.id === editId ? { ...m, ...medData } : m))
      );
      showToast(`تم تعديل بيانات "${medData.name}" بنجاح`);
    } else {
      const newMed: Medication = {
        ...medData,
        id: 'med-' + Date.now(),
        createdAt: new Date().toISOString(),
        lastSyncDate: getTodayDateString(),
        autoDeductEnabled: true,
      };
      setMedications((prev) => [newMed, ...prev]);
      showToast(`تمت إضافة "${newMed.name}"، وسيحسب استهلاكه تلقائياً`);
    }

    if (soundEnabled) playSuccessChime();
    setEditingMedication(null);
  };

  // Handler: Save Pharmacy Settings
  const handleSavePharmacySettings = (newSettings: PharmacySettings) => {
    setPharmacySettings(newSettings);
    showToast('تم حفظ إعدادات الصيدلية ورقم العميل والكميات بنجاح!');
    if (soundEnabled) playSuccessChime();
  };

  // Handler: Delete medication
  const handleDeleteMedication = (id: string) => {
    const med = medications.find((m) => m.id === id);
    if (!med) return;

    setMedications((prev) => prev.filter((m) => m.id !== id));
    showToast(`تم حذف "${med.name}" من القائمة`);
  };

  // Handler: Toggle notifications
  const handleToggleNotifications = async () => {
    if (!notificationsEnabled) {
      const granted = await requestNotificationPermission();
      setNotificationsEnabled(granted);
      if (granted) {
        showToast('تم تفعيل إشعارات الهاتف بنجاح');
      } else {
        showToast('يرجى السماح بالإشعارات في إعدادات المتصفح');
      }
    } else {
      setNotificationsEnabled(false);
      showToast('تم إيقاف التنبيهات');
    }
  };

  // Filtered medications for Stock tab
  const filteredMedications = useMemo(() => {
    return medications.filter((med) => {
      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = med.name.toLowerCase().includes(q);
        const matchCat = med.category?.toLowerCase().includes(q) || false;
        const matchNotes = med.notes?.toLowerCase().includes(q) || false;
        if (!matchName && !matchCat && !matchNotes) return false;
      }

      // Filter chips
      const { status } = calculateMedicationStatus(med);
      if (filter === 'alerts') {
        return status === 'out_of_stock' || status === 'critical' || status === 'warning';
      }
      if (filter === 'sufficient') {
        return status === 'sufficient';
      }
      return true;
    });
  }, [medications, searchQuery, filter]);

  // Urgent alerts count
  const alertsCount = useMemo(() => {
    return medications.filter((m) => {
      const { status } = calculateMedicationStatus(m);
      return status === 'out_of_stock' || status === 'critical' || status === 'warning';
    }).length;
  }, [medications]);

  // Sufficient stock count & pills
  const sufficientMeds = useMemo(() => {
    return medications.filter((m) => calculateMedicationStatus(m).status === 'sufficient');
  }, [medications]);

  const sufficientCount = sufficientMeds.length;
  const sufficientPillsCount = useMemo(() => {
    return sufficientMeds.reduce((acc, m) => acc + m.currentPills, 0);
  }, [sufficientMeds]);

  // Total current pills in stock
  const totalPillsCount = useMemo(() => {
    return medications.reduce((acc, m) => acc + m.currentPills, 0);
  }, [medications]);

  return (
    <div
      dir="rtl"
      className="min-h-screen bg-slate-900 text-slate-800 flex items-center justify-center p-0 md:p-6 font-['Cairo',sans-serif] selection:bg-teal-200"
    >
      {/* Container simulating an Android Device Frame on desktop, fluid on mobile */}
      <div
        className={`w-full bg-slate-100 flex flex-col transition-all duration-300 relative ${
          isPhoneFrame
            ? 'max-w-md h-[100dvh] md:h-[860px] md:max-h-[92vh] md:rounded-[42px] md:border-8 md:border-slate-800 md:shadow-2xl overflow-hidden'
            : 'max-w-4xl min-h-screen md:min-h-[90vh] md:rounded-3xl md:border md:border-slate-300 md:shadow-xl overflow-hidden'
        }`}
      >
        {/* Android Native Status Bar */}
        <AndroidStatusBar />

        {/* Dynamic App Header with Settings Button */}
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
          onOpenAddModal={() => {
            setEditingMedication(null);
            setIsAddModalOpen(true);
          }}
        />

        {/* Content Area - Renders based on activeTab */}
        <main className="flex-1 overflow-y-auto pb-24 relative">
          {/* TAB 1: STOCK & MEDICATIONS */}
          {activeTab === 'stock' && (
            <div>
              {/* -------------------------------------------------------- */}
              {/* FILTER 1: "جميع الأدوية" (ALL MEDICATIONS)               */}
              {/* Comprehensive overview of full inventory & auto-deduction */}
              {/* -------------------------------------------------------- */}
              {filter === 'all' && (
                <div>
                  {/* Automated Daily Deduction Banner */}
                  <div className="mx-4 mt-3 p-3 bg-teal-50 border border-teal-200/90 rounded-2xl flex items-center justify-between text-xs shadow-2xs">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-xl bg-teal-600 text-white flex items-center justify-center shrink-0">
                        <Zap className="w-4 h-4" />
                      </div>
                      <div>
                        <span className="font-bold text-teal-950 block text-[11px]">
                          الخصم التلقائي اليومي نشط
                        </span>
                        <p className="text-[10px] text-teal-800">
                          يتم احتساب الجرعات بمرور الأيام لتحديث رصيدك وموعد النفاد بدقة.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setActiveTab('logs')}
                      className="text-[11px] font-bold text-teal-700 hover:text-teal-900 bg-teal-100/70 px-2.5 py-1 rounded-lg shrink-0 transition"
                    >
                      عرض السجل
                    </button>
                  </div>

                  {/* General Inventory Stats Overview */}
                  <div className="mx-4 mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-2xs">
                      <span className="text-[10px] text-slate-500 block">إجمالي الأدوية</span>
                      <span className="text-base font-extrabold font-mono text-slate-800">
                        {medications.length}
                      </span>
                    </div>
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-2xs">
                      <span className="text-[10px] text-slate-500 block">المخزون الكلي</span>
                      <span className="text-base font-extrabold font-mono text-teal-800">
                        {totalPillsCount} <span className="text-[10px] font-normal text-slate-500">قرص</span>
                      </span>
                    </div>
                    <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-2xs">
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

              {/* -------------------------------------------------------- */}
              {/* FILTER 2: "قارب على النفاد" (ALERTS ONLY)                */}
              {/* Action-driven urgent restocking header with 1-click CTA   */}
              {/* -------------------------------------------------------- */}
              {filter === 'alerts' && (
                <div className="mx-4 mt-3 p-3.5 bg-rose-50/80 border border-rose-200 rounded-2xl flex items-center justify-between gap-3 shadow-2xs">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                      <AlertCircle className="w-5 h-5 animate-pulse" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-rose-950">
                        {alertsCount > 0
                          ? `${alertsCount} أدوية تحتاج لإعادة الشراء فوراً`
                          : 'لا توجد نواقص في أدويتك حالياً'}
                      </h4>
                      <p className="text-[11px] text-rose-800 mt-0.5 leading-relaxed">
                        وصلت إلى حد التنبيه أو نفدت. جهّز طلب الشراء لإرساله للصيدلية عبر واتساب.
                      </p>
                    </div>
                  </div>

                  {alertsCount > 0 && (
                    <button
                      onClick={() => setActiveTab('shopping')}
                      className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition active:scale-95 shrink-0 shadow-xs"
                    >
                      <ShoppingCart className="w-3.5 h-3.5" />
                      <span>قائمة الشراء</span>
                    </button>
                  )}
                </div>
              )}

              {/* -------------------------------------------------------- */}
              {/* FILTER 3: "المخزون الكافي" (SUFFICIENT ONLY)             */}
              {/* Peace of mind, coverage duration & longevity view        */}
              {/* -------------------------------------------------------- */}
              {filter === 'sufficient' && (
                <div className="mx-4 mt-3 p-3.5 bg-emerald-50/80 border border-emerald-200 rounded-2xl flex items-center justify-between gap-3 shadow-2xs">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                      <ShieldCheck className="w-5 h-5 text-emerald-600" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-emerald-950">
                        {sufficientCount} أدوية بمخزون آمن وكافٍ
                      </h4>
                      <p className="text-[11px] text-emerald-800 mt-0.5 leading-relaxed">
                        إجمالي الحبوب المتوفرة {sufficientPillsCount} قرص — جميع هذه الأدوية تكفيك لأكثر من أسبوع.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Medication Cards List - Specialized per filter */}
              <div className="p-4 space-y-3">
                {filteredMedications.length === 0 ? (
                  <EmptyState
                    hasSearch={Boolean(searchQuery)}
                    onClearSearch={() => setSearchQuery('')}
                    filter={filter}
                    onFilterChange={(f) => setFilter(f)}
                    onOpenAddModal={() => {
                      setEditingMedication(null);
                      setIsAddModalOpen(true);
                    }}
                  />
                ) : (
                  filteredMedications.map((med) => (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      viewFilter={filter}
                      onOpenRefill={(m) => setRefillMedication(m)}
                      onEdit={(m) => {
                        setEditingMedication(m);
                        setIsAddModalOpen(true);
                      }}
                      onDelete={handleDeleteMedication}
                      onToggleAutoDeduct={handleToggleAutoDeduct}
                      onNavigateToShopping={() => setActiveTab('shopping')}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {/* TAB 2: PHARMACY & SHOPPING CHECKLIST */}
          {activeTab === 'shopping' && (
            <PharmacyShoppingView
              medications={medications}
              settings={pharmacySettings}
              onUpdateSettings={handleSavePharmacySettings}
              onOpenSettings={() => setIsSettingsModalOpen(true)}
              onConfirmRefill={handleConfirmRefill}
              showToast={showToast}
            />
          )}

          {/* TAB 3: CONSUMPTION LOGS & DAILY TIMELINE */}
          {activeTab === 'logs' && (
            <ConsumptionLogView
              medications={medications}
              logs={logs}
              onAddLog={(newLog) => setLogs((prev) => [newLog, ...prev])}
              onSimulateDaysPassed={handleSimulateDaysPassed}
              onRestoreDose={handleRestoreDose}
              showToast={showToast}
            />
          )}
        </main>

        {/* Android Material Floating Action Button (FAB) for adding medications */}
        {activeTab === 'stock' && (
          <AndroidFab
            onOpenAddModal={() => {
              setEditingMedication(null);
              setIsAddModalOpen(true);
            }}
            onClick={() => {
              setEditingMedication(null);
              setIsAddModalOpen(true);
            }}
          />
        )}

        {/* Android Bottom Navigation Bar */}
        <AndroidBottomNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          alertsCount={alertsCount}
        />

        {/* Android Bottom System Pill Bar */}
        <AndroidNavBar />

        {/* Toast / SnackBar Component */}
        {toast && (
          <div className="absolute bottom-20 left-4 right-4 z-50 animate-in slide-in-from-bottom duration-200">
            <div className="bg-slate-900 text-white px-4 py-3 rounded-2xl shadow-xl border border-slate-700/60 flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{toast.message}</span>
              </div>
            </div>
          </div>
        )}

        {/* Add/Edit Medication Modal */}
        <AddMedicationModal
          isOpen={isAddModalOpen}
          onClose={() => {
            setIsAddModalOpen(false);
            setEditingMedication(null);
          }}
          onSave={handleSaveMedication}
          initialData={editingMedication}
        />

        {/* Refill Stock Modal */}
        <RefillModal
          isOpen={Boolean(refillMedication)}
          medication={refillMedication}
          onClose={() => setRefillMedication(null)}
          onConfirmRefill={handleConfirmRefill}
        />

        {/* Pharmacy & WhatsApp Settings Modal */}
        <PharmacySettingsModal
          isOpen={isSettingsModalOpen}
          onClose={() => setIsSettingsModalOpen(false)}
          settings={pharmacySettings}
          medications={medications}
          onSaveSettings={handleSavePharmacySettings}
        />
      </div>
    </div>
  );
}
