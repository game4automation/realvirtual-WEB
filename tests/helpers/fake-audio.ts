// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * fake-audio.ts — a minimal Web Audio stand-in with counters (plan-2019 tests).
 *
 * Implements exactly what `src/core/audio/*` uses: gain / oscillator / biquad /
 * buffer source / panner / periodic wave / buffer nodes, AudioParam automation
 * (recorded, `value` jumps to the target), the listener, and the context
 * lifecycle (`resume` / `suspend` / `close`). `currentTime` is driven by the test.
 */

export class FakeParam {
  value: number;
  readonly calls: { method: string; value: number; time: number; arg?: number }[] = [];
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v: number, t: number): this { this.value = v; this.calls.push({ method: 'setValueAtTime', value: v, time: t }); return this; }
  linearRampToValueAtTime(v: number, t: number): this { this.value = v; this.calls.push({ method: 'linearRamp', value: v, time: t }); return this; }
  exponentialRampToValueAtTime(v: number, t: number): this { this.value = v; this.calls.push({ method: 'expRamp', value: v, time: t }); return this; }
  setTargetAtTime(v: number, t: number, tau: number): this { this.value = v; this.calls.push({ method: 'setTargetAtTime', value: v, time: t, arg: tau }); return this; }
  cancelScheduledValues(t: number): this { this.calls.push({ method: 'cancel', value: this.value, time: t }); return this; }
  /** Last call of a method, or undefined. */
  last(method: string): { method: string; value: number; time: number; arg?: number } | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i].method === method) return this.calls[i];
    return undefined;
  }
}

export class FakeNode {
  readonly connections: unknown[] = [];
  disconnected = false;
  constructor(readonly ctx: FakeAudioContext, readonly kind: string) {}
  connect<T>(dest: T): T { this.connections.push(dest); return dest; }
  disconnect(): void { this.disconnected = true; this.connections.length = 0; }
}

export class FakeGain extends FakeNode { readonly gain = new FakeParam(1); constructor(c: FakeAudioContext) { super(c, 'gain'); } }

export class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  started = false; stopped = false;
  wave: unknown = null;
  constructor(c: FakeAudioContext) { super(c, 'osc'); }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  setPeriodicWave(w: unknown): void { this.wave = w; }
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  constructor(c: FakeAudioContext) { super(c, 'biquad'); }
}

export class FakeBufferSource extends FakeNode {
  buffer: unknown = null; loop = false; started = false; stopped = false;
  constructor(c: FakeAudioContext) { super(c, 'bufsrc'); }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
}

export class FakePanner extends FakeNode {
  private _model = 'equalpower';
  distanceModel = 'inverse'; refDistance = 1; rolloffFactor = 1;
  readonly positionX = new FakeParam(0); readonly positionY = new FakeParam(0); readonly positionZ = new FakeParam(0);
  constructor(c: FakeAudioContext, private readonly hrtf: boolean) { super(c, 'panner'); }
  get panningModel(): string { return this._model; }
  set panningModel(v: string) { if (v === 'HRTF' && !this.hrtf) return; this._model = v; }
}

export class FakeBuffer {
  readonly data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { this.data = new Float32Array(length); }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(): Float32Array { return this.data; }
}

export class FakeListener {
  readonly positionX = new FakeParam(); readonly positionY = new FakeParam(); readonly positionZ = new FakeParam();
  readonly forwardX = new FakeParam(); readonly forwardY = new FakeParam(); readonly forwardZ = new FakeParam(-1);
  readonly upX = new FakeParam(); readonly upY = new FakeParam(1); readonly upZ = new FakeParam();
}

