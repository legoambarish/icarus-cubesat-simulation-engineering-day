/**
 * SOUND - Web Audio only, no asset files, never fatal
 * =============================================================================
 * Five cues, all synthesised: click, select, state change, anomaly, recovery.
 *
 * Rules the build manual sets and this module keeps:
 *   * muted by default until the user opts in with a gesture (browser autoplay
 *     policy needs the gesture anyway, so the toggle doubles as the unlock)
 *   * every call is wrapped - an AudioContext failure must never take down the
 *     render loop or the telemetry UI
 *   * kept quiet: a projector's speakers should not become the exhibit
 */

export type Cue = 'click' | 'select' | 'state' | 'anomaly' | 'recovery';

const MASTER_GAIN = 0.055;

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = false;
  private failed = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Must be called from a user gesture. Returns the resulting state. */
  async setEnabled(on: boolean): Promise<boolean> {
    if (this.failed) return false;
    this.enabled = on;
    if (!on) {
      if (this.master) this.master.gain.value = 0;
      return false;
    }
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return false;
        }
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = MASTER_GAIN;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      if (this.master) this.master.gain.value = MASTER_GAIN;
      return true;
    } catch (err) {
      console.warn('[audio] disabled:', err);
      this.failed = true;
      this.enabled = false;
      return false;
    }
  }

  /** Fire a cue. Silent no-op when disabled or unavailable. */
  play(cue: Cue): void {
    if (!this.enabled || this.failed || !this.ctx || !this.master) return;
    try {
      switch (cue) {
        case 'click':
          this.tone(1180, 0.045, 0.5, 'triangle');
          break;
        case 'select':
          this.tone(680, 0.09, 0.7, 'sine');
          this.tone(1020, 0.12, 0.45, 'sine', 0.05);
          break;
        case 'state':
          this.tone(520, 0.1, 0.4, 'sine');
          break;
        case 'anomaly':
          // Two-tone alert: deliberately the loudest cue in the set.
          this.tone(340, 0.19, 1.5, 'square', 0);
          this.tone(255, 0.24, 1.4, 'square', 0.2);
          this.noise(0.18, 0.35);
          break;
        case 'recovery':
          this.tone(520, 0.1, 0.65, 'sine', 0);
          this.tone(700, 0.1, 0.65, 'sine', 0.09);
          this.tone(880, 0.18, 0.7, 'sine', 0.18);
          break;
      }
    } catch (err) {
      console.warn('[audio] cue failed', err);
    }
  }

  /**
   * One enveloped oscillator.
   * Exponential ramps are used because gain.value = 0 is not a legal target
   * for exponentialRampToValueAtTime - hence the 0.0001 floor.
   */
  private tone(
    frequency: number,
    duration: number,
    gainValue: number,
    type: OscillatorType,
    delay = 0,
  ): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /** Short filtered noise burst - gives the anomaly cue some texture. */
  private noise(duration: number, gainValue: number): void {
    const ctx = this.ctx!;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x9e37;
    for (let i = 0; i < frames; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x3fffffff - 1) * (1 - i / frames);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    src.connect(filter).connect(gain).connect(this.master!);
    src.start();
  }

  dispose(): void {
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.master = null;
  }
}

export const synth = new Synth();
