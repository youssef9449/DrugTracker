import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LowStockBanner } from '../../src/components/LowStockBanner';
import { MedicationWithStatus } from '../../src/types';

describe('LowStockBanner (Material 3 Design)', () => {
  it('renders safe state when there are no low stock medications', () => {
    const onNavigate = vi.fn();
    render(
      <LowStockBanner
        medicationsWithStatus={[]}
        onNavigateToShopping={onNavigate}
      />
    );

    expect(screen.getByText('المخزون في أمان')).toBeInTheDocument();
  });

  it('renders compact M3 urgent banner and navigates to shopping', () => {
    const onNavigate = vi.fn();
    const mockMeds: MedicationWithStatus[] = [
      {
        med: {
          id: 'med-1',
          name: 'بنادول',
          currentPills: 0,
          dailyDose: 2,
          unit: 'قرص',
          warningThresholdDays: 5,
          colorTag: 'rose',
          createdAt: '2024-01-01T00:00:00.000Z',
          lastSyncDate: '2024-01-01',
          autoDeductEnabled: true,
          reminderEnabled: false,
        },
        statusInfo: {
          status: 'out_of_stock',
          daysLeft: 0,
          depletionDate: new Date(),
          isLow: true,
        },
      },
    ];

    render(
      <LowStockBanner
        medicationsWithStatus={mockMeds}
        onNavigateToShopping={onNavigate}
      />
    );

    expect(screen.getByText('1 دواء نفد مخزونه بالكامل')).toBeInTheDocument();
    const shoppingBtn = screen.getByRole('button', { name: /قائمة الشراء/i });
    expect(shoppingBtn).toBeInTheDocument();

    fireEvent.click(shoppingBtn);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
