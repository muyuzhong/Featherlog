// Quiet mechanical taps synthesised with Web Audio: a few milliseconds of
// filtered noise for the contact and a short low sine for the body. No files.

export type Cue = 'tap' | 'lift' | 'settle' | 'done' | 'ready';

export interface SoundSettings {
  sound: boolean;
  /** 0-10 */
  volume: number;
}

interface Voice {
  noiseHz: number;
  noiseMs: number;
  toneFrom: number;
  toneTo: number;
  toneMs: number;
  /** a second tap this many ms later, or 0 */
  echoMs: number;
}

const VOICES: Record<Cue, Voice> = {
  tap: { noiseHz: 2400, noiseMs: 6, toneFrom: 190, toneTo: 120, toneMs: 28, echoMs: 0 },
  lift: { noiseHz: 3000, noiseMs: 5, toneFrom: 260, toneTo: 180, toneMs: 30, echoMs: 0 },
  settle: { noiseHz: 1700, noiseMs: 7, toneFrom: 150, toneTo: 96, toneMs: 34, echoMs: 0 },
  done: { noiseHz: 2600, noiseMs: 5, toneFrom: 220, toneTo: 150, toneMs: 26, echoMs: 70 },
  ready: { noiseHz: 3200, noiseMs: 4, toneFrom: 330, toneTo: 260, toneMs: 40, echoMs: 110 },
};

/** Loudness from the 0-10 setting: squared, so the low steps stay usable. */
export function gainFor(volume: number): number {
  const v = Math.min(10, Math.max(0, volume)) / 10;
  return v * v * 0.32;
}

type AudioCtor = new () => AudioContext;

export interface Soundboard {
  play(cue: Cue, settings: SoundSettings): void;
}

export function createSoundboard(ctor: AudioCtor | undefined = globalThis.AudioContext): Soundboard {
  let ctx: AudioContext | null = null;
  let noise: AudioBuffer | null = null;

  const context = (): AudioContext | null => {
    if (!ctor) return null;
    try {
      ctx ??= new ctor();
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  };

  const noiseBuffer = (ac: AudioContext): AudioBuffer => {
    if (noise) return noise;
    const length = Math.ceil(ac.sampleRate * 0.03);
    noise = ac.createBuffer(1, length, ac.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    return noise;
  };

  const strike = (ac: AudioContext, voice: Voice, gain: number, at: number): void => {
    const out = ac.createGain();
    out.gain.value = gain;
    out.connect(ac.destination);

    const src = ac.createBufferSource();
    src.buffer = noiseBuffer(ac);
    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = voice.noiseHz;
    band.Q.value = 1.2;
    const nEnv = ac.createGain();
    nEnv.gain.setValueAtTime(0.9, at);
    nEnv.gain.exponentialRampToValueAtTime(0.001, at + voice.noiseMs / 1000);
    src.connect(band).connect(nEnv).connect(out);
    src.start(at);
    src.stop(at + voice.noiseMs / 1000 + 0.01);

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(voice.toneFrom, at);
    osc.frequency.exponentialRampToValueAtTime(voice.toneTo, at + voice.toneMs / 1000);
    const tEnv = ac.createGain();
    tEnv.gain.setValueAtTime(0.0001, at);
    tEnv.gain.exponentialRampToValueAtTime(0.55, at + 0.002);
    tEnv.gain.exponentialRampToValueAtTime(0.0001, at + voice.toneMs / 1000);
    osc.connect(tEnv).connect(out);
    osc.start(at);
    osc.stop(at + voice.toneMs / 1000 + 0.01);
  };

  return {
    play(cue, settings) {
      if (!settings.sound || settings.volume <= 0) return;
      const ac = context();
      if (!ac) return;
      const voice = VOICES[cue];
      const gain = gainFor(settings.volume);
      const at = ac.currentTime + 0.002;
      strike(ac, voice, gain, at);
      if (voice.echoMs > 0) strike(ac, voice, gain * 0.6, at + voice.echoMs / 1000);
    },
  };
}
