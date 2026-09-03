/**
 * The game's whole soundtrack, synthesised.
 *
 * With the 3D field gone, sound is the only channel left that can tell you
 * something happened somewhere you are not looking — so it has to be good,
 * and it has to be spatial. Every cue here is built from oscillators and
 * filtered noise at run time rather than shipped as files: the period
 * vocabulary is bugles, drums, volleys and bells, all of which synthesise
 * convincingly, and a battle needs dozens of overlapping one-shots that would
 * otherwise be a megabyte of near-identical mp3s.
 *
 * Provenance note: ElevenLabs generation was probed and unavailable
 * (ELEVENLABS_API_KEY=MISSING), so nothing here is sampled or licensed.
 */

export type Cue =
  | "click" | "confirm" | "cancel" | "open" | "close" | "stamp"
  | "spotted" | "under_fire" | "weakened" | "supply_cut" | "supply_restored"
  | "captured" | "lost" | "threatened" | "destroyed"
  | "volley" | "cannon" | "clash"
  | "recruit" | "built" | "crate"
  | "victory" | "defeat";

export type Group = "ui" | "sfx" | "alert" | "ambience";

type PlayOpts = {
  /** Tiles from the centre of the view. Drives level and air absorption. */
  distance?: number;
  /** -1 left, +1 right. */
  pan?: number;
  gain?: number;
};

const GROUP_OF: Record<Cue, Group> = {
  click: "ui", confirm: "ui", cancel: "ui", open: "ui", close: "ui", stamp: "ui",
  spotted: "alert", under_fire: "alert", weakened: "alert", supply_cut: "alert",
  supply_restored: "alert", captured: "alert", lost: "alert", threatened: "alert",
  destroyed: "alert",
  volley: "sfx", cannon: "sfx", clash: "sfx",
  recruit: "sfx", built: "sfx", crate: "ui",
  victory: "alert", defeat: "alert",
};

/** Minimum seconds between two of the same cue, so a firefight is not a buzz. */
const COOLDOWN: Partial<Record<Cue, number>> = {
  volley: 0.09, cannon: 0.22, clash: 0.14, crate: 2.5, under_fire: 1.2, spotted: 1.6,
};

