/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MedicationMenu } from '@/components/MedicationMenu';
import { isMedicationAutoDeductActive } from '@/utils/doseSchedule';
import type { Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';

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
    lastSyncDate: getTodayDateString(),
    autoDeductEnabled: true,
    ...overrides,
  };
}

function renderMenu(
  med: Medication,
  globalAutoDeductEnabled: boolean,
  onToggleAutoDeduct = vi.fn()
) {
  const isAutoActive = isMedicationAutoDeductActive(med, globalAutoDeductEnabled);
  render(
    <MedicationMenu
      medication={med}
      isAutoActive={isAutoActive}
      globalAutoDeductEnabled={globalAutoDeductEnabled}
      onEdit={() => {}}
      onDelete={() => {}}
      onToggleAutoDeduct={onToggleAutoDeduct}
    />
  );
  return { isAutoActive, onToggleAutoDeduct };
}

function autoToggleButton() {
  // Matches Global-ON labels and Global-OFF preference labels.
  return screen.getByRole('button', {
    name: /الخصم التلقائي/,
  });
}

afterEach(() => {
  cleanup();
});

describe('MedicationMenu — per-med Auto-Deduct vs Global (UI-11)', () => {
  it('Global ON + preference ON: pressed, effective ON, classic ON label', () => {
    const med = makeMed({ autoDeductEnabled: true });
    const { isAutoActive } = renderMenu(med, true);
    expect(isAutoActive).toBe(true);

    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('data-auto-pref', 'on');
    expect(btn).toHaveAttribute('data-auto-effective', 'on');
    expect(btn).toHaveAttribute('data-global-auto', 'on');
    expect(btn).toHaveAttribute('aria-label', 'إيقاف الخصم التلقائي');
    expect(btn).toHaveAttribute(
      'title',
      'الخصم التلقائي مفعّل — اضغط للإيقاف'
    );
  });

  it('Global ON + preference OFF: not pressed, effective OFF, classic OFF label', () => {
    const med = makeMed({ autoDeductEnabled: false });
    const { isAutoActive } = renderMenu(med, true);
    expect(isAutoActive).toBe(false);

    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('data-auto-pref', 'off');
    expect(btn).toHaveAttribute('data-auto-effective', 'off');
    expect(btn).toHaveAttribute('aria-label', 'تفعيل الخصم التلقائي');
    expect(btn).toHaveAttribute(
      'title',
      'الخصم التلقائي متوقف — اضغط للتفعيل'
    );
  });

  it('Global OFF + preference ON: aria-pressed true, effective OFF, global-paused copy', () => {
    const med = makeMed({ autoDeductEnabled: true });
    const { isAutoActive } = renderMenu(med, false);
    expect(isAutoActive).toBe(false);

    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('data-auto-pref', 'on');
    expect(btn).toHaveAttribute('data-auto-effective', 'off');
    expect(btn).toHaveAttribute('data-global-auto', 'off');
    expect(btn.getAttribute('title')).toMatch(/مفعّل/);
    expect(btn.getAttribute('title')).toMatch(/متوقف عالميًا/);
    // Must not claim that pressing will turn effective deduction on.
    expect(btn.getAttribute('title')).not.toMatch(/اضغط للتفعيل/);
    expect(btn.getAttribute('aria-label')).toMatch(/متوقف عالميًا/);
    expect(btn.getAttribute('aria-label')).not.toBe('تفعيل الخصم التلقائي');
  });

  it('Global OFF + preference OFF: aria-pressed false, effective OFF, global-paused copy', () => {
    const med = makeMed({ autoDeductEnabled: false });
    const { isAutoActive } = renderMenu(med, false);
    expect(isAutoActive).toBe(false);

    const btn = autoToggleButton();
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('data-auto-pref', 'off');
    expect(btn).toHaveAttribute('data-auto-effective', 'off');
    expect(btn.getAttribute('title')).toMatch(/غير مفعّل/);
    expect(btn.getAttribute('title')).toMatch(/متوقف عالميًا/);
  });

  it('Global OFF + click toggles preference only; does not enable Global or effective', () => {
    const med = makeMed({ autoDeductEnabled: true });
    const onToggle = vi.fn();
    const { isAutoActive } = renderMenu(med, false, onToggle);
    expect(isAutoActive).toBe(false);

    fireEvent.click(autoToggleButton());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('med-1');
    // Handler is the only side effect — no global toggle prop/callback invoked.
    // Effective state for the same inputs remains OFF (production helper).
    expect(isMedicationAutoDeductActive(med, false)).toBe(false);
  });
});
