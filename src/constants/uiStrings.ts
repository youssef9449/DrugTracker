/**
 * Central Arabic UI string table.
 *
 * Collects the hardcoded Arabic strings that were scattered across
 * components. Switching to English or fixing a typo previously meant
 * hunting across files; now there's a single edit point.
 *
 * Note: header titles/subtitles are in `HEADER_BY_TAB` in AppHeader.tsx
 * and tab labels are in `TABS` in AndroidBottomNav.tsx — those are
 * co-located with their icons/classes (Wave 9 #84/#83) and stay there.
 * The strings here are the ones NOT bundled with icon/class config.
 */
/** Toast messages shown in response to user actions. */
export const TOAST_MESSAGES = {
  // Dose actions
  doseTaken: (name: string, amount: number, unit: string) =>
    `تم تسجيل جرعة "${name}" (-${amount} ${unit}).`,
  doseAlreadyTaken: (name: string) =>
    `تم تناول جرعة "${name}" اليوم بالفعل.`,
  // Refill actions
  refillUndone: (name: string) => `تم التراجع عن تعبئة "${name}".`,
  autoDeductOff: (name: string) =>
    `الخصم التلقائي متوقف لدواء "${name}"؛ لا توجد جرعة مستحقة للاسترجاع.`,
  doseAlreadyRestored: (name: string) =>
    `تم استرجاع جرعة "${name}" اليوم بالفعل.`,
  // Critical-stock toggle
  criticalAlertsOn: 'تم تفعيل تنبيهات النفاذ الحرج (إشعار فوري عند اقتراب نفاد أي دواء أو نفاذه — حسب إعداد كل دواء)',
  criticalAlertsOff: 'تم إيقاف تنبيهات النفاذ الحرج',
  // Notification permission outcomes
  notificationsOn:
    'تم تفعيل تذكيرات مواعيد الجرعات',
  notificationsPermissionDenied:
    'تعذّر الحصول على إذن الإشعارات — يرجى السماح بالإشعارات من إعدادات الجهاز ثم إعادة المحاولة',
  notificationsOff: 'تم إيقاف تذكيرات مواعيد الجرعات',
  // Test notification
  testNotificationSent: 'تم إرسال إشعار تجريبي وتشغيل صوت التنبيه بنجاح!',
  // Auto-deduct
  autoDeductSummary: (totalPills: number) =>
    `تم الخصم التلقائي للاستهلاك: خصم ${totalPills} قرص لمواعيد الجرعات المستحقة.`,
  // Font scale
  fontScaledUp: 'تم تكبير حجم الخط',
  fontScaledDown: 'تم إرجاع حجم الخط للطبيعي',
  // Shopping duration
  duration60: 'تم التبديل لتغطية شهرين',
  duration30: 'تم التبديل لتغطية شهر',
  // Dose snooze
  doseSnoozed: (name: string) => `تم تأجيل تنبيه "${name}" عشر دقائق`,
} as const;
/** Persistence failure messages (used by usePersistentEffect). */
export const PERSIST_FAILURE_MESSAGES = {
  meds: 'قد لا يتم حفظ تعديلاتك على الأدوية.',
  logs: 'قد لا يتم حفظ سجل الاستهلاك.',
  pharmacy: 'قد لا يتم حفظ إعدادات الصيدلية.',
  sound: 'قد لا يتم حفظ تفضيل الصوت.',
  notifications: 'قد لا يتم حفظ تفضيل التنبيهات.',
  critical: 'قد لا يتم حفظ تفضيل تنبيه النفاذ الحرج.',
  autoDeduct: 'قد لا يتم حفظ تفضيل الخصم التلقائي.',
} as const;

/**
 * Storage/save failure messages that preserve the original failure reason.
 * The raw reason is intentionally included so a device-specific/native
 * failure can be identified from the toast instead of being collapsed into
 * the generic "تعذّر حفظ البيانات" message.
 */
export const STORAGE_ERRORS = {
  quotaExceeded: 'مساحة التخزين ممتلئة',
  generic: 'تعذّر حفظ البيانات',
  medicationSave: (reason?: string) => {
    const value = reason?.trim();
    if (!value || value === 'persist_failed') return 'تعذّر حفظ بيانات الدواء.';
    if (value === 'native_invalidation_failed' || value.includes('invalidate_recurrence')) {
      return `تعذّر حفظ الدواء: فشل إلغاء جدولة الخصم التلقائي القديم. السبب: ${value}`;
    }
    if (value.includes('dose_reminder') || value.includes('reminder_invalidation')) {
      return `تعذّر حفظ الدواء: فشل تحديث تذكيرات الجرعات. السبب: ${value}`;
    }
    if (
      value.includes('foreground_stock') ||
      value.includes('stock_') ||
      value.includes('invalid_stock') ||
      value === 'invalid_mutation_seq'
    ) {
      return `تعذّر حفظ الدواء: فشل حفظ مخزون الدواء على الجهاز. السبب: ${value}`;
    }
    if (value === 'exact_reconciliation_blocked' || value === 'native_list_failed') {
      return `تعذّر حفظ الدواء: فشلت مزامنة حالة الخصم التلقائي قبل الحفظ. السبب: ${value}`;
    }
    return `تعذّر حفظ الدواء. السبب: ${value}`;
  },
} as const;