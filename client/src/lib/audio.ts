import { storageGet, storageSet } from './router';

/** Tiny synthesized sound effects. The AudioContext is only created after a user gesture. */
class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = storageGet<boolean>(localStorage, 'ss-muted') ?? false;
  private listeners = new Set<() => void>();

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
  }

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    storageSet(localStorage, 'ss-muted', muted);
    if (this.master) this.master.gain.value = muted ? 0 : 0.5;
    this.listeners.forEach((l) => l());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private tone(freq: number, duration: number, type: OscillatorType = 'square', gain = 0.25, delay = 0, slideTo?: number) {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  private noise(duration: number, gain: number, filterFreq: number) {
    if (!this.ctx || !this.master || this.muted) return;
    const len = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.master);
    src.start();
  }

  countdown(n: number) {
    if (n > 0) this.tone(520, 0.18, 'square', 0.18);
    else this.tone(1040, 0.4, 'square', 0.22);
  }

  laneChange() {
    this.tone(300, 0.09, 'triangle', 0.12, 0, 520);
  }

  crash() {
    this.noise(0.6, 0.9, 900);
    this.tone(110, 0.5, 'sawtooth', 0.3, 0, 40);
  }

  win() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.25, 'square', 0.18, 0.5 + i * 0.12));
  }

  blip() {
    this.tone(880, 0.06, 'square', 0.1);
  }
}

export const sfx = new Sfx();
