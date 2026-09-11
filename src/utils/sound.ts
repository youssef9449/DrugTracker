// Subtle pleasant audio feedback using Web Audio API (Zero external assets needed)

let audioCtx: AudioContext | null = null;

// #107: track active audio sources so stopAllSounds() can preempt them.
const activeOscillators = new Set<OscillatorNode>();

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
 * Stops every active oscillator (synthesized tones). Safe to call when
 * nothing is playing — the Set is simply empty.
 */
export function stopAllSounds(): void {
  for (const osc of activeOscillators) {
    try {
      osc.stop();
    } catch {
      // already stopped — ignore
    }
  }
  activeOscillators.clear();

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

/**
 * Plays a short ascending success chime (C5 → E5 → G5).
 * Used for UX feedback on successful actions (refill, restore, toggle, etc.).
 * NOT used for dose-reminder notifications — those use the native Android
 * channel sound exclusively.
 */
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
