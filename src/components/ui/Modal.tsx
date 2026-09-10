import {
  type FC,
  type ReactNode,
  useEffect,
  useRef,
  useCallback,
} from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Accessible name for the dialog (aria-label). */
  label: string;
  children: ReactNode;
  /**
   * Overlay layout. Defaults to 'sheet' (bottom-sheet on mobile, centered
   * on desktop — the common AddMedication/AppSettings/Refill pattern).
   * 'center' is always centered (DoseAlarmModal pattern).
   */
  variant?: 'sheet' | 'center';
  /** Close when the backdrop is clicked. Defaults to false (match existing behavior). */
  closeOnBackdropClick?: boolean;
}

// Selectors for all focusable element types, for the focus trap.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable modal wrapper (audit issue #67).
 *
 * Provides the overlay + the a11y/keyboard contract that all 5 modals in
 * the app were missing:
 *   - role="dialog" + aria-modal="true"
 *   - ESC key closes
 *   - Focus trap: Tab cycles within the modal (keyboard users can't Tab
 *     out into the underlying page)
 *   - Focus restoration: focus returns to the element that had focus
 *     before the modal opened (the trigger button) on close
 *
 * The panel content is passed as children.
 */
export const Modal: FC<ModalProps> = ({
  isOpen,
  onClose,
  label,
  children,
  variant = 'sheet',
  closeOnBackdropClick = false,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Trap focus + handle ESC. Runs only while open.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => !el.hasAttribute('hidden') && el.style.display !== 'none');
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    // Capture the element that had focus before the modal opened, so we
    // can restore it on close.
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    document.addEventListener('keydown', handleKeyDown);
    // Move focus into the dialog. Defer one tick so the dialog's inputs
    // have rendered (some modals early-return null before children mount).
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const firstFocusable = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        // No focusable child — focus the dialog itself so screen readers
        // land inside it.
        dialog.focus();
      }
    }, 0);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(focusTimer);
      // Restore focus to the trigger on close.
      previouslyFocusedRef.current?.focus();
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const overlayClass =
    variant === 'center'
      ? 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs'
      : 'fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs';

  return (
    <div
      className={overlayClass}
      onClick={(e) => {
        if (closeOnBackdropClick && e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="outline-none"
      >
        {children}
      </div>
    </div>
  );
};
