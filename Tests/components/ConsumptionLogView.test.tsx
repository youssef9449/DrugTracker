/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ConsumptionLogView } from '@/components/ConsumptionLogView';
import type { Medication, ConsumptionLog, MedicationDose } from '@/types';

function makeMed(id: string, name: string, overrides: Partial<Medication> = {}): Medication {
  return {
    id,
    name,
    currentPills: 30,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    autoDeductEnabled: true,
    ...overrides,
  };
}

function makeDose(id: string, amount: number, time: string): MedicationDose {
  return { id, amount, time };
}

function makeLog(overrides: Partial<ConsumptionLog> = {}): ConsumptionLog {
  return {
    id: 'log-1',
    medicationId: 'med-a',
    medicationName: 'Med A',
    type: 'exact_auto',
    amount: -1,
    date: '2024-01-02',
    timestamp: '2024-01-02T08:00:00.000Z',
    description: 'خصم تلقائي لليوم',
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('ConsumptionLogView', () => {
  it('renders dose-occurrence copy without legacy sync / day-diff wording', () => {
    render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={[]}
        showToast={() => {}}
      />
    );

    expect(screen.getByText('سجل الاستهلاك')).toBeInTheDocument();
    expect(screen.getByText('متابعة جرعاتك المسجلة وحركات المخزون')).toBeInTheDocument();
    // Initial scheduleMode is monthly — only that heading is shown.
    expect(screen.getByText('الجرعات المجدولة شهرياً')).toBeInTheDocument();
    expect(screen.queryByText('الجرعات المجدولة يومياً')).not.toBeInTheDocument();
    // SegmentedButton labels
    expect(screen.getByText('الجرعة الشهرية')).toBeInTheDocument();
    expect(screen.getByText('الجرعة اليومية')).toBeInTheDocument();
    expect(screen.getByText('سجل العمليات:')).toBeInTheDocument();

    // Switch to daily mode — heading updates; no-schedule med still shows 0.
    fireEvent.click(screen.getByText('الجرعة اليومية'));
    expect(screen.getByText('الجرعات المجدولة يومياً')).toBeInTheDocument();
    expect(screen.queryByText('الجرعات المجدولة شهرياً')).not.toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();

    // Removed / legacy phrases must not appear
    expect(screen.queryByText('تاريخ آخر مزامنة')).not.toBeInTheDocument();
    expect(screen.queryByText(/فرق الأيام/)).not.toBeInTheDocument();
    expect(screen.queryByText(/منذ آخر تحديث/)).not.toBeInTheDocument();
    expect(screen.queryByText(/المزامنة اليومية/)).not.toBeInTheDocument();
    expect(screen.queryByText(/عبر مرور الأيام/)).not.toBeInTheDocument();
    expect(screen.queryByText('سجل الاستهلاك التلقائي')).not.toBeInTheDocument();
    expect(screen.queryByText('إجمالي جرعاتك الشهرية')).not.toBeInTheDocument();

    // Restore controls stay removed from this view
    expect(screen.queryByText(/لم تتناول جرعتك اليوم/)).not.toBeInTheDocument();
    expect(screen.queryByText(/إعادة الجرعة المخصومة للمخزون/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('اختر الدواء')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('اختر الجرعة')).not.toBeInTheDocument();
  });

  it('no-schedule medication contributes 0 daily slots (no dailyDose synthetic)', () => {
    render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A', { dailyDose: 2, autoDeductEnabled: true })]}
        logs={[]}
        showToast={() => {}}
      />
    );
    // Missing doseSchedule → 0 slots/day → 0 monthly
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('explicit single-slot schedule counts as one daily slot (×30 monthly)', () => {
    render(
      <ConsumptionLogView
        medications={[
          makeMed('med-a', 'Med A', {
            dailyDose: 2,
            autoDeductEnabled: true,
            doseSchedule: [makeDose('d1', 2, '09:00')],
            dosesPerDay: 1,
          }),
        ]}
        logs={[]}
        showToast={() => {}}
      />
    );
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('counts multi-dose doseSchedule length as daily slots', () => {
    const schedule = [
      makeDose('d1', 1, '08:00'),
      makeDose('d2', 1, '14:00'),
      makeDose('d3', 1, '21:00'),
    ];
    render(
      <ConsumptionLogView
        medications={[
          makeMed('med-a', 'Med A', {
            dailyDose: 3,
            doseSchedule: schedule,
            dosesPerDay: 3,
            autoDeductEnabled: true,
          }),
        ]}
        logs={[]}
        showToast={() => {}}
      />
    );
    // 3 slots/day × 30 = 90
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('sums explicit single-slot + multi-dose slots and excludes autoDeductEnabled === false', () => {
    const multi = [
      makeDose('d1', 1, '08:00'),
      makeDose('d2', 1, '14:00'),
      makeDose('d3', 1, '21:00'),
    ];
    render(
      <ConsumptionLogView
        medications={[
          makeMed('med-a', 'Med A', {
            dailyDose: 1,
            autoDeductEnabled: true,
            doseSchedule: [makeDose('s1', 1, '08:00')],
            dosesPerDay: 1,
          }),
          makeMed('med-b', 'Med B', {
            dailyDose: 3,
            doseSchedule: multi,
            dosesPerDay: 3,
            autoDeductEnabled: true,
          }),
          makeMed('med-c', 'Med C', {
            dailyDose: 2,
            doseSchedule: [makeDose('x', 1, '09:00'), makeDose('y', 1, '21:00')],
            dosesPerDay: 2,
            autoDeductEnabled: false,
          }),
        ]}
        logs={[]}
        showToast={() => {}}
      />
    );
    // 1 + 3 = 4 daily slots → 120 monthly; disabled med contributes 0
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders the updated empty-state copy', () => {
    render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={[]}
        showToast={() => {}}
      />
    );

    expect(
      screen.getByText('لا توجد سجلات بعد، ستظهر هنا عمليات الخصم والتعبئة والتغييرات على المخزون.')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('لا توجد سجلات بعد، ستظهر هنا حركات الخصم التلقائي والتعبئة.')
    ).not.toBeInTheDocument();
  });

  it('renders consumption log entries with medication, description, amount, and date', () => {
    render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={[
          makeLog(),
          makeLog({
            id: 'log-2',
            amount: 30,
            type: 'refill',
            description: 'تمت التعبئة',
          }),
        ]}
        showToast={() => {}}
      />
    );

    expect(screen.getAllByText('Med A')).toHaveLength(2);
    expect(screen.getByText('خصم تلقائي لليوم')).toBeInTheDocument();
    expect(screen.getByText('تمت التعبئة')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('+30')).toBeInTheDocument();
  });
});
