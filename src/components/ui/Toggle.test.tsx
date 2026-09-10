/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Toggle } from './Toggle';

describe('Toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders with role="switch" and aria-checked reflecting the checked state', () => {
    const { rerender } = render(
      <Toggle checked={false} onChange={vi.fn()} label="test toggle" />
    );
    const sw = screen.getByRole('switch');
    expect(sw).toHaveAttribute('aria-checked', 'false');

    rerender(<Toggle checked={true} onChange={vi.fn()} label="test toggle" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('applies the aria-label for screen readers', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="تبديل الصوت" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-label', 'تبديل الصوت');
  });

  it('calls onChange when clicked', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="t" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('uses teal track color when checked (default)', () => {
    render(<Toggle checked={true} onChange={vi.fn()} label="t" />);
    expect(screen.getByRole('switch').className).toContain('bg-teal-600');
  });

  it('uses rose track color when checked and color="rose"', () => {
    render(<Toggle checked={true} onChange={vi.fn()} label="t" color="rose" />);
    expect(screen.getByRole('switch').className).toContain('bg-rose-600');
  });

  it('uses slate track color when unchecked', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="t" />);
    expect(screen.getByRole('switch').className).toContain('bg-slate-300');
  });

  it('renders the sm size by default (w-10 h-5)', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="t" />);
    expect(screen.getByRole('switch').className).toContain('w-10 h-5');
  });

  it('renders the md size when size="md" (w-11 h-6)', () => {
    render(<Toggle checked={false} onChange={vi.fn()} label="t" size="md" />);
    expect(screen.getByRole('switch').className).toContain('w-11 h-6');
  });

  it('disables interaction when disabled', () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="t" disabled />);
    const sw = screen.getByRole('switch');
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});
