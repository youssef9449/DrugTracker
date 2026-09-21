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

/** M3-aligned circular icon button: 40dp touch target, 24dp icon slot. */
export const ICON_BUTTON_CLASS =
  'w-10 h-10 rounded-full flex items-center justify-center text-slate-700 hover:bg-slate-100 active:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 transition-colors cursor-pointer';

/** M3-aligned text/icon action button metrics shared by compact actions. */
export const M3_TEXT_BUTTON_CLASS =
  'min-h-10 rounded-full px-4 inline-flex items-center justify-center gap-2 text-sm font-medium text-teal-800 hover:bg-teal-50 active:bg-teal-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600/30 transition-colors cursor-pointer';

/** M3 shape/elevation tokens expressed as Tailwind utilities for this web implementation. */
export const M3_SURFACE_CARD_CLASS =
  'rounded-xl border border-slate-200 bg-white shadow-xs';

export const M3_MENU_CLASS =
  'rounded-sm border-0 bg-white shadow-lg';

/** Teal icon box centered above empty-state messages (EmptyState component). */
export const EMPTY_STATE_ICON_BOX =
  'w-14 h-14 rounded-2xl bg-teal-50 text-teal-600 flex items-center justify-center mb-3';

/**
 * Amber "auto-deduct paused" note box shown on MedicationCard across all
 * three view branches (alerts / sufficient / all).
 */
export const AUTO_DEDUCT_PAUSED_NOTE =
  'mt-2 text-[11px] bg-amber-50 text-amber-800 p-2 rounded-lg flex items-center gap-1.5 border border-amber-200';
