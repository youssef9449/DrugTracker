/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * #550 — Pharmacy Shopping callback identity / memoization regression.
 *
 * Exercises the production `usePharmacyShoppingModel` hook so that unstable
 * inline wrappers for `getDurationDays` / `getOrderBreakdown` (instead of
 * `useCallback`) cause `generatePharmacyOrderMessage` to re-run on an
 * unrelated parent rerender.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Medication, PharmacySettings } from '@/types';
import { usePharmacyShoppingModel } from '@/hooks/usePharmacyShoppingModel';
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

const stableMeds: Medication[] = [makeMed()];

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
  // Explicit empty arrays keep WhatsApp memo deps referentially stable.
  whatsappContacts: [],
  whatsappAddresses: [],
  selectedWhatsappContactIds: [],
  selectedWhatsappAddressIds: [],
};

const onUpdateSettings = vi.fn();
const showToast = vi.fn();

describe('usePharmacyShoppingModel — order message memoization (#550)', () => {
  beforeEach(() => {
    generateSpy.mockClear();
    onUpdateSettings.mockClear();
    showToast.mockClear();
  });

  it('does not recompute WhatsApp message on unrelated parent rerender when shopping inputs are stable', () => {
    const { result, rerender } = renderHook(
      ({ noise, settings }) => {
        // `noise` is deliberately unused by the model — it only forces the
        // parent render function to run again while every genuine shopping
        // input stays the same reference / value.
        void noise;
        return usePharmacyShoppingModel({
          medications: stableMeds,
          settings,
          onUpdateSettings,
          showToast,
        });
      },
      {
        initialProps: {
          noise: 0,
          settings: baseSettings,
        },
      }
    );

    // Force evaluation of the memoized WhatsApp chain through the model.
    const firstMessage = result.current.currentWhatsAppMessage;
    expect(firstMessage).toBeTruthy();
    const callsAfterStable = generateSpy.mock.calls.length;
    expect(callsAfterStable).toBeGreaterThan(0);

    // Unrelated parent rerender: same meds, settings, handlers.
    rerender({ noise: 1, settings: baseSettings });

    expect(result.current.currentWhatsAppMessage).toBe(firstMessage);
    expect(generateSpy.mock.calls.length).toBe(callsAfterStable);
  });

  it('recomputes WhatsApp message when defaultDurationDays changes', () => {
    const { result, rerender } = renderHook(
      ({ settings }) =>
        usePharmacyShoppingModel({
          medications: stableMeds,
          settings,
          onUpdateSettings,
          showToast,
        }),
      {
        initialProps: { settings: baseSettings },
      }
    );

    const firstMessage = result.current.currentWhatsAppMessage;
    expect(firstMessage).toBeTruthy();
    const callsAfterFirst = generateSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Genuine dependency: default duration feeds getDurationDays → order items → message.
    rerender({
      settings: { ...baseSettings, defaultDurationDays: 60 },
    });

    expect(generateSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    expect(result.current.currentWhatsAppMessage).toBeDefined();
    void firstMessage;
  });
});
