// Subtle pleasant audio feedback using Web Audio API (Zero external assets needed)
import { NotificationSoundType, CustomSoundFile } from '../types';

let audioCtx: AudioContext | null = null;

// #107: track active audio sources so stopAllSounds() can preempt them.
// Oscillators auto-remove on 'ended'; HTMLAudioElements auto-remove on
// 'ended'/'error' (via the existing cleanup() in playCustomSound).
const activeOscillators = new Set<OscillatorNode>();
const activeAudioElements = new Set<HTMLAudioElement>();

/** Register an oscillator so stopAllSounds() can stop it. Auto-removes on ended. */
function trackOscillator(osc: OscillatorNode): void {
  activeOscillators.add(osc);
  osc.onended = () => {
    activeOscillators.delete(osc);
  };
}

/**
 * Stop all currently-playing sounds immediately (#107).
 *
 * Stops every active oscillator (synthesized tones) and pauses every
 * active HTMLAudioElement (custom uploaded sounds). Safe to call when
 * nothing is playing — the Sets are simply empty.
 */
export function stopAllSounds(): void {
  // Stop oscillators. oscillator.stop() throws if already stopped, so
  // guard each call.
  for (const osc of activeOscillators) {
    try {
      osc.stop();
    } catch {
      // already stopped — ignore
    }
  }
  activeOscillators.clear();

  // Pause + reset HTMLAudioElements. Don't close the src (the element
  // may be cached in customAudioCache for reuse).
  for (const audio of activeAudioElements) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch {
      // ignore
    }
  }
  activeAudioElements.clear();

  // Suspend the AudioContext so any in-flight scheduled stops are
  // silenced immediately. It will be resumed by the next getAudioContext()
  // call (which calls resume() when state === 'suspended').
  if (audioCtx && audioCtx.state === 'running') {
    try {
      audioCtx.suspend();
    } catch {
      // ignore
    }
  }
}

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

interface NotificationSoundOption {
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
  // The "custom" entry is a placeholder — its name/description is replaced
  // at render time with the user's uploaded file name.
  { id: 'custom', name: 'ملف صوتي خاص', description: 'اختر ملفاً من جهازك', icon: '📂' },
];

/**
 * Maximum accepted size for a custom sound file. 2 MB keeps the data URL
 * well under the ~5 MB localStorage quota on most browsers while still
 * allowing a high-quality MP3 / WAV / OGG ringtone.
 *
 * Internal to this module — `readCustomSoundFile` is the only caller.
 */
const CUSTOM_SOUND_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Accept attribute for the custom sound file input.
 *
 * We use the generic `audio/*` value (rather than an explicit MIME list)
 * because it is the most reliable trigger for the mobile file picker:
 * - On Android Chrome, it opens the Documents UI and lets the user pick
 *   any audio file from any source (Downloads, Files, WhatsApp, Telegram,
 *   music apps, voice recorder, etc.). Using a strict list of MIME types
 *   can cause the picker to silently filter out files that have slightly
 *   different MIME labels (e.g., `audio/x-mp3` vs `audio/mpeg`).
 * - On iOS Safari, it opens the standard document picker with audio
 *   filtering.
 * - On desktop browsers, it opens the file dialog filtered to audio
 *   files.
 *
 * The actual format validation still happens in `readCustomSoundFile`
 * via the `file.type` and the file extension, so we don't lose any
 * security by accepting the broader type.
 */
export const CUSTOM_SOUND_ACCEPT_ATTR = 'audio/*';

/**
 * Read a File into a base64 data URL. Returns a promise that resolves
 * with the file metadata + data URL, ready to be stored on a Medication.
 */
