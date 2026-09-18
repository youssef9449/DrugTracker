/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SelectDoseModal } from '@/components/SelectDoseModal';
import {
  relativeDoseDayLabel,
  sortDoseSelectItems,
} from '@/utils/doseSelectDisplay';
import type { ConsumptionLog, Medication } from '@/types';
import { getTodayDateString } from '@/utils/dateCalculations';

function makeMulti(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-multi',
    name: 'Multi Med',
    currentPills: 30,
    dailyDose: 4,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    reminderEnabled: true,
    reminderTime: '08:00',
    doseSchedule: [
      { id: 'd1', amount: 2, time: '08:00' },
      { id: 'd2', amount: 1, time: '14:00' },
      { id: 'd3', amount: 1, time: '21:00' },
    ],
    dosesPerDay: 3,
    ...overrides,
  };
}

describe('relativeDoseDayLabel', () => {
  it('labels today as اليوم', () => {
    expect(relativeDoseDayLabel('2026-09-13', '2026-09-13')).toBe('اليوم');
  });

  it('labels tomorrow as غدًا', () => {
    expect(relativeDoseDayLabel('2026-09-14', '2026-09-13')).toBe('غدًا');
  });

  it('labels other days with Arabic weekday (not full long date)', () => {
    const label = relativeDoseDayLabel('2026-09-15', '2026-09-13');
    expect(label).not.toBe('اليوم');
    expect(label).not.toBe('غدًا');
    expect(label).not.toMatch(/2026/);
    expect(label.length).toBeGreaterThan(0);
  });
});

describe('sortDoseSelectItems', () => {
  it('same-day doses sort by time ascending and keep amount+id attached', () => {
    const items = sortDoseSelectItems([
      { dose: { id: 'd3', amount: 3, time: '21:00' }, eventDate: '2026-09-13' },
      { dose: { id: 'd1', amount: 2, time: '08:00' }, eventDate: '2026-09-13' },
      { dose: { id: 'd2', amount: 1, time: '14:00' }, eventDate: '2026-09-13' },
    ]);
    expect(items.map((i) => i.dose.id)).toEqual(['d1', 'd2', 'd3']);
    expect(items.map((i) => i.dose.amount)).toEqual([2, 1, 3]);
  });

  it('sorts by calendar date first, then time (not clock-only)', () => {
    const items = sortDoseSelectItems([
      { dose: { id: 'morning', amount: 1, time: '08:00' }, eventDate: '2026-09-14' },
      { dose: { id: 'night', amount: 2, time: '23:00' }, eventDate: '2026-09-13' },
      { dose: { id: 'afternoon', amount: 1, time: '14:00' }, eventDate: '2026-09-14' },
    ]);
    expect(items.map((i) => i.dose.id)).toEqual(['night', 'morning', 'afternoon']);
    expect(items.map((i) => i.eventDate)).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-14',
    ]);
  });

  it('sorting does not use Arabic display text', () => {
    const items = sortDoseSelectItems([
      { dose: { id: 'b', amount: 1, time: '09:00' }, eventDate: '2026-09-15' },
      { dose: { id: 'a', amount: 1, time: '22:00' }, eventDate: '2026-09-13' },
    ]);
    expect(items[0].dose.id).toBe('a');
    expect(items[1].dose.id).toBe('b');
  });
});

