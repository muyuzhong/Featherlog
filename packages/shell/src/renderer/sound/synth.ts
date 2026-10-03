import type { SoundCue, UiSound } from '@featherlog/contracts';

/*
 * The journal's sounds (design §10.1), synthesised with Web Audio rather than
 * shipped as recordings: no licensing, nothing to load, and each cue can be
 * tuned like the textures are. Every cue is short and quiet; they should feel
 * like the pen and the paper, not like an app notifying you.
 */

type Kit = { ctx: BaseAudioContext; out: AudioNode; noise: AudioBuffer; at: number };

type Burst = { at?: number; dur: number; freq: number; to?: number; q?: number; gain: number; type?: BiquadFilterType; attack?: number };
type Tone = { at?: number; dur: number; freq: number; to?: number; gain: number; type?: OscillatorType; attack?: number };

const SILENT = 0.0001;

function envelope(k: Kit, start: number, attack: number, dur: number, peak: number): GainNode {
  const g = k.ctx.createGain();
  g.gain.setValueAtTime(SILENT, start);
  g.gain.exponentialRampToValueAtTime(peak, start + attack);
  g.gain.exponentialRampToValueAtTime(SILENT, start + dur);
  g.connect(k.out);
  return g;
}

/** Filtered noise: scratches, rustles, thuds. */
function burst(k: Kit, b: Burst) {
  const start = k.at + (b.at ?? 0);
  const src = k.ctx.createBufferSource();
  src.buffer = k.noise;
  const filter = k.ctx.createBiquadFilter();
  filter.type = b.type ?? 'bandpass';
  filter.Q.value = b.q ?? 1;
  filter.frequency.setValueAtTime(b.freq, start);
  if (b.to) filter.frequency.exponentialRampToValueAtTime(b.to, start + b.dur);
  src.connect(filter).connect(envelope(k, start, b.attack ?? Math.min(0.01, b.dur / 4), b.dur, b.gain));
  // A random offset into the noise keeps repeated strokes from sounding identical.
  src.start(start, Math.random() * (k.noise.duration - b.dur - 0.05));
  src.stop(start + b.dur + 0.03);
}

/** A pitched tone: chimes, bells, the body of a thud. */
function tone(k: Kit, t: Tone) {
  const start = k.at + (t.at ?? 0);
  const osc = k.ctx.createOscillator();
  osc.type = t.type ?? 'sine';
  osc.frequency.setValueAtTime(t.freq, start);
  if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.dur);
  osc.connect(envelope(k, start, t.attack ?? 0.005, t.dur, t.gain));
  osc.start(start);
  osc.stop(start + t.dur + 0.05);
}