export interface FakeAudioCounters {
  oscillators: number; gains: number; panners: number; bufferSources: number; biquads: number; waves: number; buffers: number;
  resume: number; suspend: number; close: number;
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** HRTF supported by the fake panner (false → equalpower fallback). */
  static hrtf = true;
  /**
   * Lifecycle realism (fix round 1): with `delayed = true` every resume() / suspend()
   * stays pending until the test settles it (`settle(i)`, `settleAll()`), in any
   * order — the state changes only then, as in a browser.
   */
  static delayed = false;
  /** State of a newly created context (a browser starts one outside a gesture as suspended). */
  static initialState: 'suspended' | 'running' = 'running';
  /** The next n resume() calls reject (no user gesture). */
  static refuseResume = 0;
  state: 'suspended' | 'running' | 'closed' = FakeAudioContext.initialState;
  /** Pending transitions (delayed mode), in call order. */
  readonly pending: FakeTransition[] = [];
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = new FakeNode(this, 'destination');
  readonly listener = new FakeListener();
  readonly counters: FakeAudioCounters = {
    oscillators: 0, gains: 0, panners: 0, bufferSources: 0, biquads: 0, waves: 0, buffers: 0, resume: 0, suspend: 0, close: 0,
  };
  readonly gainNodes: FakeGain[] = [];
  readonly oscillatorNodes: FakeOscillator[] = [];
  readonly pannerNodes: FakePanner[] = [];

  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGain { this.counters.gains++; const g = new FakeGain(this); this.gainNodes.push(g); return g; }
  createOscillator(): FakeOscillator { this.counters.oscillators++; const o = new FakeOscillator(this); this.oscillatorNodes.push(o); return o; }
  createBiquadFilter(): FakeBiquad { this.counters.biquads++; return new FakeBiquad(this); }
  createBufferSource(): FakeBufferSource { this.counters.bufferSources++; return new FakeBufferSource(this); }
  createPanner(): FakePanner { this.counters.panners++; const p = new FakePanner(this, FakeAudioContext.hrtf); this.pannerNodes.push(p); return p; }
  createPeriodicWave(real: Float32Array, imag: Float32Array): { real: Float32Array; imag: Float32Array } { this.counters.waves++; return { real, imag }; }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer { this.counters.buffers++; return new FakeBuffer(ch, len, sr); }
  resume(): Promise<void> {
    this.counters.resume++;
    if (FakeAudioContext.refuseResume > 0) {
      FakeAudioContext.refuseResume--;
      return Promise.reject(new Error('NotAllowedError: no user gesture'));
    }
    return this._transition('resume', 'running');
  }
  suspend(): Promise<void> { this.counters.suspend++; return this._transition('suspend', 'suspended'); }
  close(): Promise<void> { this.counters.close++; this.state = 'closed'; return Promise.resolve(); }

  private _transition(op: 'resume' | 'suspend', target: 'running' | 'suspended'): Promise<void> {
    if (!FakeAudioContext.delayed) {
      if (this.state !== 'closed') this.state = target;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const t: FakeTransition = {
        op,
        settle: (ok = true) => {
          const i = this.pending.indexOf(t);
          if (i >= 0) this.pending.splice(i, 1);
          if (!ok) { reject(new Error('refused')); return; }
          if (this.state !== 'closed') this.state = target;
          resolve();
        },
      };
      this.pending.push(t);
    });
  }

  /** Settle the i-th pending transition (delayed mode). */
  settle(i = 0, ok = true): void { this.pending[i].settle(ok); }

  /** Settle pending transitions in call order until none is left (follow-ups included). */
  async settleAll(max = 20): Promise<void> {
    for (let n = 0; n < max && this.pending.length > 0; n++) {
      this.pending[0].settle();
      await flushMicrotasks();
    }
  }

  static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.hrtf = true;
    FakeAudioContext.delayed = false;
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.refuseResume = 0;
  }
}

/** One pending context transition of a delayed fake. */
export interface FakeTransition { op: 'resume' | 'suspend'; settle(ok?: boolean): void }

/** Let promise reactions run (several hops: settle → reconcile → next transition). */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Factory for `setAudioContextFactory` (cast to the DOM type the engine expects). */
export function fakeAudioFactory(sampleRate = 48000): () => AudioContext {
  return () => new FakeAudioContext(sampleRate) as unknown as AudioContext;
}
