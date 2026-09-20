/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RefillModal } from '@/components/RefillModal';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-liquid-1',
    name: 'شراب كحة',
    currentPills: 50,
    dailyDose: 10,
    unit: 'مل',
    packageSize: 120,
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('RefillModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows only "عبوة" and removes the "مل" chip for liquid medications', () => {
    const med = makeMed({ unit: 'مل', packageSize: 120 });
    const onConfirm = vi.fn();
    render(
      <RefillModal
        medication={med}
        isOpen={true}
        onClose={() => {}}
        onConfirmRefill={onConfirm}
      />
    );

    // Should display 'عبوة' unit button
    const bottleBtn = screen.getByRole('button', { name: /عبوة/i });
    expect(bottleBtn).toBeInTheDocument();

    // Should NOT display a unit selector button for 'مل'
    const mlUnitBtn = screen.queryByRole('button', { name: /^مل$/i });
    expect(mlUnitBtn).toBeNull();

    // Bottle capacity is displayed
    expect(screen.getByText(/سعة العبوة: 120 مل/i)).toBeInTheDocument();

    // Submitting refills by 1 bottle (120 ml)
    const submitBtn = screen.getByRole('button', { name: /تأكيد إضافة المخزون/i });
    fireEvent.click(submitBtn);
    expect(onConfirm).toHaveBeenCalledWith('med-liquid-1', 120);
  });

  it('allows pills and boxes for solid tablet medications', () => {
    const med = makeMed({
      id: 'med-solid-1',
      name: 'بنادول',
      unit: 'قرص',
      stripsPerBox: 2,
      pillsPerStrip: 10,
    });
    render(
      <RefillModal
        medication={med}
        isOpen={true}
        onClose={() => {}}
        onConfirmRefill={() => {}}
      />
    );

    // For tablets, 'قرص', 'علبة', and 'شريط' buttons should be present
    expect(screen.getByRole('button', { name: /^قرص$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^علبة$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^شريط$/i })).toBeInTheDocument();
  });
});


describe('RefillModal — quantity input allows empty mid-edit', () => {
  afterEach(() => cleanup());

  it('clearing the quantity field leaves it empty; typing 2 works', () => {
    const med = makeMed({
      currentPills: 10,
      stripsPerBox: 3,
      pillsPerStrip: 10,
      packageSize: 30,
      unit: 'قرص',
    });
    render(
      <RefillModal
        medication={med}
        isOpen={true}
        onClose={() => {}}
        onConfirmRefill={vi.fn()}
      />
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: '2' } });
    expect(input.value).toBe('2');
  });
});
