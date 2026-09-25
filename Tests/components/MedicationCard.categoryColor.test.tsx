/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MedicationCard } from '@/components/MedicationCard';
import type { Medication } from '@/types';

const baseMed: Medication = {
  id: 'med-test-cat',
  name: 'جلوكوفاج 500 مجم',
  currentPills: 30,
  dailyDose: 2,
  unit: 'قرص',
  warningThresholdDays: 5,
  colorTag: 'rose',
  category: 'السكري',
  notes: 'بعد الأكل',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('MedicationCard — Category Badge Color matching colorTag', () => {
  afterEach(() => cleanup());

  it('renders category badge with rose theme when colorTag is rose', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, colorTag: 'rose', category: 'السكري' }}
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const badge = screen.getByText('السكري');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-rose-50');
    expect(badge).toHaveClass('text-rose-800');
    expect(badge).toHaveClass('border-rose-200/80');
  });

  it('renders category badge with amber theme when colorTag is amber', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, colorTag: 'amber', category: 'فيتامينات' }}
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const badge = screen.getByText('فيتامينات');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-amber-50');
    expect(badge).toHaveClass('text-amber-900');
    expect(badge).toHaveClass('border-amber-200/80');
  });

  it('renders category badge with sky theme when colorTag is sky', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, colorTag: 'sky', category: 'حساسية' }}
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const badge = screen.getByText('حساسية');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-sky-50');
    expect(badge).toHaveClass('text-sky-800');
    expect(badge).toHaveClass('border-sky-200/80');
  });

  it('renders category badge with violet theme when colorTag is violet', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, colorTag: 'violet', category: 'أعصاب' }}
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const badge = screen.getByText('أعصاب');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-violet-50');
    expect(badge).toHaveClass('text-violet-800');
    expect(badge).toHaveClass('border-violet-200/80');
  });

  it('defaults to teal theme when colorTag is teal or unspecified', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, colorTag: 'teal', category: 'ضغط الدم' }}
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const badge = screen.getByText('ضغط الدم');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-teal-50');
    expect(badge).toHaveClass('text-teal-800');
    expect(badge).toHaveClass('border-teal-200/80');
  });

  it('renders matching category color in alerts and sufficient views as well', () => {
    // Alerts view
    const { unmount } = render(
      <MedicationCard
        medication={{ ...baseMed, currentPills: 1, colorTag: 'rose', category: 'السكري' }}
        viewFilter="alerts"
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    let badge = screen.getByText('السكري');
    expect(badge).toHaveClass('bg-rose-50');
    expect(badge).toHaveClass('text-rose-800');

    unmount();

    // Sufficient view
    render(
      <MedicationCard
        medication={{ ...baseMed, currentPills: 100, colorTag: 'rose', category: 'السكري' }}
        viewFilter="sufficient"
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    badge = screen.getByText('السكري');
    expect(badge).toHaveClass('bg-rose-50');
    expect(badge).toHaveClass('text-rose-800');
  });

  it('renders medication name on its own full-width line in compact view, with category in row 2', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, colorTag: 'sky', category: 'السكري' }}
        isCompact={true}
        viewFilter="all"
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent(baseMed.name);
    // Current layout: the name is a truncating flex-1 element on its own
    // header row; the category badge renders in a separate row below it.
    expect(heading).toHaveClass('truncate');

    const badge = screen.getByText('السكري');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveClass('bg-sky-50');
    expect(badge).toHaveClass('text-sky-800');
    expect(heading.parentElement!).not.toContainElement(badge);
  });

  it('renders medication name on its own line in alerts view with badges below it and simplified refill button', () => {
    render(
      <MedicationCard
        // currentPills 0 → out_of_stock (daysLeft 0 with stock left is
        // 'critical' under the current status model, not 'نفد').
        medication={{ ...baseMed, currentPills: 0, colorTag: 'rose', category: 'السكري' }}
        viewFilter="alerts"
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent(baseMed.name);
    expect(heading).toHaveClass('truncate');
    const badge = screen.getByText('السكري');
    expect(heading.parentElement!).not.toContainElement(badge);
    expect(screen.getAllByText('نفد المخزون بالكامل').length).toBeGreaterThan(0);
    expect(badge).toBeInTheDocument();

    // Refill button has "تعبئة رصيد" only without (+ علبة)
    const refillBtn = screen.getByRole('button', { name: /تعبئة رصيد/i });
    expect(refillBtn).toBeInTheDocument();
    expect(refillBtn).toHaveTextContent('تعبئة رصيد');
    expect(refillBtn).not.toHaveTextContent('علبة');
  });

  it('renders medication name on its own line in sufficient view with badges below it', () => {
    render(
      <MedicationCard
        medication={{ ...baseMed, currentPills: 100, colorTag: 'teal', category: 'السكري' }}
        viewFilter="sufficient"
        onOpenRefill={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onToggleAutoDeduct={vi.fn()}
      />
    );

    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent(baseMed.name);
    expect(heading).toHaveClass('truncate');
    const badge = screen.getByText('السكري');
    expect(heading.parentElement!).not.toContainElement(badge);
    expect(screen.getByText('مخزون آمن ومريح')).toBeInTheDocument();
    expect(badge).toBeInTheDocument();
  });
});
