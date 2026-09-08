// Subtle pleasant audio feedback using Web Audio API (Zero external assets needed)
import { NotificationSoundType } from '../types';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx && typeof window !== 'undefined') {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  } catch {
    return null;
  }
}

export interface NotificationSoundOption {
  id: NotificationSoundType;
  name: string;
  description: string;
  icon: string;
}

export const NOTIFICATION_SOUND_OPTIONS: NotificationSoundOption[] = [
  { id: 'classic_chime', name: 'نغمة كلاسيكية', description: 'نغمة صاعدة مألوفة وهادئة', icon: '🔔' },
  { id: 'gentle_bell', name: 'جرس هادئ', description: 'رنين بلوري لطيف ونقي', icon: '✨' },
  { id: 'marimba', name: 'ماريمبا خشبية', description: 'إيقاع خشبي خفيف ومبهج', icon: '🪵' },
  { id: 'digital_beep', name: 'نغمة رقمية أندرويد', description: 'تنبيه إلكتروني مزدوج واضح', icon: '📱' },
  { id: 'harp', name: 'قيثارة ناعمة', description: 'عزف أوتار متدرج ومريح', icon: '🎵' },
  { id: 'radar', name: 'رادار طبي', description: 'نبضات طبية دورية دقيقة', icon: '📡' },
];

export function playSuccessChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now); // C5
    osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1); // E5
    osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.2); // G5

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.35);
  } catch {
    // Audio not permitted or supported
  }
}

export function playAlertChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, now); // A4
    osc.frequency.setValueAtTime(349.23, now + 0.12); // F4

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.3);
  } catch {
    // Audio not permitted or supported
  }
}

/**
 * Plays a specific synthesized notification sound for a medication
 */
export function playNotificationSound(soundType: NotificationSoundType = 'classic_chime') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    switch (soundType) {
      case 'gentle_bell': {
        // Dual-tone crystal bell with harmonic overtone
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now); // A5

        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1760, now); // A6 overtone

        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);

        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.9);
        osc2.stop(now + 0.9);
        break;
      }

      case 'marimba': {
        // Fast wooden percussive arpeggio: G4 -> B4 -> D5 -> G5
        const notes = [392.0, 493.88, 587.33, 783.99];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const noteStart = now + idx * 0.08;

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, noteStart);

          gain.gain.setValueAtTime(0.18, noteStart);
          gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.25);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(noteStart);
          osc.stop(noteStart + 0.25);
        });
        break;
      }

      case 'digital_beep': {
        // High-tech double beep
        [
          { freq: 987.77, start: now, dur: 0.09 },
          { freq: 1318.51, start: now + 0.12, dur: 0.15 },
        ].forEach(({ freq, start, dur }) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type = 'square';
          osc.frequency.setValueAtTime(freq, start);

          gain.gain.setValueAtTime(0.1, start);
          gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(start);
          osc.stop(start + dur);
        });
        break;
      }

      case 'harp': {
        // Ascending harp sweep: C5 -> E5 -> G5 -> B5 -> E6
        const harpNotes = [523.25, 659.25, 783.99, 987.77, 1318.51];
        harpNotes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const noteStart = now + idx * 0.06;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, noteStart);

          gain.gain.setValueAtTime(0.14, noteStart);
          gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.45);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(noteStart);
          osc.stop(noteStart + 0.45);
        });
        break;
      }

      case 'radar': {
        // Double medical radar sonar ping
        [now, now + 0.2].forEach((pingStart) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(1046.5, pingStart); // C6
          osc.frequency.exponentialRampToValueAtTime(880, pingStart + 0.15); // Drop to A5

          gain.gain.setValueAtTime(0.2, pingStart);
          gain.gain.exponentialRampToValueAtTime(0.001, pingStart + 0.18);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(pingStart);
          osc.stop(pingStart + 0.18);
        });
        break;
      }

      case 'classic_chime':
      default: {
        // Classic major chord arpeggio: C5 -> E5 -> G5 -> C6
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const noteStart = now + idx * 0.07;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, noteStart);

          gain.gain.setValueAtTime(0.15, noteStart);
          gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.35);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(noteStart);
          osc.stop(noteStart + 0.35);
        });
        break;
      }
    }
  } catch {
    // Audio context not allowed or supported
  }
}

