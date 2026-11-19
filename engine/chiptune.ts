/**
 * Zero-dependency chiptune synth on the Web Audio API.
 *
 * Every sound is synthesised on demand from square/triangle oscillators and a
 * cached white-noise buffer, so there are no audio assets to load. The
 * AudioContext is created lazily on the first user gesture (autoplay policy)
 * and the mute preference persists in localStorage.
 */

const STORAGE_KEY = "hncourt:chiptune-muted";
const MASTER_VOLUME = 0.16;

type Listener = (muted: boolean) => void;

interface ToneSpec {
  type?: OscillatorType;
  freq: number;
  /** Glide target; the pitch ramps exponentially to it over the note. */
  freqEnd?: number;
  /** Seconds from now. */
  at?: number;
  duration: number;
  gain?: number;
  attack?: number;
  vibrato?: { rate: number; depth: number };
}

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);

// Note numbers used by the jingles.
const N = {
  C3: 48, G3: 55, C4: 60, E4: 64, F4: 65, Fs4: 66, G4: 67, A4: 69, B4: 71,
  C5: 72, D5: 74, E5: 76, G5: 79, A5: 81, B5: 83, C6: 84, E6: 88, G6: 91, E2: 40,
} as const;

export class Chiptune {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private hydrated = false;
  private lastBlip = 0;
  private readonly listeners = new Set<Listener>();

  /** Reads the persisted preference once, in the browser only. */
  private hydrate(): void {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    try {
      this.muted = window.localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      this.muted = false;
    }
  }

