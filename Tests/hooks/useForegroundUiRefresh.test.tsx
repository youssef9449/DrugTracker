/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { useForegroundUiRefresh } from '@/hooks/useForegroundUiRefresh';

vi.mock('@/utils/notifications', () => ({
  isAppInForeground: vi.fn(() => true),
}));

function Probe() {
  useForegroundUiRefresh(0, 1_000);
  return <span data-testid="clock">{new Date().toISOString()}</span>;
}

describe('useForegroundUiRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T07:59:59.000Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('refreshes the host UI after the foreground interval', () => {
    render(<Probe />);
    expect(screen.getByTestId('clock')).toHaveTextContent('07:59:59.000Z');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByTestId('clock')).toHaveTextContent('08:00:00.000Z');
  });
});
