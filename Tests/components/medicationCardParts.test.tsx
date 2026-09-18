/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AutoDeductPausedNote } from '@/components/medicationCardParts';

afterEach(() => {
  cleanup();
});

describe('AutoDeductPausedNote (UI-12)', () => {
  it('states auto-deduct is stopped and manual take remains allowed', () => {
    render(<AutoDeductPausedNote />);
    const note = screen.getByText(/الخصم التلقائي متوقف حاليًا/);
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(/يمكنك تسجيل الجرعة يدويًا/);
    // Must not claim manual dosing is disabled (contradicts Take when !isAutoActive).
    expect(note.textContent).not.toMatch(/الجرعة اليدوية/);
    expect(note.textContent).not.toMatch(/معطل/);
  });
});