  isMuted = (): boolean => {
    this.hydrate();
    return this.muted;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setMuted(muted: boolean): void {
    this.hydrate();
    this.muted = muted;
    try {
      window.localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
    } catch {
      /* storage unavailable: preference lasts for this page only */
    }
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, this.ctx.currentTime, 0.015);
    }
    this.listeners.forEach((listener) => listener(muted));
  }

  toggle(): boolean {
    this.setMuted(!this.isMuted());
    if (!this.muted) this.select();
    return this.muted;
  }

  /** Call from a user gesture so later sounds are allowed to play. */
  unlock(): void {
    const ctx = this.context();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }

  private context(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (this.ctx) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.isMuted() ? 0 : MASTER_VOLUME;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  /** Returns a live context, or null when muted / unsupported. */
  private live(): AudioContext | null {
    if (this.isMuted()) return null;
    const ctx = this.context();
    if (!ctx || !this.master) return null;
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  }

  private tone(spec: ToneSpec): void {
    const ctx = this.live();
    if (!ctx || !this.master) return;
    const start = ctx.currentTime + (spec.at ?? 0);
    const end = start + spec.duration;
    const peak = spec.gain ?? 0.3;
    const attack = Math.min(spec.attack ?? 0.004, spec.duration / 2);

    const osc = ctx.createOscillator();
    osc.type = spec.type ?? "square";
    osc.frequency.setValueAtTime(spec.freq, start);
    if (spec.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.freqEnd), end);
    }

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(peak, start + attack);
    amp.gain.setValueAtTime(peak, Math.max(start + attack, end - 0.03));
    amp.gain.exponentialRampToValueAtTime(0.0001, end);

    if (spec.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = spec.vibrato.rate;
      depth.gain.value = spec.vibrato.depth;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(start);
      lfo.stop(end);
    }

    osc.connect(amp).connect(this.master);
    osc.start(start);
    osc.stop(end + 0.02);
  }

  private noise(at: number, duration: number, gain: number, cutoff: number): void {
    const ctx = this.live();
    if (!ctx || !this.master) return;
    if (!this.noiseBuffer) {
      const length = Math.floor(ctx.sampleRate * 0.5);
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      // Deterministic LFSR-style noise, NES flavoured.
      let lfsr = 0x7fff;
      for (let i = 0; i < length; i += 1) {
        const bit = (lfsr ^ (lfsr >> 1)) & 1;
        lfsr = (lfsr >> 1) | (bit << 14);
        data[i] = lfsr & 1 ? 1 : -1;
      }
    }
    const start = ctx.currentTime + at;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(amp).connect(this.master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  /** Text blip for the typewriter. Throttled so long lines don't buzz. */
  blip(pitch = 1): void {
    const now = typeof performance === "undefined" ? 0 : performance.now();
    if (now - this.lastBlip < 42) return;
    this.lastBlip = now;
    this.tone({ freq: 540 * pitch + Math.random() * 60, duration: 0.028, gain: 0.2 });
  }

  select(): void {
    this.tone({ freq: midi(N.E5), freqEnd: midi(N.B5), duration: 0.05, gain: 0.18 });
  }

  tick(): void {
    this.tone({ freq: midi(N.C6) * 2, duration: 0.018, gain: 0.1 });
  }

  /** The objection hit: gavel crack, low thump, two-note sting. */
  gavel(): void {
    this.noise(0, 0.14, 0.9, 1400);
    this.tone({ type: "square", freq: 150, freqEnd: 48, duration: 0.2, gain: 0.55, attack: 0.002 });
    this.tone({ type: "triangle", freq: 90, freqEnd: 40, duration: 0.24, gain: 0.6, attack: 0.002 });
    this.tone({ freq: midi(N.E5), at: 0.06, duration: 0.09, gain: 0.28 });
    this.tone({ freq: midi(N.B5), at: 0.15, duration: 0.18, gain: 0.28, vibrato: { rate: 9, depth: 12 } });
  }

  holdIt(): void {
    this.tone({ freq: midi(N.G4), duration: 0.07, gain: 0.22 });
    this.tone({ freq: midi(N.G5), at: 0.08, duration: 0.14, gain: 0.22 });
  }

  sustained(critical = false): void {
    const notes = critical ? [N.C6, N.E6, N.G6, N.C6 + 12] : [N.C5, N.E5, N.G5];
    notes.forEach((note, i) => this.tone({ freq: midi(note), at: i * 0.055, duration: 0.07, gain: 0.2 }));
  }

  overruled(): void {
    this.tone({ freq: midi(N.E4), at: 0, duration: 0.14, gain: 0.24 });
    this.tone({ freq: midi(N.C4) * 0.94, at: 0.15, duration: 0.32, gain: 0.24, vibrato: { rate: 7, depth: 6 } });
  }

  victory(): void {
    const lead = [N.C5, N.E5, N.G5, N.C6, N.G5, N.C6];
    const lengths = [0.1, 0.1, 0.1, 0.18, 0.1, 0.5];
    let t = 0;
    lead.forEach((note, i) => {
      const duration = lengths[i] ?? 0.1;
      this.tone({ freq: midi(note), at: t, duration, gain: 0.22 });
      t += duration + 0.015;
    });
    [N.C3, N.G3, N.C4].forEach((note, i) =>
      this.tone({ type: "triangle", freq: midi(note), at: i * 0.22, duration: 0.24, gain: 0.35 }),
    );
    this.tone({ type: "triangle", freq: midi(N.C3), at: 0.68, duration: 0.5, gain: 0.35 });
  }

  defeat(): void {
    const notes = [N.G4, N.Fs4, N.F4, N.E4];
    notes.forEach((note, i) =>
      this.tone({
        freq: midi(note),
        at: i * 0.22,
        duration: i === notes.length - 1 ? 0.6 : 0.2,
        gain: 0.22,
        vibrato: i === notes.length - 1 ? { rate: 6, depth: 5 } : undefined,
      }),
    );
    this.tone({ type: "triangle", freq: midi(N.E2), at: 0.66, duration: 0.7, gain: 0.35 });
  }
}

/** App-wide singleton. Safe to import during SSR: nothing touches the DOM until used. */
export const chiptune = new Chiptune();
