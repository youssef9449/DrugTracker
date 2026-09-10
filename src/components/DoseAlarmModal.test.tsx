/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DoseAlarmModal } from './DoseAlarmModal';
import type { Medication } from '../types';

// Mock playNotificationSound so we can assert it's NOT called on mount
// (#18/#19: the chime is now the hook's job, not the modal's).
vi.mock('../utils/sound', () => ({
  playNotificationSound: vi.fn(),
  NOTIFICATION_SOUND_OPTIONS: [
    { id: 'classic_chime', name: 'نغمة كلاسيكية', description: '', icon: '🔔' },
    { id: 'gentle_bell', name: 'جرس هادئ', description: '', icon: '✨' },
  ],
}));

import { playNotificationSound } from '../utils/sound';

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: 'med-alarm',
    name: 'Test Med',
    currentPills: 5,
    dailyDose: 1,
    unit: 'قرص',
    warningThresholdDays: 5,
    colorTag: 'teal',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastSyncDate: '2024-01-01',
    reminderEnabled: true,
    reminderTime: '09:00',
    notificationSound: 'classic_chime',
    ...overrides,
  };
}

describe('DoseAlarmModal — chime (#18/#19)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT play the chime on mount (the chime is the hook\'s job — #18)', () => {
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    // The modal renders the med name.
    expect(screen.getByText('Test Med')).toBeInTheDocument();
    // But it must NOT have played a chime — that's useDoseReminders.triggerAlarm's
    // responsibility now. Previously the modal had a useEffect that played the
    // chime on the false→true opening, causing a double chime (#18).
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it('does NOT play the chime even if isOpen transitions from false to true (#18)', () => {
    const med = makeMed();
    const { rerender } = render(
      <DoseAlarmModal
        isOpen={false}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(playNotificationSound).not.toHaveBeenCalled();

    // Open the modal.
    rerender(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    // Still must NOT play — the hook already played it when triggerAlarm
    // was called.
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it('renders NO replay/chime button — the chime is solely the hook\'s job (#18/#19, refactor d81d4a9)', () => {
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    // The replay button (previously title="إعادة الاستماع للنغمة") was
    // intentionally removed in commit d81d4a9 along with the sound import —
    // the chime is now solely the hook's job via useDoseReminders.triggerAlarm.
    expect(screen.queryByTitle('إعادة الاستماع للنغمة')).toBeNull();
    // No user action on the modal should trigger the chime.
    fireEvent.click(screen.getByText('تناولت الجرعة الآن'));
    fireEvent.click(screen.getByText('تأجيل 10 دقائق'));
    fireEvent.click(screen.getByLabelText('إغلاق'));
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it('renders nothing when isOpen is false', () => {
    const med = makeMed();
    const { container } = render(
      <DoseAlarmModal
        isOpen={false}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('calls onDismiss when the close (X) button is clicked', () => {
    const onDismiss = vi.fn();
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={vi.fn()}
        onDismiss={onDismiss}
      />
    );
    fireEvent.click(screen.getByLabelText('إغلاق'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onTakeDose when the "تناولت الجرعة الآن" button is clicked', () => {
    const onTakeDose = vi.fn();
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={onTakeDose}
        onSnooze={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('تناولت الجرعة الآن'));
    expect(onTakeDose).toHaveBeenCalledWith(med);
  });

  it('calls onSnooze when the "تأجيل 10 دقائق" button is clicked', () => {
    const onSnooze = vi.fn();
    const med = makeMed();
    render(
      <DoseAlarmModal
        isOpen={true}
        medication={med}
        onTakeDose={vi.fn()}
        onSnooze={onSnooze}
        onDismiss={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('تأجيل 10 دقائق'));
    expect(onSnooze).toHaveBeenCalledWith(med);
  });
});
