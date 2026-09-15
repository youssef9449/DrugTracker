import { type FC } from 'react';

export type ToggleColor = 'teal' | 'rose' | 'amber';
export type ToggleSize = 'sm' | 'md';

export interface ToggleProps {
  id?: string;
  checked: boolean;
  onChange: () => void;
  /** Accessible label (screen-reader text). */
  label: string;
  /** Track color when on. Defaults to 'teal'. */
  color?: ToggleColor;
  /** Toggle size: 'sm' or 'md'. Defaults to 'sm'. */
  size?: ToggleSize;
  /** Disable the toggle. */
  disabled?: boolean;
}

/**
 * Material Design 3 style Toggle Switch component.
 *
 * Implements M3 switch geometry and styling:
 * - Unchecked: neutral outline track with a centered, smaller handle (slate-500).
 * - Checked: solid primary track (teal/rose/amber) with an expanded white handle with shadow.
 * - Compliant with WAI-ARIA role="switch" and aria-checked for full accessibility.
 */
export const Toggle: FC<ToggleProps> = ({
  id,
  checked,
  onChange,
  label,
  color = 'teal',
  size = 'sm',
  disabled = false,
}) => {
  const onColor =
    color === 'rose'
      ? 'bg-rose-600 border-rose-600'
      : color === 'amber'
      ? 'bg-amber-500 border-amber-500'
      : 'bg-teal-600 border-teal-600';

  // M3 switch dimensions:
  // md: 48px width x 28px height; sm: 40px width x 24px height
  const trackSize = size === 'md' ? 'w-12 h-7' : 'w-10 h-6';

  // Handle dimensions:
  // Checked handle expands in M3; unchecked handle is smaller and neutral.
  const knobSize =
    size === 'md'
      ? checked
        ? 'w-5 h-5 bg-white shadow-md'
        : 'w-3.5 h-3.5 bg-slate-500'
      : checked
      ? 'w-4 h-4 bg-white shadow-sm'
      : 'w-2.5 h-2.5 bg-slate-500';

  // Knob offsets for RTL positioning
  const knobPos =
    size === 'md'
      ? checked
        ? 'right-1 top-0.5'
        : 'right-[27px] top-1.5'
      : checked
      ? 'right-0.5 top-0.5'
      : 'right-[23px] top-1.5';

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-pressed={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`${trackSize} rounded-full relative transition-all duration-200 ease-in-out shrink-0 border-2 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/50 ${
        checked ? onColor : 'bg-slate-200 border-slate-400/80'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute ${knobSize} rounded-full transition-all duration-200 ease-in-out ${knobPos}`}
      />
    </button>
  );
};
