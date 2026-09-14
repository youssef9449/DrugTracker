/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AutoDeductPromptModal } from '@/components/AutoDeductPromptModal';

describe('AutoDeductPromptModal', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <AutoDeductPromptModal isOpen={false} onConfirm={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders prompt title, explanation, and action choices when open', () => {
    render(<AutoDeductPromptModal isOpen={true} onConfirm={vi.fn()} />);

    // Title and question
    expect(
      screen.getByText('تفعيل الخصم التلقائي للأدوية؟')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/مرحباً بك! هل تود تفعيل ميزة الخصم التلقائي للجرعات؟/)
    ).toBeInTheDocument();

    // Explanation details
    expect(
      screen.getByText('ماذا تفعل هذه الميزة؟')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/يقوم التطبيق بخصم جرعات أدويتك تلقائياً من رصيد المخزون/)
    ).toBeInTheDocument();

    // The two choice buttons: نعم and لا
    expect(
      screen.getByRole('button', { name: /نعم/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /لا/ })
    ).toBeInTheDocument();
  });

  it('calls onConfirm(true) when user chooses نعم', () => {
    const onConfirm = vi.fn();
    render(<AutoDeductPromptModal isOpen={true} onConfirm={onConfirm} />);

    const yesBtn = screen.getByRole('button', { name: /نعم/ });
    fireEvent.click(yesBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('calls onConfirm(false) when user chooses لا', () => {
    const onConfirm = vi.fn();
    render(<AutoDeductPromptModal isOpen={true} onConfirm={onConfirm} />);

    const noBtn = screen.getByRole('button', { name: /لا/ });
    fireEvent.click(noBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
