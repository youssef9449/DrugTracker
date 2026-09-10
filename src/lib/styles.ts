/**
 * Shared Tailwind class strings (audit issue #86).
 *
 * These exact class strings were copy-pasted across multiple components.
 * Centralizing them as named constants makes intent clear and ensures a
 * single edit point when the design system changes.
 *
 * Usage:
 *   import { ICON_BUTTON_CLASS, EMPTY_STATE_ICON_BOX, AUTO_DEDUCT_PAUSED_NOTE } from '../lib/styles';
 *   <button className={ICON_BUTTON_CLASS}>...</button>
 */

/** Small icon button used in AppHeader (settings, phone-frame toggle, font toggle). */
export const ICON_BUTTON_CLASS =
  'p-2 rounded-xl text-teal-100 hover:text-white hover:bg-teal-700/80 transition active:scale-95';

/** Teal icon box centered above empty-state messages (EmptyState component). */
export const EMPTY_STATE_ICON_BOX =
  'w-14 h-14 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center mb-3';

/**
 * Amber "auto-deduct paused" note box shown on MedicationCard across all
 * three view branches (alerts / sufficient / all).
 */
export const AUTO_DEDUCT_PAUSED_NOTE =
  'mt-2 text-[11px] bg-amber-50 text-amber-800 p-2 rounded-lg flex items-center gap-1.5 border border-amber-200';
