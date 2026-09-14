/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ConsumptionLogView } from '@/components/ConsumptionLogView';
import type { Medication, ConsumptionLog } from '@/types';

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
    lastSyncDate: '2024-01-01',
    autoDeductEnabled: true,
    ...overrides,
  };
}

function makeLog(overrides: Partial<ConsumptionLog> = {}): ConsumptionLog {
  return {
    id: 'log-1',
    medicationId: 'med-a',
    medicationName: 'Med A',
    type: 'auto_daily',
    amount: -1,
    date: '2024-01-02',
    timestamp: '2024-01-02T08:00:00.000Z',
    description: 'خصم تلقائي لليوم',
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('ConsumptionLogView', () => {
  it('renders the remaining consumption-log UI without the removed restore controls', () => {
    render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={[]}
        onRestoreDose={() => true}
        showToast={() => {}}
      />
    );

    expect(screen.getByText('سجل الاستهلاك التلقائي')).toBeInTheDocument();
    expect(screen.getByText('إجمالي جرعاتك الشهرية')).toBeInTheDocument();
    expect(screen.getByText('سجل العمليات والمزامنة الأخيرة:')).toBeInTheDocument();

    expect(screen.queryByText(/لم تتناول جرعتك اليوم/)).not.toBeInTheDocument();
    expect(screen.queryByText(/إعادة الجرعة المخصومة للمخزون/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('اختر الدواء')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('اختر الجرعة')).not.toBeInTheDocument();
  });

  it('shows the correct monthly dose estimate for active auto-deduct medications', () => {
    render(
      <ConsumptionLogView
        medications={[
          makeMed('med-a', 'Med A', { dailyDose: 2, autoDeductEnabled: true }),
          makeMed('med-b', 'Med B', { dailyDose: 1, autoDeductEnabled: true }),
          makeMed('med-c', 'Med C', { dailyDose: 3, autoDeductEnabled: false }),
        ]}
        logs={[]}
        onRestoreDose={() => true}
        showToast={() => {}}
      />
    );

    // Each active medication contributes one daily dose event, not dailyDose pills.
    expect(screen.getByText('60')).toBeInTheDocument();
  });

  it('renders an empty-state when there are no consumption logs', () => {
    render(
      <ConsumptionLogView
        medications={[makeMed('med-a', 'Med A')]}
        logs={[]}
        onRestoreDose={() => true}
        showToast={() => {}}
      />
    );

    expect(
      screen.getByText('لا توجد سجلات بعد، ستظهر هنا حركات الخصم التلقائي والتعبئة.')
    ).toBeInTheDocument();
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
        onRestoreDose={() => true}
        showToast={() => {}}
      />
    );

    expect(screen.getByText('Med A')).toBeInTheDocument();
    expect(screen.getByText('خصم تلقائي لليوم')).toBeInTheDocument();
    expect(screen.getByText('تمت التعبئة')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
    expect(screen.getByText('+30')).toBeInTheDocument();
  });
});
