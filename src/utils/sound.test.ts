import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readCustomSoundFile,
  getDoseNotificationSound,
  CUSTOM_SOUND_ACCEPT_ATTR,
  NOTIFICATION_SOUND_OPTIONS,
  stopAllSounds,
} from './sound';
import type { CustomSoundFile } from '../types';

/**
 * Helpers for building in-memory File objects (jsdom supports `new File()`
 * and `FileReader.readAsDataURL`).
 */
function makeAudioFile(
  name: string,
  size: number,
  type: string = 'audio/mpeg'
): File {
  // Build a File with the requested size. We fill with zeros; the content
  // isn't decoded by `readCustomSoundFile` — it only reads to a data URL.
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe('getDoseNotificationSound', () => {
  const customSound: CustomSoundFile = {
    fileName: 'dose.mp3',
    mimeType: 'audio/mpeg',
    dataUrl: 'data:audio/mpeg;base64,AAAA',
  };

  it('disables foreground playback when sound is off', () => {
    expect(getDoseNotificationSound(false, customSound, 'marimba')).toBeNull();
  });

  it('prefers the global custom sound', () => {
    expect(getDoseNotificationSound(true, customSound, 'marimba')).toEqual({
      soundType: 'custom',
      customSoundFile: customSound,
    });
  });

  it('uses the per-med sound, then the default chime', () => {
    expect(getDoseNotificationSound(true, null, 'harp')).toEqual({ soundType: 'harp' });
    expect(getDoseNotificationSound(true, null, undefined)).toEqual({ soundType: 'classic_chime' });
  });
});

describe('CUSTOM_SOUND_ACCEPT_ATTR', () => {
  it('is "audio/*" (the generic audio MIME wildcard)', () => {
    expect(CUSTOM_SOUND_ACCEPT_ATTR).toBe('audio/*');
  });
});

describe('NOTIFICATION_SOUND_OPTIONS', () => {
  it('includes all synthesized tones + the custom placeholder', () => {
    const ids = NOTIFICATION_SOUND_OPTIONS.map((o) => o.id);
    expect(ids).toEqual([
      'classic_chime',
      'gentle_bell',
      'marimba',
      'digital_beep',
      'harp',
      'radar',
      'custom',
    ]);
  });

  it('every option has a non-empty name, description, and icon', () => {
    for (const opt of NOTIFICATION_SOUND_OPTIONS) {
      expect(opt.name).toBeTruthy();
      expect(opt.description).toBeTruthy();
      expect(opt.icon).toBeTruthy();
    }
  });
});

describe('readCustomSoundFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a file larger than 2 MB (CUSTOM_SOUND_MAX_BYTES)', async () => {
    // 2 MB + 1 byte → over the limit.
    const tooBig = makeAudioFile('big.mp3', 2 * 1024 * 1024 + 1);
    await expect(readCustomSoundFile(tooBig)).rejects.toThrow(
      /حجم الملف كبير جداً/
    );
  });

  it('accepts a file exactly at the 2 MB limit', async () => {
    const atLimit = makeAudioFile('edge.mp3', 2 * 1024 * 1024);
    const result = await readCustomSoundFile(atLimit);
    expect(result.fileName).toBe('edge.mp3');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.dataUrl.startsWith('data:audio/mpeg;base64,')).toBe(true);
  });

  it('rejects a non-audio file by MIME type', async () => {
    const image = makeAudioFile('photo.png', 100, 'image/png');
    await expect(readCustomSoundFile(image)).rejects.toThrow(
      /صيغة الملف غير مدعومة/
    );
  });

  it('accepts a file with no MIME type but an audio extension', async () => {
    // Some browsers/OSes don't set file.type for certain extensions.
    const wav = new File([new Uint8Array(100)], 'bell.wav', { type: '' });
    const result = await readCustomSoundFile(wav);
    expect(result.fileName).toBe('bell.wav');
    // The fallback MIME is 'audio/mpeg' when file.type is empty.
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('rejects a file with neither audio MIME type nor audio extension', async () => {
    const txt = new File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' });
    await expect(readCustomSoundFile(txt)).rejects.toThrow(
      /صيغة الملف غير مدعومة/
    );
  });

  it('returns a CustomSoundFile with the original file name', async () => {
    const file = makeAudioFile('my-ringtone.mp3', 500);
    const result: CustomSoundFile = await readCustomSoundFile(file);
    expect(result.fileName).toBe('my-ringtone.mp3');
  });
});

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

describe('playNotificationSound — synthesized tones (#107 regression)', () => {
  // Regression test for the infinite-recursion bug in playSynthesizedSound.
  // The #107 audit introduced a local `createOsc` helper that called ITSELF
  // (not ctx.createOscillator), causing a stack overflow caught silently
  // by the try/catch — every synthesized sound (gentle_bell, marimba,
  // digital_beep, harp, radar, classic_chime) crashed with no error shown.
  // This test mocks the AudioContext to verify playNotificationSound
  // actually calls ctx.createOscillator() and does not throw.

  // Build a mock AudioContext with chainable createOscillator/createGain.
  function buildMockCtx() {
    const mockNode = {
      type: '',
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(function (this: typeof mockNode) { return this; }),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
      onended: null as null | (() => void),
    };
    const mockCtx = {
      currentTime: 0,
      state: 'running',
      resume: vi.fn(),
      createOscillator: vi.fn(() => mockNode),
      createGain: vi.fn(() => mockNode),
      destination: {},
    };
    return mockCtx;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'classic_chime',
    'gentle_bell',
    'marimba',
    'digital_beep',
    'harp',
    'radar',
  ] as const)('plays "%s" without throwing (no infinite recursion)', async (soundType) => {
    const mockCtx = buildMockCtx();
    // Stub window.AudioContext so the module-level getAudioContext()
    // creates our mock. Use resetModules + dynamic import to get a fresh
    // module instance (the module-level `audioCtx` is cached, so without
    // a reset the first test's context persists).
    vi.stubGlobal('AudioContext', vi.fn(() => mockCtx));
    vi.resetModules();
    const { playNotificationSound } = await import('./sound');

    try {
      expect(() => playNotificationSound(soundType)).not.toThrow();
      // The synthesized path must actually call createOscillator — the
      // recursion bug meant it was never called (the function threw first).
      expect(mockCtx.createOscillator).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
