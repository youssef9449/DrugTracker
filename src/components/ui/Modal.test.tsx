/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <Modal isOpen={false} onClose={vi.fn()} label="test">
        <button>inside</button>
      </Modal>
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders children with role="dialog" and aria-modal when open', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} label="My Dialog">
        <button>inside</button>
      </Modal>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'My Dialog');
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} label="test">
        <button>inside</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose on Escape when closed (no listener active)', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={false} onClose={onClose} label="test">
        <button>inside</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves focus into the dialog on open (first focusable element)', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} label="test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );
    // The first focusable button should receive focus (after the tick).
    // We use setTimeout to let the focus timer fire.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(document.activeElement).toBe(screen.getByText('first'));
        resolve();
      }, 10);
    });
  });

  it('restores focus to the previously-focused element on close', () => {
    const trigger = document.createElement('button');
    trigger.id = 'external-trigger';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <Modal isOpen={true} onClose={vi.fn()} label="test">
        <button>inside</button>
      </Modal>
    );

    // Close the modal — focus should return to the trigger.
    rerender(
      <Modal isOpen={false} onClose={vi.fn()} label="test">
        <button>inside</button>
      </Modal>
    );

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(document.activeElement).toBe(trigger);
        document.body.removeChild(trigger);
        resolve();
      }, 10);
    });
  });

  it('traps Tab focus within the dialog (Tab on last element wraps to first)', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} label="test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );
    const first = screen.getByText('first');
    const second = screen.getByText('second');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Focus the last element, then press Tab — should wrap to first.
        second.focus();
        expect(document.activeElement).toBe(second);
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(first);
        resolve();
      }, 10);
    });
  });

  it('traps Shift+Tab focus (Shift+Tab on first element wraps to last)', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} label="test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );
    const first = screen.getByText('first');
    const second = screen.getByText('second');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        first.focus();
        expect(document.activeElement).toBe(first);
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(second);
        resolve();
      }, 10);
    });
  });

  it('calls onClose on backdrop click when closeOnBackdropClick is true', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} label="test" closeOnBackdropClick={true}>
        <button>inside</button>
      </Modal>
    );
    // The overlay is the outer div. Click it directly.
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose on backdrop click by default', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} label="test">
        <button>inside</button>
      </Modal>
    );
    const overlay = screen.getByRole('dialog').parentElement!;
    fireEvent.click(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the center variant overlay when variant="center"', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} label="test" variant="center">
        <button>inside</button>
      </Modal>
    );
    const overlay = screen.getByRole('dialog').parentElement!;
    expect(overlay.className).toContain('bg-slate-950/70');
    expect(overlay.className).toContain('items-center');
  });

  it('uses the sheet variant overlay by default', () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} label="test">
        <button>inside</button>
      </Modal>
    );
    const overlay = screen.getByRole('dialog').parentElement!;
    expect(overlay.className).toContain('bg-slate-900/60');
    expect(overlay.className).toContain('items-end');
  });
});
