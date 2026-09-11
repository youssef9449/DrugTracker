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
 * paints an explicit white background in BOTH states, overlaying a teal
 * checkmark (✔) when checked. The background therefore never changes
 * color — only the checkmark appears/disappears.
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
      className="peer appearance-none w-4 h-4 rounded border border-slate-300 bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50 disabled:cursor-not-allowed"
    />
    {/* Teal checkmark — shown only when checked. Background stays white. */}
    <svg
      className="pointer-events-none absolute w-3 h-3 text-teal-600 opacity-0 peer-checked:opacity-100 transition-opacity"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 6L5 8.5L9.5 3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  </span>
);
