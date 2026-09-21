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
 * - Medium 12dp corner treatment on the first/last items; middle items remain joined.
 * - Outlined segments with shared boundaries.
 * - Selected Segment: tonal fill with on-container text and an optional leading checkmark.
 * - Unselected Segment: transparent surface with on-surface-variant text and interaction states.
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
      className={`inline-flex items-stretch select-none shrink-0 ${className}`}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const Icon = option.icon;
        const isFirst = index === 0;
        const isLast = index === options.length - 1;
        const shapeClass =
          options.length === 1
            ? 'rounded-xl'
            : isFirst
              ? 'rounded-l-xl'
              : isLast
                ? 'rounded-r-xl'
                : 'rounded-none';

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => {
              if (!isSelected) onChange(option.value);
            }}
            className={`relative flex-1 inline-flex items-center justify-center gap-1.5 h-10 border border-slate-400 transition-colors duration-200 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600/30 cursor-pointer ${shapeClass} ${!isFirst ? '-ml-px' : ''} ${isSm ? 'px-3 text-xs' : 'px-4 text-sm'} ${isSelected ? 'z-[1] bg-teal-100 text-teal-950 font-medium' : 'bg-transparent text-slate-700 hover:bg-slate-100 active:bg-slate-200 font-medium'}`}
          >
            {isSelected && showCheckmark && (
              <Check
                className="w-4 h-4 text-teal-800 stroke-[2.5] shrink-0 animate-in fade-in zoom-in-75 duration-150"
                aria-hidden="true"
              />
            )}
            {!isSelected && Icon && (
              <Icon
                className="w-4 h-4 text-slate-500 shrink-0"
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
