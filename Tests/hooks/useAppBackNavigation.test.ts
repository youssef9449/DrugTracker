import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppBackNavigation } from '../../src/hooks/useAppBackNavigation';

let backHandler: (() => boolean) | null = null;

vi.mock('../../src/native', () => ({
  registerBackButtonHandler: vi.fn((handler: () => boolean) => {
    backHandler = handler;
  }),
}));

describe('useAppBackNavigation', () => {
  beforeEach(() => {
    backHandler = null;
  });

  function useHarness() {
    const [activeTab, setActiveTab] = useState<import('../../src/components/AndroidBottomNav').ActiveTab>('stock');
    return {
      activeTab,
      ...useAppBackNavigation(activeTab, setActiveTab),
    };
  }

  it('restores contextual destinations before allowing app exit', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.navigateToTab('shopping'));
    act(() => result.current.navigateToTab('user-data'));

    expect(result.current.activeTab).toBe('user-data');
    expect(backHandler?.()).toBe(true);
    expect(result.current.activeTab).toBe('shopping');
    expect(backHandler?.()).toBe(true);
    expect(result.current.activeTab).toBe('stock');
    expect(backHandler?.()).toBe(false);
  });

  it('closes the highest-priority overlay before navigation history', () => {
    const { result } = renderHook(() => useHarness());
    const closeCalls: string[] = [];

    let unregisterLow: (() => void) | undefined;
    let unregisterHigh: (() => void) | undefined;

    act(() => {
      unregisterLow = result.current.registerBackOverlay(
        'overlay-low',
        () => closeCalls.push('low'),
        10
      );
      unregisterHigh = result.current.registerBackOverlay(
        'overlay-high',
        () => closeCalls.push('high'),
        20
      );
    });

    expect(backHandler?.()).toBe(true);
    expect(closeCalls).toEqual(['high']);
    expect(result.current.activeTab).toBe('stock');

    act(() => unregisterHigh?.());
    expect(backHandler?.()).toBe(true);
    expect(closeCalls).toEqual(['high', 'low']);

    act(() => unregisterLow?.());
    expect(backHandler?.()).toBe(false);
  });

  it('clears contextual history when selecting a tab directly', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.navigateToTab('shopping'));
    act(() => result.current.selectTab('logs'));

    expect(result.current.activeTab).toBe('logs');
    expect(backHandler?.()).toBe(false);
    expect(result.current.activeTab).toBe('logs');
  });

  it('does not grow history when selecting the current tab repeatedly', () => {
    const { result } = renderHook(() => useHarness());

    act(() => {
      result.current.navigateToTab('shopping');
      result.current.navigateToTab('shopping');
      result.current.navigateToTab('user-data');
    });

    expect(backHandler?.()).toBe(true);
    expect(result.current.activeTab).toBe('shopping');
    expect(backHandler?.()).toBe(true);
    expect(result.current.activeTab).toBe('stock');
    expect(backHandler?.()).toBe(false);
  });
});
