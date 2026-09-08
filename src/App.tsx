import React, { useState, useEffect, useMemo } from 'react';
import {
  Medication,
  ConsumptionLog,
  PharmacySettings,
  DEFAULT_PHARMACY_SETTINGS,
  calculateMedicationStatus,
} from './types';
// Seed data — default 3 medications + 2 consumption logs shown on fresh
// install. The file lives at src/data/initialData.ts (relative path).
// See that file's header comment for the AI Studio cache-error
// troubleshooting note.
import { INITIAL_MEDICATIONS, INITIAL_LOGS } from './data/initialData';
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
import {
  requestNotificationPermission,
  sendMedicineAlert,
  sendCriticalStockAlert,
  openNotificationSettings,
  getNotificationPermission,
  getNotificationPermissionSync,
} from './utils/notifications';
import { getTodayDateString, syncAutoDailyDeductions } from './utils/dateCalculations';
import { useDoseReminders } from './hooks/useDoseReminders';
import { initNativeBridge } from './native';
import { Zap } from 'lucide-react';

const STORAGE_MEDS_KEY = 'android_med_tracker_items_v2';
const STORAGE_LOGS_KEY = 'android_med_tracker_logs_v2';
const STORAGE_PHARMACY_KEY = 'android_med_tracker_pharmacy_v2';
const SOUND_KEY = 'android_med_tracker_sound_v1';
// Critical-stock alerts (the "متبقي حبتين فقط" notifications) — user can
// toggle this on/off from the AppHeader. Default true (enabled by
// default — this is the headline feature of the app).
const CRITICAL_STOCK_ALERTS_KEY = 'android_med_tracker_critical_alerts_v1';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('stock');

  // SSR/hydration-safe initialization: start with the deterministic default
  // values (no localStorage / window access during initial render), then
  // hydrate from localStorage in a useEffect after mount. This guarantees
  // the server-rendered HTML matches the first client render, preventing
  // React hydration mismatches in AI Studio's SSR preview environment.
  const [medications, setMedications] = useState<Medication[]>(INITIAL_MEDICATIONS);
  const [logs, setLogs] = useState<ConsumptionLog[]>(INITIAL_LOGS);
  const [pharmacySettings, setPharmacySettings] =
    useState<PharmacySettings>(DEFAULT_PHARMACY_SETTINGS);

  const [filter, setFilter] = useState<'all' | 'alerts' | 'sufficient'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [editingMedication, setEditingMedication] = useState<Medication | null>(null);
  const [refillMedication, setRefillMedication] = useState<Medication | null>(null);

  // Same SSR-safe pattern: defaults are deterministic, real state loaded on mount.
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(false);
  // Critical-stock alerts ("متبقي حبتين فقط") — default true so that
  // when the user first installs the app, they get alerts by default
  // (the headline feature). The toggle in AppHeader lets them turn it
  // off if they find it too noisy.
  const [criticalStockAlertsEnabled, setCriticalStockAlertsEnabled] = useState<boolean>(true);

  const [isPhoneFrame, setIsPhoneFrame] = useState(true);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

  const { alarmingMedication, dismissAlarm, snoozeAlarm, testAlarm } = useDoseReminders({
    medications,
    soundEnabled,
    notificationsEnabled,
  });

  // ─────────────────────────────────────────────────────────────
  // Hydration: load persisted state from localStorage AFTER mount.
  // This effect runs only on the client and replaces the default
  // values with whatever the user previously saved, if any.
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const savedMeds = localStorage.getItem(STORAGE_MEDS_KEY);
      if (savedMeds) {
        const parsed = JSON.parse(savedMeds);
        if (Array.isArray(parsed) && parsed.length > 0) setMedications(parsed);
      }
    } catch {
      // ignore
    }

    try {
      const savedLogs = localStorage.getItem(STORAGE_LOGS_KEY);
      if (savedLogs) {
        const parsed = JSON.parse(savedLogs);
        if (Array.isArray(parsed)) setLogs(parsed);
      }
    } catch {
      // ignore
    }

    try {
      const savedPharmacy = localStorage.getItem(STORAGE_PHARMACY_KEY);
      if (savedPharmacy) {
        const parsed = JSON.parse(savedPharmacy);
        if (parsed && typeof parsed === 'object') {
          setPharmacySettings({
            ...DEFAULT_PHARMACY_SETTINGS,
            ...parsed,
            customerCode: parsed.customerCode || '14739',
          });
        }
      }
    } catch {
      // ignore
    }

    try {
    setSoundEnabled(localStorage.getItem(SOUND_KEY) !== 'false');
    } catch {
      // ignore
    }

    try {
      // Critical-stock alerts default to true. We persist as
      // 'true'/'false' string. Default true means: if the user has
      // never touched the toggle, they get the alerts.
      const stored = localStorage.getItem(CRITICAL_STOCK_ALERTS_KEY);
      setCriticalStockAlertsEnabled(stored !== 'false');
    } catch {
      // ignore
    }

    // Initialize the in-app notifications flag from a SYNC snapshot
    // of the current permission state. On web this is
    // Notification.permission; on native (Capacitor), the permission
    // state is async-only, so we default to 'default' and let the
    // async getNotificationPermission() call below update it.
    //
    // Note: this is intentionally a sync snapshot — the React state
    // needs to be set during the first render so the bell icon
    // shows the correct initial state. A second pass below (the
    // async getNotificationPermission) updates it once the native
    // permission state is known.
    setNotificationsEnabled(
      getNotificationPermissionSync() === 'granted'
    );

    // Initialize the Capacitor native bridge (status bar color, back
    // button). No-op on the web — see src/native.ts.
    initNativeBridge().catch((err) => {
      console.warn('[App] Native bridge init failed:', err);
    });

    // On native (Capacitor), get the real async permission state
    // and update the in-app flag if it differs from the sync
    // snapshot above.
    getNotificationPermission()
      .then((perm) => {
        setNotificationsEnabled(perm === 'granted');
      })
      .catch((err) => {
        console.warn('[App] getNotificationPermission failed:', err);
      });

    // Auto-request notification permission on the FIRST app open
    // after install. The browser only shows the permission prompt
    // when the permission state is 'default' (user hasn't been asked
    // yet). Once the user grants or denies, the browser remembers
    // the decision and won't re-show the prompt. If the user denied
    // permission, this becomes a no-op; the bell button in
    // AppHeader then takes the user to OS settings to re-enable.
    //
    // Auto-requesting on mount is recommended by the Web Push API
    // spec because it ensures the prompt shows after the user has
    // had a chance to see the app's value (which is now true on
    // first open, since the user has just installed it).
    //
    // On Android 13+ (Capacitor), this triggers the OS
    // POST_NOTIFICATIONS permission dialog via
    // LocalNotifications.requestPermissions(). On older Android,
    // this is a no-op (notifications allowed by default).
    if (getNotificationPermissionSync() === 'default') {
      requestNotificationPermission()
        .then((granted) => {
          setNotificationsEnabled(granted);
        })
        .catch((err) => {
          console.warn('[App] Auto-request notification permission failed:', err);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  useEffect(() => {
    try {
      localStorage.setItem(
        CRITICAL_STOCK_ALERTS_KEY,
        String(criticalStockAlertsEnabled)
      );
    } catch {
      // ignore
    }
  }, [criticalStockAlertsEnabled]);

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

    // Critical-stock alerts ("متبقي حبتين فقط") — fires when a
    // medication has 2 or fewer pills left. The user can toggle this
    // off via the AppHeader. Default enabled (the headline feature).
    if (notificationsEnabled && criticalStockAlertsEnabled) {
      result.updatedMeds.forEach((med) => {
        if (med.currentPills > 0 && med.currentPills <= 2) {
          sendCriticalStockAlert(med.name, med.currentPills, med.unit || 'قرص');
        } else if (med.currentPills === 0) {
          // Fully out of stock — also send a critical alert so the
          // user is reminded to refill immediately. (The regular
          // sendMedicineAlert above also fires for status='critical',
          // but this one uses a different notification id so it
          // appears as a separate notification drawer entry.)
          sendCriticalStockAlert(med.name, 0, med.unit || 'قرص');
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
      // Current state says "off" — but check the real permission
      // because the user may have re-enabled it via OS settings.
      // Use the async getNotificationPermission() which works on
      // both web (Notification.permission) and native (Capacitor
      // LocalNotifications.checkPermissions()).
      const currentPerm = await getNotificationPermission();

      if (currentPerm === 'granted') {
        // OS settings already allow it; just turn on the in-app
        // flag.
        setNotificationsEnabled(true);
        showToast('تم تفعيل إشعارات الهاتف بنجاح');
        return;
      }

      if (currentPerm === 'denied') {
        // The browser/OS already denied permission and won't show
        // the prompt again. Open the OS settings page so the user
        // can re-enable notifications manually.
        showToast('الإشعارات مقفولة من إعدادات النظام. سيتم فتح صفحة الإعدادات الآن...');
        openNotificationSettings();
        return;
      }

      // currentPerm === 'default' — show the prompt (browser
      // Notification.requestPermission OR Capacitor
      // LocalNotifications.requestPermissions on Android 13+).
      const granted = await requestNotificationPermission();
      setNotificationsEnabled(granted);
      showToast(
        granted
          ? 'تم تفعيل إشعارات الهاتف بنجاح'
          : 'يرجى السماح بالإشعارات في إعدادات النظام'
      );
    } else {
      setNotificationsEnabled(false);
      showToast('تم إيقاف التنبيهات داخل التطبيق');
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

  // ─────────────────────────────────────────────────────────────
  // Critical-stock alerts ("متبقي حبتين فقط")
  // ─────────────────────────────────────────────────────────────
  // Watch the medications array — whenever it changes (because of
  // auto-deduction, refill, edit, manual delete, dose-taken from
  // alarm, etc.), check if any medication has crossed the 2-pill
  // threshold. We only fire the notification ONCE per medication
  // per threshold-crossing, by tracking which meds we already
  // alerted about in a ref.
  //
  // The "fire once per crossing" logic uses a Map keyed by
  // medication id, storing the LAST pill count we alerted for. If
  // the current count is <=2 but the last alerted count was >2 (or
  // we never alerted for this med), fire. If we already alerted for
  // this count, skip — the user has already seen the notification.
  //
  // When the user refills the med (pills go back up), we clear the
  // alerted tracker for that med so the next time it crosses 2 again,
  // we'll alert again.
  const lastCriticalAlertRef = React.useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // Don't run during the initial mount (the auto-deduction effect
    // above already handles initial load notifications). This guard
    // uses a ref to detect first run vs subsequent changes.
    if (!notificationsEnabled || !criticalStockAlertsEnabled) {
      // When the user disables alerts (or disables notifications
      // entirely), reset the tracker so when they re-enable, we
      // alert again for any current low-stock meds.
      lastCriticalAlertRef.current.clear();
      return;
    }

    const tracker = lastCriticalAlertRef.current;
    for (const med of medications) {
      if (med.currentPills <= 2) {
        const lastAlertedAt = tracker.get(med.id);
        if (lastAlertedAt === undefined || lastAlertedAt > med.currentPills) {
          // Either we never alerted for this med, OR the pill count
          // dropped further since last alert. Fire and remember.
          sendCriticalStockAlert(med.name, med.currentPills, med.unit || 'قرص');
          tracker.set(med.id, med.currentPills);
        }
      } else {
        // Pill count went back up (refill, restore dose, etc.) —
        // reset the tracker so we alert again the next time it
        // crosses 2.
        tracker.delete(med.id);
      }
    }
  }, [medications, notificationsEnabled, criticalStockAlertsEnabled]);

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
        {/* NOTE: AndroidStatusBar (a fake "time + wifi + battery" bar
            that was previously rendered here) was removed because the
            real OS status bar already shows that info on actual
            Android devices — the in-app fake version was redundant
            and ate vertical space. The Capacitor StatusBar plugin
            (configured in capacitor.config.ts + initialized in
            src/native.ts) sets the OS status bar color to teal-800
            and overlays the WebView when running as an APK, so the
            app's content starts directly under AppHeader. */}
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
          criticalStockAlertsEnabled={criticalStockAlertsEnabled}
          onToggleCriticalStockAlerts={() => {
            const next = !criticalStockAlertsEnabled;
            setCriticalStockAlertsEnabled(next);
            showToast(
              next
                ? 'تم تفعيل تنبيهات "حبتين بس" — هتوصلك إشعار لو في دواء متبقي فيه حبتين أو أقل'
                : 'تم إيقاف تنبيهات "حبتين بس"'
            );
          }}
          isPhoneFrame={isPhoneFrame}
          onTogglePhoneFrame={() => setIsPhoneFrame(!isPhoneFrame)}
          onOpenSettings={() => setIsSettingsModalOpen(true)}
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
                        <p className="text-[10px] text-teal-800">يتم احتساب الجرعات بمرور الأيام لتحديث رصيدك وموعد النفاذ بدقة.</p>
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
