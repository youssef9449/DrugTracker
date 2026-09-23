/**
 * Shared Tailwind class strings.
 *
 * These exact class strings were copy-pasted across multiple components.
 * Centralizing them as named constants makes intent clear and ensures a
 * single edit point when the design system changes.
 *
 * Usage:
 *   import { ICON_BUTTON_CLASS, EMPTY_STATE_ICON_BOX, AUTO_DEDUCT_PAUSED_NOTE } from '../lib/styles';
 *   <button className={ICON_BUTTON_CLASS}>...</button>
 */
/**
 * Shared Tailwind class strings and Material Design 3 (M3) design tokens.
 *
 * Centralizing them as named constants makes intent clear and ensures a
 * single edit point across the application.
 */
/** Standard M3 circular icon button used in AppHeader and headers (40x40 touch target). */
export const ICON_BUTTON_CLASS =
  'w-10 h-10 rounded-full flex items-center justify-center text-teal-100 hover:text-white hover:bg-teal-700/80 active:bg-teal-900/60 transition-colors active:scale-95 cursor-pointer select-none';
/** M3 Standard Surface Icon Button (for light backgrounds). */
export const ICON_BUTTON_SURFACE =
  'w-9 h-9 rounded-full flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-slate-100 active:bg-slate-200 transition-colors active:scale-95 cursor-pointer select-none';
/** M3 Filled Button (High emphasis, rounded-full, primary fill, on-primary text). */
export const M3_BUTTON_FILLED =
  'h-10 px-5 rounded-full bg-teal-700 hover:bg-teal-800 active:bg-teal-900 text-white font-medium text-xs sm:text-sm flex items-center justify-center gap-2 transition-all active:scale-98 shadow-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
/** M3 Tonal Button (Medium emphasis, rounded-full, secondary-container fill, on-secondary-container text). */
export const M3_BUTTON_TONAL =
  'h-10 px-5 rounded-full bg-teal-100 hover:bg-teal-200/80 active:bg-teal-200 text-teal-950 font-medium text-xs sm:text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
/** M3 Outlined Button (Medium-low emphasis, 1px border, transparent fill). */
export const M3_BUTTON_OUTLINED =
  'h-10 px-5 rounded-full bg-transparent hover:bg-teal-50/60 active:bg-teal-100/60 text-teal-800 border border-teal-300 font-medium text-xs sm:text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';
/** M3 Text Button (Low emphasis, no border, transparent fill). */
export const M3_BUTTON_TEXT =
  'h-9 px-4 rounded-full bg-transparent hover:bg-slate-100 active:bg-slate-200 text-teal-800 font-medium text-xs sm:text-sm flex items-center justify-center gap-1.5 transition-colors cursor-pointer';
/** M3 Elevated Card (16dp rounded corners, elevation 1 shadow, subtle outline-variant border). */
export const M3_CARD_ELEVATED =
  'bg-white rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-shadow p-4 relative overflow-hidden';
/** M3 Outlined Card (16dp rounded corners, 1px outline-variant, flat). */
export const M3_CARD_OUTLINED =
  'bg-white rounded-2xl border border-slate-300/90 p-4 relative overflow-hidden';
/** M3 Outlined Input Field (Rounded 12dp, 1px border, clear focus ring). */
export const M3_INPUT_OUTLINED =
  'w-full px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-500/20 transition-all';
/** M3 Filter Chip (8dp rounded corner, 32dp height, leading icon when selected). */
export const M3_FILTER_CHIP =
  'h-8 px-3 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 active:scale-95 border cursor-pointer select-none';
/** M3 Dialog Surface (28dp rounded corners, elevation 3). */
export const M3_DIALOG_SURFACE =
  'w-full max-w-sm sm:max-w-md bg-white rounded-[28px] shadow-2xl overflow-hidden border border-slate-100';
/** M3 Bottom Sheet Surface (28dp top corners on mobile, 28dp all on desktop). */
export const M3_BOTTOM_SHEET_SURFACE =
  'w-full sm:max-w-md bg-white rounded-t-[28px] sm:rounded-[28px] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col';
/** M3 Drag Handle for bottom sheets (32x4dp pill). */
export const M3_DRAG_HANDLE =
  'w-8 h-1 rounded-full bg-slate-300 mx-auto my-2.5 shrink-0';
/** Teal icon box centered above empty-state messages (EmptyState component). */
export const EMPTY_STATE_ICON_BOX =
  'w-16 h-16 rounded-2xl bg-teal-100 text-teal-800 flex items-center justify-center mb-3 shadow-xs';
/**
 * Amber "auto-deduct paused" note box shown on MedicationCard across all
 * three view branches (alerts / sufficient / all).
 */
export const AUTO_DEDUCT_PAUSED_NOTE =
  'mt-2 text-xs bg-amber-50 text-amber-900 p-2.5 rounded-xl flex items-center gap-2 border border-amber-200/90';