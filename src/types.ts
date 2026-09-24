/**
 * User-visible medication activity log (STORAGE_LOGS_KEY).
 *
 * Retention (#507): bounded to CONSUMPTION_LOG_RETENTION_DAYS (see
 * pruneDoseConsumption.ts). Pruning is centralized and applied at the
 * durable meds+logs commit boundary; crash/recovery evidence (envelopes,
 * mutation ordering, native FIRED events) is NOT pruned here.
 */
export interface ConsumptionLog {
  id: string;
  medicationId: string;
  medicationName: string;
  type: 'exact_auto' | 'refill' | 'refill_undo' | 'manual_adjust' | 'skipped_day' | 'dose_taken';
  amount: number; // positive or negative
  date: string; // YYYY-MM-DD
  timestamp: string;
  description: string;
  /** Set when this refill has already been reversed. Older logs may omit it. */
  reversedAt?: string;
  /** Links a refill_undo log to the original refill log. */
  relatedLogId?: string;
  /**
   * Stable MedicationDose.id when this log is for a specific dose slot
   * Stable MedicationDose.id. Older dose_taken logs may omit it.
   */
  doseId?: string;
}
export interface Medication {
  id: string;
  name: string;
  /**
   * Durable application-facing live stock balance.
   * On Android, the value is mirrored from the Auto-owned Native stock
   * authority, which can mutate while the WebView is unavailable. UI and
   * status use this value directly; there is no second projected/effective
   * balance. Exact Auto, Manual Take/Restore, and Refill mutate this field
   * through the shared stock domain.
   */
  currentPills: number;
  dailyDose: number; // Consumption rate per day
  unit: string; // e.g., 'قرص', 'كبسولة', 'مل'
  warningThresholdDays: number; // Alert when days left <= this number (default 5)
  colorTag: string;
  category?: string;
  notes?: string;
  createdAt: string;
  autoDeductEnabled?: boolean; // Default true
  /**
   * هل الدواء لعلاج مزمن (استخدام دائم ومستمر).
   * إذا كان true، يعتمد شريط التقدم على مقياس شهري (30 يوماً).
   */
  isChronic?: boolean;
  /**
   * مدة استعمال الدواء بالأيام إذا كان محدداً (كورس علاجي).
   * يتأثر شريط التقدم بهذه المدة.
   */
  durationDays?: number;
  /** Local YYYY-MM-DD date on which a temporary treatment course starts. */
  treatmentStartDate?: string;
  packageSize?: number; // Size of standard package when bought (e.g. 30)
  stripsPerBox?: number; // عدد الأشرطة في العلبة (مثال: 3 أشرطة)
  pillsPerStrip?: number; // عدد الأقراص في الشريط الواحد (مثال: 10 أقراص)
  targetOrderQuantity?: number; // Custom target order quantity specified for pharmacy order
  reminderEnabled?: boolean; // هل تم تفعيل تذكير الجرعات لهذا الدواء
  reminderTime?: string; // وقت التذكير القديم/المساعد (صيغة 24 ساعة)
  /**
   * Per-medication critical-stock notification preference.
   * undefined keeps the existing behavior when the global master switch is enabled.
   */
  criticalStockAlertsEnabled?: boolean;
  /**
   * Number of individual dose events per day.
   * When present, should equal doseSchedule.length.
   */
  dosesPerDay?: number;
  /**
   * Explicit per-dose schedule rows — sole source of future dose occurrence
   * identity, amount, and time.
   */
  doseSchedule?: MedicationDose[];
  /**
   * YYYY-MM-DD of the last day the user manually consumed a dose.
   * Single-dose: when this equals today, auto-deduction and
   * reminders for the med are suppressed for today.
   * Multi-dose: UI badge when ALL of today's schedule
   * slots are consumed. Per-slot authority is
   * {@link doseConsumptionHistory}.
   */
  lastConsumedDate?: string;
  /**
   * Per-dose consumption history: doseId → YYYY-MM-DD dates (append-only).
   * Source of truth for whether a dose occurrence was consumed on a date.
   * Retention (#507): bounded to DOSE_HISTORY_RETENTION_DAYS (see
   * pruneDoseConsumption.ts); runtime correctness only needs today's
   * markers, so older dates are pruned deterministically at mutation time.
   */
  doseConsumptionHistory?: Record<string, string[]>;
  /**
   * Per-dose skip/restore history: doseId → YYYY-MM-DD dates on which
   * that slot was restored after auto-deduct (or after manual consume).
   * Skipped slots are not auto-due again for that date and remain
   * available for a later manual Take (idempotent Auto-Deduct → Restore).
   * Retention (#507): same bounded window as doseConsumptionHistory.
   */
  doseSkippedHistory?: Record<string, string[]>;
}
/** One individual dose event within a day (multi-dose model). */
export interface MedicationDose {
  id: string;
  /** Amount taken at this dose event (must be > 0). */
  amount: number;
  /** Local time of the dose in 24-hour HH:mm. */
  time: string;
  /** Optional clarification / instruction for this dose (e.g. "بعد الإفطار", "قبل النوم"). */
  description?: string;
}
// ─────────────────────────────────────────────────────────────────────
// Critical-stock notification claim (the ONE business state model).
// For each medication, during one continuous Critical/Out-of-Stock
// episode, the user receives AT MOST ONE critical-stock notification.
// This tiny persistent record answers exactly one question:
//     "Has this medication's current critical episode already claimed
//      its critical notification?"
// Episode semantics:
//   - Sufficient → Critical/OutOfStock starts an episode.
//   - Critical → Critical / → OutOfStock is the SAME episode (a day
//     passing, auto-deduction, manual consumption, refills-while-
//     critical, app restarts and moving projections never start a new
//     one).
//   - Critical → Sufficient ends it. The Critical Stock policy identifies
//     the episode boundary; the foreground coordinator persists the cleared
//     claim so a later critical episode gets a fresh notification opportunity.
// `claimed === true` means the episode's single notification
// opportunity has been consumed:
//   - `alarmTime: number` — a native one-shot alarm was successfully
//     scheduled at that epoch ms. While alarmTime is in the future the
//     alarm provably has NOT fired yet; once it is in the past the
//     opportunity is consumed regardless of whether Android physically
//     displayed it (the app deliberately does NOT reconstruct delivery
//     state after the fact).
//   - `alarmTime: null` — the foreground fallback sent the notification
//     directly.
// A failed schedule or a failed foreground send leaves
// `claimed === false`, so the remaining path (scheduled alarm or
// foreground fallback) stays available. Disabling notifications never
// consumes the opportunity: while disabled nothing is sent and nothing
// is marked claimed.
// ─────────────────────────────────────────────────────────────────────
export interface CriticalNotificationClaim {
  /**
   * True once this episode's notification opportunity has been taken:
   * a future alarm was scheduled natively, or the foreground sent the
   * notification. Business dedup state — NOT proof that a native alarm
   * still exists (the scheduler verifies/re-arms actual native alarms
   * against the platform; a lost alarm opens the claim again).
   */
  claimed: boolean;
  /**
   * Fire time (epoch ms) recorded by the last successful native
   * schedule, or null when the claim came from a foreground send. Purely
   * informational bookkeeping — it lets callers distinguish "a future
   * alarm was scheduled here" from "already sent / window passed". It is
   * never treated as evidence that the alarm is still armed or that
   * anything was delivered.
   */
  alarmTime: number | null;
}
/**
 * The user-configured stock notification threshold (in days).
 * This is the ONLY threshold. There is no derived "critical" sub-threshold.
 * The user sets `warningThresholdDays` from the Medication Card, and that
 * value is used directly:
 *   daysLeft >  warningThresholdDays  → 'sufficient' (no notification)
 *   daysLeft <= warningThresholdDays  → 'critical'   (ONE notification)
 *   effPills  <= 0                    → 'out_of_stock' (ONE notification)
 * A single state transition (sufficient→critical, or sufficient→out_of_stock)
 * produces exactly ONE notification. The same critical state persisting
 * across app restarts / re-renders / days does NOT produce duplicates.
 */
export interface Pharmacy {
  id: string;
  name: string;
  phone: string;
  customerCode: string;
}
export interface UserContact {
  id: string;
  label: string;
  phone: string;
}
export interface UserAddress {
  id: string;
  label: string;
  address: string;
}
export interface PharmacySettings {
  defaultDurationDays: 30 | 60;
  pharmacies: Pharmacy[];
  selectedPharmacyId: string;
  whatsappContacts: UserContact[];
  whatsappAddresses: UserAddress[];
  selectedWhatsappContactIds?: string[];
  selectedWhatsappAddressIds?: string[];
}
export const DEFAULT_PHARMACY_SETTINGS: PharmacySettings = {
  defaultDurationDays: 30,
  pharmacies: [],
  selectedPharmacyId: '',
  whatsappContacts: [],
  whatsappAddresses: [],
  selectedWhatsappContactIds: [],
  selectedWhatsappAddressIds: [],
};
export type MedicationStatus = 'out_of_stock' | 'critical' | 'warning' | 'sufficient';
export interface MedicationStatusInfo {
  daysLeft: number;
  status: MedicationStatus;
}
export interface MedicationWithStatus {
  med: Medication;
  statusInfo: MedicationStatusInfo;
}