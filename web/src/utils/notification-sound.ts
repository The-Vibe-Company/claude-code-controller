import type { SoundVariant } from "../../server/plugins/types.js";

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function ensureResumed(ctx: AudioContext): void {
  if (ctx.state === "suspended") {
    ctx.resume();
  }
}

/** Two ascending tones: E5 → G5 */
function playDefault(ctx: AudioContext): void {
  const now = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(659.25, now);
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.3);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(783.99, now + 0.15);
  gain2.gain.setValueAtTime(0.001, now);
  gain2.gain.setValueAtTime(0.3, now + 0.15);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.5);
}

/** Two descending tones: G5 → E5 */
function playError(ctx: AudioContext): void {
  const now = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(783.99, now);
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.3);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(659.25, now + 0.15);
  gain2.gain.setValueAtTime(0.001, now);
  gain2.gain.setValueAtTime(0.3, now + 0.15);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.5);
}

/** Single sustained tone: D5 (587.33 Hz) */
function playWarning(ctx: AudioContext): void {
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(587.33, now);
  gain.gain.setValueAtTime(0.25, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

/** Short soft tone: C5 (523.25 Hz), lower gain */
function playInfo(ctx: AudioContext): void {
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(523.25, now);
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.25);
}

/**
 * Plays a notification sound. Different variants produce different tones:
 * - "default" / "success": Ascending E5 → G5 chime
 * - "error": Descending G5 → E5
 * - "warning": Single sustained D5
 * - "info": Short soft C5
 */
export function playNotificationSound(variant: SoundVariant = "default"): void {
  try {
    const ctx = getAudioContext();
    ensureResumed(ctx);

    switch (variant) {
      case "error":
        playError(ctx);
        break;
      case "warning":
        playWarning(ctx);
        break;
      case "info":
        playInfo(ctx);
        break;
      default:
        playDefault(ctx);
        break;
    }
  } catch {
    // Silently fail if Web Audio API is not available
  }
}

/** Maps a plugin insight level to a sound variant. */
export function levelToSoundVariant(level: string): SoundVariant {
  switch (level) {
    case "success": return "success";
    case "error": return "error";
    case "warning": return "warning";
    default: return "info";
  }
}
