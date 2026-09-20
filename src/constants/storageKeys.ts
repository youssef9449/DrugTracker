/**
 * localStorage key names used by the app.
 *
 * MEDS and LOGS are re-exported from autoDeductionStockGate so the
 * durable stock gate and App always share the same string values.
 */

export {
  STORAGE_MEDS_KEY,
  STORAGE_LOGS_KEY,
  STORAGE_GLOBAL_AUTO_DEDUCT_KEY,
} from '../utils/autoDeductionStockGate';

export const STORAGE_AUTO_DEDUCT_PROMPTED_KEY = 'android_med_tracker_auto_deduct_prompted_v1';
export const STORAGE_PHARMACY_KEY = 'android_med_tracker_pharmacy_v2';
export const SOUND_KEY = 'android_med_tracker_sound_v1';
export const NOTIFICATIONS_KEY = 'android_med_tracker_notifications_v1';
/** Font size preference: 'normal' | 'large'. */
export const FONT_SIZE_KEY = 'android_med_tracker_font_size_v1';
/**
 * Critical-stock alerts toggle.
 * Default: false (disabled until the user explicitly enables it on first run).
 * When a value is already saved, that explicit user choice is restored.
 * Threshold itself is derived per-medication via getCriticalThresholdDays().
 */
export const CRITICAL_STOCK_ALERTS_KEY = 'android_med_tracker_critical_alerts_v1';
/** Compact card view preference for "All Medications" tab. */
export const COMPACT_VIEW_KEY = 'android_med_tracker_compact_view_v1';