/** The natural harmonics a bugle can actually sound, in semitones over the fundamental. */
const BUGLE = { g: 0, c: 5, e: 9, hg: 12 } as const;
const hz = (semitones: number, root = 233.08) => root * 2 ** (semitones / 12);

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private groups = new Map<Group, GainNode>();
  private hall: ConvolverNode | null = null;
  private hallSend: GainNode | null = null;
  private bed: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private lastAt = new Map<Cue, number>();
  private levels: Record<Group, number> = { ui: 0.6, sfx: 0.85, alert: 0.95, ambience: 0.5 };
  muted = false;
  ready = false;

  /** Browsers require a gesture. Call from the first pointerdown/keydown. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    this.master.connect(ctx.destination);

    // One shared plate. Distance is sold far more by wet/dry and top-end loss
    // than by level alone, which is the whole trick to a field that sounds big.
    this.hall = ctx.createConvolver();
    this.hall.buffer = this.impulse(2.4, 2.6);
    const hallOut = ctx.createGain();
    hallOut.gain.value = 0.9;
    this.hall.connect(hallOut).connect(this.master);
    this.hallSend = ctx.createGain();
    this.hallSend.gain.value = 1;
    this.hallSend.connect(this.hall);

    for (const group of ["ui", "sfx", "alert", "ambience"] as const) {
      const gain = ctx.createGain();
      gain.gain.value = this.levels[group];
      gain.connect(this.master);
      this.groups.set(group, gain);
    }
    this.ready = true;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.85;
  }

  setLevel(group: Group, value: number) {
    this.levels[group] = Math.max(0, Math.min(1, value));
    const node = this.groups.get(group);
    if (node) node.gain.value = this.levels[group];
  }

  level(group: Group) {
    return this.levels[group];
  }

  suspend() {
    if (this.ctx?.state === "running") void this.ctx.suspend();
  }

  resume() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  // -- primitives ----------------------------------------------------------

  private impulse(seconds: number, decay: number) {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
      }
    }
    return buffer;
  }

  private noise(seconds: number) {
    const ctx = this.ctx!;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * The per-cue signal chain.
   *
   * Everything routes through one place so distance behaves identically for a
   * musket, a bugle and a bell: level falls off, the top end rolls away, and
   * the reverb send rises — which is what actually makes a far-off volley read
   * as far off rather than merely quiet.
   */
  private bus(group: Group, opts: PlayOpts) {
    const ctx = this.ctx!;
    const distance = Math.max(0, opts.distance ?? 0);
    const near = 1 / (1 + (distance / 9) ** 1.6);
    const out = ctx.createGain();
    out.gain.value = near * (opts.gain ?? 1);

    const air = ctx.createBiquadFilter();
    air.type = "lowpass";
    air.frequency.value = 18000 / (1 + distance / 4.5);
    air.Q.value = 0.4;

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, opts.pan ?? 0));

    const wet = ctx.createGain();
    wet.gain.value = Math.min(0.55, 0.05 + distance / 60);

    air.connect(pan);
    pan.connect(out);
    out.connect(this.groups.get(group) ?? this.master!);
    out.connect(wet);
    wet.connect(this.hallSend!);
    return { input: air, ctx };
  }

  private tone(
    input: AudioNode,
    ctx: AudioContext,
    type: OscillatorType,
    frequency: number,
    at: number,
    length: number,
    peak: number,
    bend = 1,
  ) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, at);
    if (bend !== 1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * bend), at + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + Math.min(0.02, length * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(input);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  private hit(
    input: AudioNode,
    ctx: AudioContext,
    at: number,
    length: number,
    peak: number,
    filter: BiquadFilterType,
    frequency: number,
    q = 1,
    sweepTo = 0,
  ) {
    const source = ctx.createBufferSource();
    source.buffer = this.noise(length + 0.05);
    const band = ctx.createBiquadFilter();
    band.type = filter;
    band.frequency.setValueAtTime(frequency, at);
    if (sweepTo) band.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), at + length);
    band.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(band).connect(gain).connect(input);
    source.start(at);
    source.stop(at + length + 0.05);
  }

  /** A bugle note: the natural horn's odd harmonic stack, softened. */
  private bugle(input: AudioNode, ctx: AudioContext, semitones: number, at: number, length: number, peak = 0.16) {
    const f = hz(semitones);
    this.tone(input, ctx, "sawtooth", f, at, length, peak * 0.55);
    this.tone(input, ctx, "triangle", f * 2, at, length * 0.9, peak * 0.4);
    this.tone(input, ctx, "sine", f * 3, at, length * 0.7, peak * 0.18);
  }

  /** A struck bell: two inharmonic partials over a long tail. */
  private bell(input: AudioNode, ctx: AudioContext, f: number, at: number, length: number, peak = 0.2) {
    this.tone(input, ctx, "sine", f, at, length, peak);
    this.tone(input, ctx, "sine", f * 2.76, at, length * 0.7, peak * 0.5);
    this.tone(input, ctx, "sine", f * 5.4, at, length * 0.4, peak * 0.22);
  }

  /** A side drum: pitched membrane plus snare rattle. */
  private drum(input: AudioNode, ctx: AudioContext, at: number, peak = 0.3) {
    this.tone(input, ctx, "sine", 180, at, 0.11, peak * 0.7, 0.55);
    this.hit(input, ctx, at, 0.12, peak, "highpass", 1600, 0.7);
  }

  // -- cues ----------------------------------------------------------------

  play(cue: Cue, opts: PlayOpts = {}) {
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    const gate = COOLDOWN[cue];
    if (gate !== undefined && now - (this.lastAt.get(cue) ?? -99) < gate) return;
    this.lastAt.set(cue, now);
    const { input, ctx } = this.bus(GROUP_OF[cue], opts);
    const t = now + 0.005;

    switch (cue) {
      case "click":
        this.hit(input, ctx, t, 0.035, 0.22, "bandpass", 2400, 4);
        break;
      case "confirm":
        this.tone(input, ctx, "triangle", 620, t, 0.09, 0.16);
        this.tone(input, ctx, "triangle", 930, t + 0.05, 0.14, 0.13);
        break;
      case "cancel":
        this.tone(input, ctx, "triangle", 340, t, 0.1, 0.15);
        this.tone(input, ctx, "triangle", 240, t + 0.05, 0.16, 0.12);
        break;
      case "open":
        this.hit(input, ctx, t, 0.16, 0.16, "lowpass", 900, 0.8, 2600);
        break;
      case "close":
        this.hit(input, ctx, t, 0.14, 0.16, "lowpass", 2600, 0.8, 700);
        break;
      case "stamp":
        // A rule taking effect: the thump of a seal on paper.
        this.tone(input, ctx, "sine", 140, t, 0.07, 0.3, 0.5);
        this.hit(input, ctx, t, 0.06, 0.24, "bandpass", 1100, 1.4);
        break;

      case "spotted":
        // "Enemy in sight" — the two-note alarm of a picket's bugle.
        this.bugle(input, ctx, BUGLE.c, t, 0.17, 0.2);
        this.bugle(input, ctx, BUGLE.e, t + 0.16, 0.3, 0.2);
        break;
      case "under_fire":
        for (let i = 0; i < 7; i += 1) this.drum(input, ctx, t + i * 0.062, 0.22);
        this.drum(input, ctx, t + 0.46, 0.34);
        break;
      case "weakened":
        this.bugle(input, ctx, BUGLE.e, t, 0.2, 0.17);
        this.bugle(input, ctx, BUGLE.c, t + 0.18, 0.24, 0.17);
        this.bugle(input, ctx, BUGLE.g, t + 0.38, 0.42, 0.16);
        break;
      case "supply_cut":
        this.tone(input, ctx, "sawtooth", 118, t, 0.5, 0.14, 0.86);
        this.tone(input, ctx, "sine", 59, t, 0.7, 0.2);
        break;
      case "supply_restored":
        this.tone(input, ctx, "triangle", 300, t, 0.16, 0.13);
        this.tone(input, ctx, "triangle", 400, t + 0.11, 0.16, 0.13);
        this.tone(input, ctx, "triangle", 600, t + 0.22, 0.3, 0.12);
        break;
      case "captured":
        this.bell(input, ctx, 494, t, 1.5, 0.2);
        this.bell(input, ctx, 659, t + 0.16, 1.8, 0.16);
        break;
      case "lost":
        this.bell(input, ctx, 233, t, 1.9, 0.22);
        this.bell(input, ctx, 196, t + 0.2, 2.2, 0.18);
        break;
      case "threatened":
        for (let i = 0; i < 3; i += 1) this.bell(input, ctx, 740, t + i * 0.29, 0.6, 0.19);
        break;
      case "destroyed":
        this.tone(input, ctx, "sine", 90, t, 1.1, 0.3, 0.4);
        this.hit(input, ctx, t, 0.9, 0.26, "lowpass", 1400, 0.6, 180);
        break;

      case "volley": {
        // A ragged line, not one bang: a dozen locks over ~120 ms.
        const shots = 9 + Math.floor(Math.random() * 6);
        for (let i = 0; i < shots; i += 1) {
          const at = t + Math.random() * 0.13;
          this.hit(input, ctx, at, 0.05 + Math.random() * 0.05, 0.12, "bandpass", 900 + Math.random() * 1600, 1.1);
        }
        this.tone(input, ctx, "sine", 74, t, 0.2, 0.16, 0.6);
        break;
      }
      case "cannon":
        this.tone(input, ctx, "sine", 62, t, 0.85, 0.45, 0.32);
        this.hit(input, ctx, t, 0.5, 0.4, "lowpass", 2400, 0.7, 220);
        this.hit(input, ctx, t + 0.02, 0.9, 0.14, "lowpass", 380, 0.5, 90);
        break;
      case "clash":
        for (let i = 0; i < 5; i += 1) {
          this.hit(input, ctx, t + Math.random() * 0.25, 0.09, 0.13, "bandpass", 2600 + Math.random() * 2600, 8);
        }
        break;

      case "recruit":
        // A fife flourish as a fresh battalion forms up.
        [0, 4, 7, 12].forEach((step, i) => this.tone(input, ctx, "square", hz(step, 622), t + i * 0.075, 0.1, 0.055));
        break;
      case "built":
        for (let i = 0; i < 3; i += 1) {
          this.tone(input, ctx, "sine", 260 - i * 20, t + i * 0.11, 0.09, 0.16, 0.6);
          this.hit(input, ctx, t + i * 0.11, 0.07, 0.16, "bandpass", 1500, 2);
        }
        break;
      case "crate":
        this.hit(input, ctx, t, 0.07, 0.1, "bandpass", 700, 2.4);
        break;

      case "victory":
        [BUGLE.g, BUGLE.c, BUGLE.e, BUGLE.hg].forEach((step, i) =>
          this.bugle(input, ctx, step, t + i * 0.19, i === 3 ? 1.1 : 0.2, 0.2));
        break;
      case "defeat":
        [BUGLE.hg, BUGLE.e, BUGLE.c, BUGLE.g].forEach((step, i) =>
          this.bugle(input, ctx, step, t + i * 0.28, i === 3 ? 1.6 : 0.3, 0.17));
        break;
    }
  }

  /**
   * The field bed: wind over open ground, with a slow swell.
   *
   * Filtered noise looped through a slowly-moving band. It is deliberately
   * almost inaudible — its job is to stop the game sounding like it is played
   * in a vacuum between events, not to be noticed.
   */
  ambience(on: boolean) {
    if (!this.ctx) return;
    if (!on) {
      this.bed?.source.stop();
      this.bed = null;
      return;
    }
    if (this.bed) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noise(6);
    source.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 380;
    band.Q.value = 0.7;
    const swell = ctx.createOscillator();
    swell.frequency.value = 0.07;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 170;
    swell.connect(swellDepth).connect(band.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0.11;
    source.connect(band).connect(gain).connect(this.groups.get("ambience") ?? this.master!);
    source.start();
    swell.start();
    this.bed = { source, gain };
  }
}

export const audio = new GameAudio();
