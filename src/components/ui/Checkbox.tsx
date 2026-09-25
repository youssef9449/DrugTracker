import { type FC, type ChangeEvent } from 'react';

interface CheckboxProps {
  checked: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** Accessible label (screen-reader text). */
  'aria-label'?: string;
  /** Extra classes (e.g. mt-0.5). */
  className?: string;
  /** Disable the checkbox. */
  disabled?: boolean;
}

/**
 * Reusable checkbox with a guaranteed-white background.
 *
 * The native `<input type="checkbox">` renders with a dark/black
 * background when unchecked inside the Android WebView (the `accent-color`
 * CSS property only controls the checked fill, not the track background).
 * This component strips the native appearance (`appearance-none`) and
 * paints an explicit white background in BOTH states. The checkmark itself
 * is rendered as an explicit teal SVG from the React `checked` prop, with
 * inline visibility/color so Android WebView cannot fall back to native
 * checkbox rendering or lose the checkmark through utility-class state.
 *
 * Semantics are preserved: the underlying element is still a real
 * `<input type="checkbox">`, so `role="checkbox"`, `.checked`, and
 * `getByLabelText` / `getByRole('checkbox')` all keep working in tests.
 */
export const Checkbox: FC<CheckboxProps> = ({
  checked,
  onChange,
  'aria-label': ariaLabel,
  className = '',
  disabled = false,
}) => (
  <span className={`relative inline-flex items-center justify-center shrink-0 ${className}`}>
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      disabled={disabled}
      className={`appearance-none w-[18px] h-[18px] rounded-[4px] border-2 bg-white cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 transition-colors disabled:opacity-38 disabled:cursor-not-allowed ${checked ? 'border-teal-700' : 'border-slate-400'}`}
    />
    {/* Teal checkmark — shown only when React state is checked */}
    <svg
      className="pointer-events-none absolute w-3 h-3"
      style={{ opacity: checked ? 1 : 0, color: '#0f766e' }}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 6L5 8.5L9.5 3.5"
        stroke="#0f766e"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);
