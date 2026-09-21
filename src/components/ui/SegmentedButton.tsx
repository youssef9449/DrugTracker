import type { FC } from 'react';
import { Check, type LucideIcon } from 'lucide-react';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedButtonProps<T extends string = string> {
  id?: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  showCheckmark?: boolean;
  'aria-label'?: string;
}

/**
 * Material Design 3 (M3) Segmented Button component.
 *
 * Specifications based on Material 3 Design Guidelines:
 * - Shape: Medium 12dp container, not a pill.
 * - Container: Outlined with the M3 outline-variant role.
 * - Selected Segment: Secondary container tonal fill (teal-100) with on-secondary-container text (teal-950),
 *   accompanied by an M3 leading checkmark icon.
 * - Unselected Segment: Transparent surface with on-surface-variant text and hover/active states.
 * - Dividers: 1px vertical divider between unselected adjacent segments.
 * - Accessibility: WAI-ARIA role="radiogroup" and role="radio" with aria-checked.
 */
export const SegmentedButton = <T extends string = string>({
  id,
  options,
  value,
  onChange,
  size = 'sm',
  className = '',
  showCheckmark = true,
  'aria-label': ariaLabel,
}: SegmentedButtonProps<T>): ReturnType<FC> => {
  const isSm = size === 'sm';

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex items-stretch rounded-xl border border-slate-400 bg-white overflow-hidden select-none shrink-0 ${
        isSm ? 'h-10' : 'h-10'
      } ${className}`}
    >
      {options.map((option) => {
        const isSelected = option.value === value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => {
              if (!isSelected) onChange(option.value);
            }}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-full border-l border-slate-400 last:border-l-0 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600/30 cursor-pointer ${
              isSm ? 'px-3 text-xs' : 'px-4 text-sm'
            } ${
              isSelected
                ? 'bg-teal-100 text-teal-950 font-medium'
                : 'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200 font-medium'
            }`}
          >
            {isSelected && showCheckmark && (
              <Check
                className={`${w-4 h-4} text-teal-800 stroke-[2.5] shrink-0 animate-in fade-in zoom-in-75 duration-150`}
                aria-hidden="true"
              />
            )}
            {!isSelected && Icon && (
              <Icon
                className={`${isSm ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-slate-500 shrink-0`}
                aria-hidden="true"
              />
            )}
            <span className="whitespace-nowrap">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
};