export function readCustomSoundFile(file: File): Promise<CustomSoundFile> {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('لا يوجد ملف'));
      return;
    }
    if (file.size > CUSTOM_SOUND_MAX_BYTES) {
      reject(new Error('حجم الملف كبير جداً. الحد الأقصى 2 ميجابايت.'));
      return;
    }
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|aac|m4a|webm)$/i.test(file.name)) {
      reject(new Error('صيغة الملف غير مدعومة. اختر MP3 / WAV / OGG / AAC / M4A.'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) {
        reject(new Error('تعذّر قراءة الملف'));
        return;
      }
      resolve({
        fileName: file.name,
        mimeType: file.type || 'audio/mpeg',
        dataUrl,
      });
    };
    reader.onerror = () => reject(new Error('تعذّر قراءة الملف'));
    reader.readAsDataURL(file);
  });
}

// Cache of <audio> elements for currently-loaded custom sounds, keyed by
// the data URL. We reuse the same element so the browser doesn't have to
// re-decode the file each time the user tests the sound.
const customAudioCache = new Map<string, HTMLAudioElement>();

/**
 * Play a custom (user-uploaded) sound file. The audio element is cached
 * so repeated plays are instant. Returns a promise that rejects if the
 * file cannot be played (so the caller can fall back to a default sound).
 */
function playCustomSound(customFile: CustomSoundFile): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (typeof window === 'undefined') {
        reject(new Error('window غير متاح'));
        return;
      }
      let audio = customAudioCache.get(customFile.dataUrl);
      if (!audio) {
        audio = new Audio(customFile.dataUrl);
        audio.preload = 'auto';
        customAudioCache.set(customFile.dataUrl, audio);
      }
      // Reset to start so repeat plays don't accumulate position.
      audio.currentTime = 0;
      audio.volume = 1;

      // #107: track so stopAllSounds() can pause it.
      activeAudioElements.add(audio);

      const cleanup = () => {
        audio?.removeEventListener('ended', onEnded);
        audio?.removeEventListener('error', onError);
        activeAudioElements.delete(audio);
      };
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('تعذّر تشغيل الملف الصوتي'));
      };
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('error', onError);

      const playResult = audio.play();
      if (playResult && typeof playResult.then === 'function') {
        playResult.then(() => void 0).catch((err) => {
          cleanup();
          reject(err);
        });
      }
    } catch (err) {
      reject(err);
    }
  });
}

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

    // #107: track so stopAllSounds() can stop it.
    trackOscillator(osc);

    osc.start(now);
    osc.stop(now + 0.35);
  } catch {
    // Audio not permitted or supported
  }
}

/**
 * Plays a specific synthesized notification sound for a medication.
 * If the medication uses a custom uploaded file, plays that file via
 * the HTMLAudioElement; falls back to the classic chime if the file
 * fails to play.
 */
export function playNotificationSound(
  soundType: NotificationSoundType = 'classic_chime',
  customSoundFile?: CustomSoundFile
) {
  if (soundType === 'custom') {
    if (customSoundFile?.dataUrl) {
      playCustomSound(customSoundFile).catch(() => {
        // Fall back to the synthesized classic chime if the custom file
        // cannot be played (e.g., format not supported, file deleted).
        playSynthesizedSound('classic_chime');
      });
      return;
    }
    // No custom file set despite the type being 'custom' — fall back.
    playSynthesizedSound('classic_chime');
    return;
  }
  playSynthesizedSound(soundType);
}

function playSynthesizedSound(soundType: NotificationSoundType) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // #107: wrap ctx.createOscillator() so every oscillator is auto-tracked
    // for stopAllSounds(). The wrapper is scoped to this call so the
    // Set doesn't grow unbounded across multiple play() calls — each
    // oscillator auto-removes on 'ended' via trackOscillator().
    const createOsc = (): OscillatorNode => {
      const osc = ctx.createOscillator();
      trackOscillator(osc);
      return osc;
    };

    switch (soundType) {
      case 'gentle_bell': {
        // Dual-tone crystal bell with harmonic overtone
        const osc1 = createOsc();
        const osc2 = createOsc();
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

