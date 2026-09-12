import { type FC } from 'react';

type ToggleColor = 'teal' | 'rose';
type ToggleSize = 'sm' | 'md';

interface ToggleProps {
  id?: string;
  checked: boolean;
  onChange: () => void;
  /** Accessible label (screen-reader text). */
  label: string;
  /** Track color when on. Defaults to 'teal'. */
  color?: ToggleColor;
  /** Toggle size: 'sm' (w-10 h-5) or 'md' (w-11 h-6). Defaults to 'sm'. */
  size?: ToggleSize;
  /** Disable the toggle. */
  disabled?: boolean;
}

/**
 * Reusable toggle switch (audit issue #81).
 *
 * Replaces 5 copy-pasted toggle-button implementations across
 * AppSettingsModal (4x) and AddMedicationModal (1x). All instances now
 * share `role="switch"` + `aria-checked` for proper a11y (the
 * AppSettingsModal variants previously only had `aria-label`).
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
  const onColor = color === 'rose' ? 'bg-rose-600' : 'bg-teal-600';
  const trackSize = size === 'md' ? 'w-11 h-6' : 'w-10 h-5';
  const knobSize = size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  const knobOn = 'right-0.5';
  const knobOff = size === 'md' ? 'right-[22px]' : 'right-[18px]';

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`${trackSize} rounded-full relative transition shrink-0 ${
        checked ? onColor : 'bg-slate-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`absolute top-0.5 ${knobSize} bg-white rounded-full shadow-sm transition ${
          checked ? knobOn : knobOff
        }`}
      />
    </button>
  );
};
