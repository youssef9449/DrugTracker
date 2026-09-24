/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCallback } from 'react';
import type { Medication, PharmacySettings } from '@/types';
import { usePharmacyShoppingWhatsApp } from '@/hooks/usePharmacyShoppingWhatsApp';
import type { OrderItem } from '@/utils/whatsapp';
import * as whatsapp from '@/utils/whatsapp';

vi.mock('@/utils/whatsapp', async () => {
  const actual = await vi.importActual<typeof import('@/utils/whatsapp')>('@/utils/whatsapp');
  return {
    ...actual,
    generatePharmacyOrderMessage: vi.fn(actual.generatePharmacyOrderMessage),
  };
});

const generateSpy = vi.mocked(whatsapp.generatePharmacyOrderMessage);

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-1',
    name: 'Aspirin',
    currentPills: 10,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    packageSize: 30,
    doseSchedule: [{ id: 'd1', amount: 1, time: '08:00' }],
    ...overrides,
  };
}

const baseSettings: PharmacySettings = {
  defaultDurationDays: 30,
  pharmacies: [
    {
      id: 'ph-1',
      name: 'Test Pharmacy',
      phone: '01000000000',
      customerCode: 'C-1',
    },
  ],
  selectedPharmacyId: 'ph-1',
  whatsappContacts: [],
  whatsappAddresses: [],
  selectedWhatsappContactIds: [],
  selectedWhatsappAddressIds: [],
};

const stableOrderItems: OrderItem[] = [
  {
    name: 'Aspirin',
    quantity: 30,
    unit: 'قرص',
    packageSize: 30,
  },
];

describe('Pharmacy shopping order message memoization (#550)', () => {
  beforeEach(() => {
    generateSpy.mockClear();
  });

  it('does not recompute WhatsApp message on unrelated rerender when shopping inputs are stable', () => {
    const medications = [makeMed()];

    const { result, rerender } = renderHook(
      ({ noise, durationDays }) => {
        void noise;
        // Stable callback identities across unrelated noise rerenders —
        // mirrors useCallback-wrapped helpers in usePharmacyShoppingModel.
        const durationCb = useCallback(
          (_med: Medication) => durationDays,
          [durationDays]
        );
        const breakdownCb = useCallback(
          (_med: Medication, _suggested: number) => [
            { unit: 'strips' as const, quantity: 3 },
          ],
          []
        );

        return usePharmacyShoppingWhatsApp({
          medications,
          activeOrderItems: stableOrderItems,
          quantityModes: {},
          customOrderQuantities: {},
          orderUnits: {},
          getDurationDays: durationCb,
          getOrderBreakdown: breakdownCb,
          settings: baseSettings,
          onUpdateSettings: vi.fn(),
          showToast: vi.fn(),
        });
      },
      { initialProps: { noise: 0, durationDays: 30 as 30 | 60 } }
    );

    const firstMessage = result.current.currentWhatsAppMessage;
    expect(firstMessage).toBeTruthy();
    const callsAfterFirst = generateSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    rerender({ noise: 1, durationDays: 30 });

    expect(result.current.currentWhatsAppMessage).toBe(firstMessage);
    expect(generateSpy.mock.calls.length).toBe(callsAfterFirst);
  });

  it('recomputes WhatsApp message when a genuine input (duration) changes', () => {
    const medications = [makeMed()];

    const { result, rerender } = renderHook(
      ({ durationDays }) => {
        const durationCb = useCallback(
          (_med: Medication) => durationDays,
          [durationDays]
        );
        const breakdownCb = useCallback(
          (_med: Medication, _suggested: number) => [
            { unit: 'strips' as const, quantity: 3 },
          ],
          []
        );

        // Empty activeOrderItems → duration drives derived order items.
        return usePharmacyShoppingWhatsApp({
          medications,
          activeOrderItems: [],
          quantityModes: {},
          customOrderQuantities: {},
          orderUnits: {},
          getDurationDays: durationCb,
          getOrderBreakdown: breakdownCb,
          settings: baseSettings,
          onUpdateSettings: vi.fn(),
          showToast: vi.fn(),
        });
      },
      { initialProps: { durationDays: 30 as 30 | 60 } }
    );

    const firstMessage = result.current.currentWhatsAppMessage;
    const callsAfterFirst = generateSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    rerender({ durationDays: 60 });

    expect(generateSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(result.current.currentWhatsAppMessage).toBeDefined();
    void firstMessage;
  });
});
