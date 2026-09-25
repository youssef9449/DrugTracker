/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MedicationMenu } from '@/components/MedicationMenu';
import { isMedicationAutoDeductActive } from '@/utils/doseSchedule';
import type { Medication } from '@/types';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Test Med',
    currentPills: 20,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...overrides,
  };
}

function renderMenu(med: Medication, onToggleAutoDeduct = vi.fn()) {
  const isAutoActive = isMedicationAutoDeductActive(med);
  render(
    <MedicationMenu
      medication={med}
      isAutoActive={isAutoActive}
      onEdit={() => {}}
      onDelete={() => {}}
      onToggleAutoDeduct={onToggleAutoDeduct}
    />
  );
  return { isAutoActive, onToggleAutoDeduct };
}

function autoToggleButton() {
  return screen.getByRole('button', { name: /الخصم التلقائي/ });
}

afterEach(() => {
  cleanup();
});

describe('MedicationMenu — medication preference vs Global kill switch', () => {
  it('preference ON: pressed, effective ON', () => {
    const med = makeMed({ autoDeductEnabled: true });
    const { isAutoActive } = renderMenu(med);
    expect(isAutoActive).toBe(true);
    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('data-auto-pref', 'on');
    expect(btn).toHaveAttribute('data-auto-effective', 'on');
    expect(btn).toHaveAttribute('aria-label', 'إيقاف الخصم التلقائي لهذا الدواء');
  });

  it('Global OFF: per-med preference stays pressed while effective Auto is OFF', () => {
    const med = makeMed({ autoDeductEnabled: true });
    render(
      <MedicationMenu
        medication={med}
        isAutoActive={false}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggleAutoDeduct={() => {}}
      />
    );
    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('data-auto-pref', 'on');
    expect(btn).toHaveAttribute('data-auto-effective', 'off');
    expect(btn).toHaveAttribute('aria-label', 'إيقاف الخصم التلقائي لهذا الدواء');
    expect(btn).toHaveAttribute(
      'title',
      'إعداد الخصم التلقائي لهذا الدواء مفعّل، لكن المفتاح العام متوقف — اضغط لتغيير إعداد الدواء'
    );
  });

  it('preference OFF: not pressed, effective OFF', () => {
    const med = makeMed({ autoDeductEnabled: false });
    const { isAutoActive } = renderMenu(med);
    expect(isAutoActive).toBe(false);
    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('data-auto-pref', 'off');
    expect(btn).toHaveAttribute('aria-label', 'تفعيل الخصم التلقائي لهذا الدواء');
  });

  it('click toggles preference via harness (med-level only)', () => {
    const onToggle = vi.fn();
    function Harness() {
      const [med, setMed] = useState(() => makeMed({ autoDeductEnabled: true }));
      const isAutoActive = isMedicationAutoDeductActive(med);
      return (
        <MedicationMenu
          medication={med}
          isAutoActive={isAutoActive}
          onEdit={() => {}}
          onDelete={() => {}}
          onToggleAutoDeduct={(id) => {
            onToggle(id);
            setMed((prev) => ({
              ...prev,
              autoDeductEnabled: prev.autoDeductEnabled === false,
            }));
          }}
        />
      );
    }
    render(<Harness />);
    expect(autoToggleButton()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(autoToggleButton());
    expect(onToggle).toHaveBeenCalledWith('med-1');
    expect(autoToggleButton()).toHaveAttribute('aria-pressed', 'false');
  });
});
