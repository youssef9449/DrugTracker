import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stopAllSounds, playSuccessChime } from './sound';

describe('stopAllSounds (#107)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when nothing is playing (does not throw)', () => {
    expect(() => stopAllSounds()).not.toThrow();
  });

  it('can be called multiple times safely', () => {
    stopAllSounds();
    stopAllSounds();
    stopAllSounds();
    // No assertion needed — just that it doesn't throw.
  });
});

describe('playSuccessChime', () => {
  // playSuccessChime uses the Web Audio API which isn't available in
  // jsdom, so it silently no-ops. These tests verify it doesn't throw.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when AudioContext is unavailable', () => {
    expect(() => playSuccessChime()).not.toThrow();
  });

  it('can be called multiple times safely', () => {
    playSuccessChime();
    playSuccessChime();
    // No assertion — just that it doesn't throw.
  });
});