const CUES: Record<SoundCue, (k: Kit) => void> = {
  // A quill crossing paper: three short scratches, each a little different.
  ink(k) {
    burst(k, { dur: 0.07, freq: 4200, to: 3000, q: 2.2, gain: 0.7 });
    burst(k, { at: 0.075, dur: 0.06, freq: 3600, to: 2600, q: 2, gain: 0.58 });
    burst(k, { at: 0.14, dur: 0.1, freq: 4800, to: 2400, q: 1.8, gain: 0.45 });
    burst(k, { dur: 0.22, freq: 900, type: 'lowpass', gain: 0.12 });
  },
  // A light tap of the nib.
  tick(k) {
    tone(k, { dur: 0.06, freq: 1150, to: 820, type: 'triangle', gain: 0.2 });
    burst(k, { dur: 0.018, freq: 6000, type: 'highpass', gain: 0.08 });
  },
  // Two soft notes, rising: something new to read.
  unlock(k) {
    tone(k, { dur: 0.9, freq: 1318.5, gain: 0.1, attack: 0.01 });
    tone(k, { at: 0.07, dur: 1.1, freq: 1975.5, gain: 0.075, attack: 0.01 });
    tone(k, { at: 0.14, dur: 0.7, freq: 2637, gain: 0.03, attack: 0.01 });
  },
  // Rubbing out: two broad strokes.
  erase(k) {
    burst(k, { dur: 0.12, freq: 1600, to: 1200, q: 0.8, gain: 0.32, attack: 0.03 });
    burst(k, { at: 0.13, dur: 0.1, freq: 1500, to: 1900, q: 0.8, gain: 0.24, attack: 0.03 });
  },
  // A page lifting and settling.
  page(k) {
    burst(k, { dur: 0.32, freq: 700, to: 3200, q: 0.7, gain: 0.4, attack: 0.09 });
    burst(k, { at: 0.24, dur: 0.08, freq: 5000, type: 'highpass', gain: 0.1 });
  },
  // Warm wax pressed down.
  seal(k) {
    burst(k, { dur: 0.02, freq: 3000, type: 'highpass', gain: 0.07 });
    tone(k, { dur: 0.22, freq: 140, to: 70, gain: 0.4 });
    burst(k, { dur: 0.28, freq: 1200, to: 300, type: 'lowpass', gain: 0.18 });
  },
  // A small bell: inharmonic partials decaying at their own pace.
  bell(k) {
    const base = 659.25;
    const partials: [ratio: number, gain: number, dur: number][] = [
      [1, 0.2, 2.6],
      [1.003, 0.08, 2.4],
      [2, 0.09, 1.8],
      [2.76, 0.06, 1.4],
      [4.07, 0.035, 0.9],
      [5.4, 0.02, 0.6],
    ];
    for (const [ratio, gain, dur] of partials) tone(k, { dur, freq: base * ratio, gain, attack: 0.004 });
  },
  // The vermilion seal: a firm thump, then the paper settles.
  stamp(k) {
    tone(k, { dur: 0.18, freq: 110, to: 48, gain: 0.5 });
    burst(k, { dur: 0.12, freq: 600, type: 'lowpass', gain: 0.28 });
    burst(k, { at: 0.08, dur: 0.1, freq: 2500, q: 0.9, gain: 0.07 });
  },
};

function whiteNoise(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.5), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Volume levels 0–10 mapped onto a curve that sounds even to the ear. */
export const gainFor = (volume: number) => (Math.max(0, Math.min(10, volume)) / 10) ** 1.6 * 0.9;

/**
 * One window's sound player. The audio context starts on the first cue, so it
 * is created inside the user's click and isn't blocked by autoplay rules.
 */
export function createSound(options: { enabled(): boolean; volume(): number }): UiSound & { dispose(): void } {
  let kit: (Omit<Kit, 'at' | 'ctx'> & { ctx: AudioContext }) | undefined;
  let master: GainNode | undefined;
  const ensure = (): Kit => {
    if (!kit || !master) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.ratio.value = 3;
      compressor.connect(ctx.destination);
      master = ctx.createGain();
      master.connect(compressor);
      kit = { ctx, out: master, noise: whiteNoise(ctx) };
    }
    if (kit.ctx.state === 'suspended') void kit.ctx.resume();
    master.gain.value = gainFor(options.volume());
    return { ...kit, at: kit.ctx.currentTime + 0.005 };
  };
  return {
    play(cue) {
      if (!options.enabled() || options.volume() <= 0) return;
      try {
        CUES[cue](ensure());
      } catch (cause) {
        // A missing audio device must never break the journal.
        console.debug('sound unavailable', cause);
      }
    },
    dispose() {
      void kit?.ctx.close();
    },
  };
}

/** Renders one cue offline, for tuning by measurement (levels, length) rather than by ear alone. */
export function renderCue(cue: SoundCue, volume = 6, sampleRate = 44100): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, sampleRate * 3, sampleRate);
  const master = ctx.createGain();
  master.gain.value = gainFor(volume);
  master.connect(ctx.destination);
  CUES[cue]({ ctx, out: master, noise: whiteNoise(ctx), at: 0.01 });
  return ctx.startRendering();
}