describe('SelectDoseModal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('lists doses with day + time (اليوم • Arabic time)', () => {
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/اختر الجرعة/)).toBeInTheDocument();
    const doseButtons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'));
    expect(doseButtons).toHaveLength(3);
    expect(screen.getAllByText(/اليوم/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/اليوم • 8:00 ص/)).toBeInTheDocument();
    expect(screen.getByText(/اليوم • 2:00 م/)).toBeInTheDocument();
    expect(screen.getByText(/اليوم • 9:00 م/)).toBeInTheDocument();
    expect(screen.getByText(/2 قرص/)).toBeInTheDocument();
  });

  it('orders unsorted schedule by time ascending for the same day', () => {
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti({
          doseSchedule: [
            { id: 'd3', amount: 1, time: '21:00' },
            { id: 'd1', amount: 2, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
          ],
        })}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    const ids = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-dose-id'))
      .map((b) => b.getAttribute('data-dose-id'));
    expect(ids).toEqual(['d1', 'd2', 'd3']);
  });

  it('selecting dose B passes original doseId = d2', () => {
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const b = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd2');
    fireEvent.click(b!);
    expect(onSelect).toHaveBeenCalledWith('med-multi', 'd2');
  });

  it('selecting dose A passes doseId = d1 when upcoming', () => {
    vi.setSystemTime(new Date(2026, 8, 13, 7, 0, 0));
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const a = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd1');
    expect(a).toBeEnabled();
    fireEvent.click(a!);
    expect(onSelect).toHaveBeenCalledWith('med-multi', 'd1');
  });

  it('disables past doses (time elapsed today) and marks them auto-deducted with checked checkbox', () => {
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti()}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const d1Btn = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd1');
    const d2Btn = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd2');

    expect(d1Btn).toBeDisabled();
    expect(d1Btn).toHaveTextContent('خصم تلقائي');
    fireEvent.click(d1Btn!);
    expect(onSelect).not.toHaveBeenCalled();

    expect(d2Btn).toBeEnabled();
    expect(d2Btn).toHaveTextContent('اختيار');
    fireEvent.click(d2Btn!);
    expect(onSelect).toHaveBeenCalledWith('med-multi', 'd2');
  });

  it('renders an exact auto-deduction as automatic and uses its historical amount', () => {
    const today = getTodayDateString();
    const autoLog: ConsumptionLog = {
      id: 'exact-auto:med-multi:d1:' + today,
      medicationId: 'med-multi',
      medicationName: 'Multi Med',
      type: 'auto_daily',
      amount: -2,
      date: today,
      timestamp: '2026-09-13T08:00:00.000Z',
      description: 'Exact Auto deduction',
      doseId: 'd1',
    };

    render(
      <SelectDoseModal
        isOpen
        mode="manage"
        medication={makeMulti({
          doseConsumption: { d1: today },
          doseSchedule: [
            { id: 'd1', amount: 1, time: '08:00' },
            { id: 'd2', amount: 1, time: '14:00' },
            { id: 'd3', amount: 1, time: '21:00' },
          ],
        })}
        logs={[autoLog]}
        onSelect={() => {}}
        onRestore={() => {}}
        onClose={() => {}}
      />
    );

    const d1 = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('data-dose-id') === 'd1');

    expect(d1).toHaveAttribute('data-dose-status', 'auto');
    expect(d1).toHaveTextContent('2 قرص');
    expect(d1).toHaveTextContent('الحالة: تم الخصم تلقائيًا');
    expect(d1).toHaveAttribute('data-dose-action', 'restore');
  });

  it('marks consumed doses and blocks re-selection', () => {
    const today = getTodayDateString();
    const onSelect = vi.fn();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti({ doseConsumption: { d1: today } })}
        onSelect={onSelect}
        onClose={() => {}}
      />
    );
    const a = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd1');
    expect(a).toBeDisabled();
    fireEvent.click(a!);
    expect(onSelect).not.toHaveBeenCalled();

    const b = screen
      .getAllByRole('button')
      .find((btn) => btn.getAttribute('data-dose-id') === 'd2');
    expect(b).not.toBeDisabled();
  });

  it('shows all-consumed state when every slot is done', () => {
    const today = getTodayDateString();
    render(
      <SelectDoseModal
        isOpen
        medication={makeMulti({
          doseConsumption: { d1: today, d2: today, d3: today },
        })}
        onSelect={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/تم تناول جميع جرعات اليوم/)).toBeInTheDocument();
  });

  describe('mode=restore', () => {
    it('shows restore subtitle and enables only completed doses', () => {
      const today = getTodayDateString();
      const onSelect = vi.fn();
      // 12:00 — d1 elapsed (auto), d2/d3 still ahead
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
      render(
        <SelectDoseModal
          isOpen
          mode="restore"
          medication={makeMulti({ doseConsumption: { d2: today } })}
          onSelect={onSelect}
          onClose={() => {}}
        />
      );
      expect(screen.getByText(/اختر الجرعة المراد استرجاعها/)).toBeInTheDocument();

      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      const d2 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd2');
      const d3 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd3');

      // d1 auto-elapsed → restorable
      expect(d1).not.toBeDisabled();
      // d2 manually consumed → restorable
      expect(d2).not.toBeDisabled();
      // d3 not yet elapsed or consumed → not restorable
      expect(d3).toBeDisabled();

      fireEvent.click(d2!);
      expect(onSelect).toHaveBeenCalledWith('med-multi', 'd2');
    });

    it('disables already-restored (skipped) doses', () => {
      const today = getTodayDateString();
      // d2 still manually consumed → list is shown (not empty state).
      // d1 skipped → present with data-dose-id, real disabled, not actionable.
      render(
        <SelectDoseModal
          isOpen
          mode="restore"
          medication={makeMulti({
            doseSkippedHistory: { d1: [today] },
            doseConsumption: { d2: today },
          })}
          onSelect={() => {}}
          onClose={() => {}}
        />
      );
      const doseButtons = screen
        .getAllByRole('button')
        .filter((b) => b.getAttribute('data-dose-id'));
      const d1 = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd1');
      const d2 = doseButtons.find((b) => b.getAttribute('data-dose-id') === 'd2');
      expect(d1).toBeTruthy();
      expect(d1).toBeDisabled();
      expect(d1).toHaveTextContent(/تم الاسترجاع/);
      expect(d2).toBeTruthy();
      expect(d2).not.toBeDisabled();
    });

    it('shows empty state when nothing is restorable', () => {
      vi.setSystemTime(new Date(2026, 8, 13, 7, 0, 0)); // before all times
      render(
        <SelectDoseModal
          isOpen
          mode="restore"
          medication={makeMulti()}
          onSelect={() => {}}
          onClose={() => {}}
        />
      );
      expect(
        screen.getByText(/لا توجد جرعات قابلة للاسترجاع اليوم/)
      ).toBeInTheDocument();
    });
  });

  describe('UI-10 — Global Auto-Deduct OFF in take mode', () => {
    // Case A — Global OFF + med ON + elapsed → Take selectable, not allDone
    it('Global OFF + med ON + elapsed: Take selectable and allDone=false', () => {
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0)); // d1 elapsed
      const onSelect = vi.fn();
      render(
        <SelectDoseModal
          isOpen
          mode="take"
          globalAutoDeductEnabled={false}
          medication={makeMulti({ autoDeductEnabled: true })}
          onSelect={onSelect}
          onClose={() => {}}
        />
      );
      expect(
        screen.queryByText(/تم تناول جميع جرعات اليوم/)
      ).not.toBeInTheDocument();
      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1).toBeTruthy();
      expect(d1).not.toBeDisabled();
      expect(d1).toHaveTextContent('اختيار');
      fireEvent.click(d1!);
      expect(onSelect).toHaveBeenCalledWith('med-multi', 'd1');
    });

    // Case B — Global ON + med ON + elapsed → completed, not selectable for Take
    it('Global ON + med ON + elapsed: dose completed, not selectable for Take', () => {
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
      const onSelect = vi.fn();
      render(
        <SelectDoseModal
          isOpen
          mode="take"
          globalAutoDeductEnabled={true}
          medication={makeMulti({ autoDeductEnabled: true })}
          onSelect={onSelect}
          onClose={() => {}}
        />
      );
      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1).toBeDisabled();
      expect(d1).toHaveTextContent('خصم تلقائي');
      fireEvent.click(d1!);
      expect(onSelect).not.toHaveBeenCalled();
    });

    // Case C — Global OFF + future dose still Take selectable
    it('Global OFF + future dose: Take selectable', () => {
      vi.setSystemTime(new Date(2026, 8, 13, 7, 0, 0)); // before all times
      render(
        <SelectDoseModal
          isOpen
          mode="take"
          globalAutoDeductEnabled={false}
          medication={makeMulti({ autoDeductEnabled: true })}
          onSelect={() => {}}
          onClose={() => {}}
        />
      );
      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1).not.toBeDisabled();
      expect(d1).toHaveTextContent('اختيار');
    });

    // Case D — Global OFF does not clear manual consumed state
    it('Global OFF + manually consumed: still not selectable for Take', () => {
      const today = getTodayDateString();
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
      const onSelect = vi.fn();
      render(
        <SelectDoseModal
          isOpen
          mode="take"
          globalAutoDeductEnabled={false}
          medication={makeMulti({
            autoDeductEnabled: true,
            doseConsumption: { d1: today },
          })}
          onSelect={onSelect}
          onClose={() => {}}
        />
      );
      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1).toBeDisabled();
      fireEvent.click(d1!);
      expect(onSelect).not.toHaveBeenCalled();
    });

    // Case E — Restore mode eligibility unchanged (pure auto still restorable when Global ON)
    it('Restore mode: pure auto projection still restorable when Global ON', () => {
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
      render(
        <SelectDoseModal
          isOpen
          mode="restore"
          globalAutoDeductEnabled={true}
          medication={makeMulti({ autoDeductEnabled: true })}
          onSelect={() => {}}
          onClose={() => {}}
        />
      );
      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1).not.toBeDisabled();
    });

    it('Restore mode: Global OFF does not invent Restore for elapsed-only dose', () => {
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
      render(
        <SelectDoseModal
          isOpen
          mode="restore"
          globalAutoDeductEnabled={false}
          medication={makeMulti({ autoDeductEnabled: true })}
          onSelect={() => {}}
          onClose={() => {}}
        />
      );
      // With Global OFF, pure-auto projection is not eligible (isAutoActive=false).
      // No consumed + no evidence → nothing restorable → empty state.
      expect(
        screen.getByText(/لا توجد جرعات قابلة للاسترجاع اليوم/)
      ).toBeInTheDocument();
    });

    it('Restore mode: consumed + exact evidence still restorable under Global OFF', () => {
      const today = getTodayDateString();
      const manualLog: ConsumptionLog = {
        id: 'manual:med-multi:d1:' + today,
        medicationId: 'med-multi',
        medicationName: 'Multi Med',
        type: 'dose_taken',
        amount: -2,
        date: today,
        timestamp: '2026-09-13T08:05:00.000Z',
        description: 'Manual take',
        doseId: 'd1',
      };
      vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0));
      render(
        <SelectDoseModal
          isOpen
          mode="restore"
          globalAutoDeductEnabled={false}
          medication={makeMulti({
            autoDeductEnabled: true,
            doseConsumption: { d1: today },
          })}
          logs={[manualLog]}
          onSelect={() => {}}
          onClose={() => {}}
        />
      );
      const d1 = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-dose-id') === 'd1');
      expect(d1).toBeTruthy();
      expect(d1).not.toBeDisabled();
    });
  });
});
