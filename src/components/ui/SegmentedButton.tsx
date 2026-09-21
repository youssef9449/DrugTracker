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
 * - Shape: Fully-rounded pill container (rounded-full).
 * - Container: Outlined with 1px border (outline-variant).
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
      className={`inline-flex items-center rounded-full border border-slate-300/90 bg-white/50 overflow-hidden divide-x divide-x-reverse divide-slate-200 select-none shrink-0 ${
        isSm ? 'h-[30px]' : 'h-9'
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
            className={`flex-1 inline-flex items-center justify-center gap-1.5 h-full transition-all duration-200 cursor-pointer ${
              isSm ? 'px-2.5 text-[11px]' : 'px-3.5 text-xs'
            } ${
              isSelected
                ? 'bg-teal-100 text-teal-950 font-bold shadow-2xs'
                : 'bg-transparent text-slate-600 hover:bg-slate-100/80 active:bg-slate-200/60 font-medium'
            }`}
          >
            {isSelected && showCheckmark && (
              <Check
                className={`${isSm ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-teal-800 stroke-[2.5] shrink-0 animate-in fade-in zoom-in-75 duration-150`}
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
