// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Pure simulation-time pause plans and production takt controllers. */
import type { ClockHandle, SimClock } from './sim-clock';
import { copyHandle, validHandle, integer, validateShape } from './source-state';
// plan-2051: the seeded DES PRNG + its exponential draw (a pure leaf module, no kernel dependency).
import { exponential, type RngStream, type RngStreamState } from '../../rv-rng-distribution';

export interface PausePlan {
  everySec: number;
  durationSec: number;
  offsetSec: number[];
}

export interface TaktPlan {
  intervalSec: number;
  phaseSec: number[];
  intervalPerOutput?: number[];
  /**
   * Stochastic takt (plan-2051): when true AND a seeded RNG is set on the
   * {@link TaktSource}, every interval after a release is drawn from an
   * exponential distribution with mean {@link intervalOf} (Poisson releases,
   * clamped to >= 0.001 s) instead of the fixed value. The first release stays at
   * its phase. Default false / no RNG = the fixed takt, unchanged.
   */
  stochastic?: boolean;
}

export type RngFactory = (purpose: string) => RngStream;

const EPS = 1e-9;

/** Start of pause cycle k of input `i`. */
function pauseStart(p: PausePlan, i: number, k: number): number {
  return p.offsetSec[i] + k * p.everySec;
}

/** True when shipping input `i` is paused at `t`. */
export function isPaused(p: PausePlan, i: number, t: number): boolean {
  const off = p.offsetSec[i];
  if (off === undefined || p.durationSec <= 0 || t < off - EPS) return false;
  const k = Math.floor((t - off + EPS) / p.everySec);
  const start = pauseStart(p, i, k);
  return t >= start - EPS && t < start + p.durationSec - EPS;
}

/** Next instant strictly after `t` at which input `i` changes between running and paused. */
export function nextChangeOf(p: PausePlan, i: number, t: number): number {
  const off = p.offsetSec[i];
  if (off === undefined || p.durationSec <= 0) return Infinity;
  if (t < off - EPS) return off;
  const k = Math.floor((t - off + EPS) / p.everySec);
  const start = pauseStart(p, i, k);
  const end = start + p.durationSec;
  if (t < end - EPS) return end;
  return pauseStart(p, i, k + 1);
}

/** Next change of ANY input strictly after `t`, and which inputs change then. */
export function nextChange(p: PausePlan, t: number): { at: number; inputs: number[] } {
  let at = Infinity;
  const inputs: number[] = [];
  for (let i = 0; i < p.offsetSec.length; i++) {
    const c = nextChangeOf(p, i, t);
    if (c < at - EPS) { at = c; inputs.length = 0; inputs.push(i); } else if (Math.abs(c - at) <= EPS) inputs.push(i);
  }
  return { at, inputs };
}

/**
 * Takt interval of output `i` (s): its own (`intervalPerOutput`, plan-630 §2.13 —
 * the load per output) else the common one. `Infinity` = the output is DISABLED
 * (0 pallets/h).
 */
export function intervalOf(p: TaktPlan, i: number): number {
  return p.intervalPerOutput?.[i] ?? p.intervalSec;
}

/**
 * Planned release instant of output `i`: its phase first, then `last + interval`.
 * A {@link TaktPlan.stochastic} plan with an `rng` draws the interval
 * (`exponential(rng, intervalOf(p, i))`, one draw per call); otherwise it is the
 * fixed {@link intervalOf} — exactly the deterministic takt.
 */
export function nextRelease(p: TaktPlan, i: number, lastReleaseAt: number | null, rng: RngStream | null = null): number {
  if (lastReleaseAt === null) return p.phaseSec[i] ?? 0;
  const interval = intervalOf(p, i);
  if (p.stochastic && rng && Number.isFinite(interval)) return lastReleaseAt + exponential(rng, interval);
  return lastReleaseAt + interval;
}

/** Takt controller state of one production output (pure reducer, see module doc). */
export interface TaktState {
  readonly output: number;
  /** Next due instant, or null while BLOCKED (waiting for a free head) or DISABLED. */
  nextAt: number | null;
  blocked: boolean;
  /**
   * 0 pallets/h (plan-630 §2.13, Gate R1 #6): BOTH release paths are shut — the
   * planned takt and the release when a blocked head frees. A takt that was
   * blocked when the output was disabled is dropped.
   */
  disabled: boolean;
  blockedCount: number;
  released: number;
  lastReleaseAt: number | null;
}

const isDisabled = (p: TaktPlan, i: number): boolean => !Number.isFinite(intervalOf(p, i));

export function createTakt(p: TaktPlan, output: number): TaktState {
  const disabled = isDisabled(p, output);
  return { output, nextAt: disabled ? null : nextRelease(p, output, null), blocked: false, disabled, blockedCount: 0, released: 0, lastReleaseAt: null };
}

/**
 * The interval of the output changed while running (a live load change, plan-630
 * §2.13): re-base on the last release — `nextAt = max(t, lastReleaseAt + interval)`
 * (or the phase before the first release). Disabled → no takt at all, a blocked
 * one is dropped; enabled again → exactly one next instant from `t` on. A
 * blocked output stays blocked (it releases when its head frees). A stochastic
 * plan (`rng` set) draws a fresh interval for the re-based instant.
 */
export function retimeTakt(s: TaktState, p: TaktPlan, t: number, rng: RngStream | null = null): void {
  if (isDisabled(p, s.output)) {
    s.disabled = true;
    s.blocked = false;
    s.nextAt = null;
    return;
  }
  s.disabled = false;
  if (s.blocked) return;
  s.nextAt = Math.max(t, nextRelease(p, s.output, s.lastReleaseAt, rng));
}

function release(s: TaktState, p: TaktPlan, t: number, rng: RngStream | null): void {
  s.released++;
  s.lastReleaseAt = t;
  s.blocked = false;
  s.nextAt = nextRelease(p, s.output, t, rng);
}

/**
 * The due instant `nextAt` has come (`t`). Returns true when ONE pallet is to be
 * produced now (the head is free); otherwise the output turns BLOCKED.
 */
export function taktDue(s: TaktState, p: TaktPlan, t: number, headFree: boolean, rng: RngStream | null = null): boolean {
  if (s.disabled || s.blocked || s.nextAt === null || t < s.nextAt - EPS) return false;
  if (headFree) { release(s, p, t, rng); return true; }
  s.blocked = true;
  s.blockedCount++;
  s.nextAt = null;
  return false;
}

/** The head became free at `t`: a BLOCKED output releases at once (true), the takt re-bases. */
export function taktHeadFree(s: TaktState, p: TaktPlan, t: number, rng: RngStream | null = null): boolean {
  if (!s.blocked || s.disabled) return false;
  release(s, p, t, rng);
  return true;
}

/** Back to the start state (reset / new run). */
export function resetTakt(s: TaktState, p: TaktPlan): void {
  s.disabled = isDisabled(p, s.output);
  s.nextAt = s.disabled ? null : nextRelease(p, s.output, null);
  s.blocked = false;
  s.blockedCount = 0;
  s.released = 0;
  s.lastReleaseAt = null;
}


export interface TaktHooks {
  headFree(i: number): boolean;
  release(i: number): void;
  blocked(i: number): void;
}

/** Clock-driven takt; the caller owns production and its counters. */
export class TaktSource {
  states: readonly TaktState[];
  private handles: (ClockHandle | null)[];
  private generation = 0;
  private readonly rngs: (RngStream | null)[] = [];
  /** State of each output stream when it was set — the start of every run's stream. */
  private readonly rngStart: (RngStreamState | null)[] = [];

  constructor(
    private readonly clock: SimClock,
    private readonly plan: TaktPlan,
    private readonly count: number,
    private readonly hooks: TaktHooks,
    rng: RngStream | RngFactory | null = null,
    private readonly outputIds?: readonly string[],
  ) {
    this.states = Array.from({ length: count }, (_, i) => createTakt(plan, i));
    this.handles = Array.from({ length: count }, () => null);
    this.setRng(rng);
    clock.registerAction('fleet.takt.arm', data => {
      const { i, g } = data as { i: number; g: number };
      if (g !== this.generation) return;
      const st = this.states[i];
      this.handles[i] = null;
      if (taktDue(st, this.plan, this.clock.now(), this.hooks.headFree(i), this.rngs[i])) {
        this.hooks.release(i);
      } else if (st.blocked) this.hooks.blocked(i);
      this.arm(i);
    });
  }

  exportState(): TaktSourceState {
    return { states: this.states.map(s => ({ ...s })), handles: this.handles.map(copyHandle),
      generation: this.generation,
      rng: this.rngs.map(r => r ? cloneStreamState(r.getState()) : null),
      rngStart: this.rngStart.map(r => r ? cloneStreamState(r) : null) };
  }

  validateState(value: unknown): string[] {
    const errors = validateShape(value, { states: [{ ...createTakt(this.plan, 0), nextAt: null, lastReleaseAt: null }], handles: [null], generation: 0, rng: [null], rngStart: [null] });
    const s = value as TaktSourceState;
    if (errors.length) return errors;
    if (!integer(s.generation) || s.states.length !== this.count || s.handles.length !== this.count)
      errors.push('takt: invalid generation or output count');
    s.states.forEach((v, i) => {
      if ([v.nextAt, v.lastReleaseAt].some(n => n !== null && (typeof n !== 'number' || !Number.isFinite(n))) || v.output !== i || !integer(v.released) || !integer(v.blockedCount)) errors.push('takt: invalid output or counters');
    });
    for (const h of s.handles) if (!validHandle(h)) errors.push('takt: invalid handle');
    for (const r of [s.rng, s.rngStart]) {
      if (r.length !== this.count) errors.push('takt: invalid RNG count');
      for (const st of r) if (st !== null && !validStreamState(st)) errors.push('takt: invalid RNG');
    }
    for (let i = 0; i < this.count; i++) if ((s.rng[i] === null) !== (s.rngStart[i] === null)) errors.push('takt: inconsistent RNG');
    return errors;
  }

  prepareState(value: unknown): PreparedTaktSource {
    const errors = this.validateState(value);
    if (errors.length) throw new Error(errors.join('; '));
    const s = structuredClone(value as TaktSourceState);
    return s;
  }

  swapState(s: PreparedTaktSource): void {
    this.states = s.states;
    this.handles = s.handles;
    this.generation = s.generation;
    // The stream objects stay (bound by the owner); their positions come from the snapshot.
    for (let i = 0; i < this.count; i++) {
      const st = s.rng[i];
      if (st) this.rngs[i]?.setState(st);
      this.rngStart[i] = s.rngStart[i];
    }
  }

  /**
   * The seeded RNG a {@link TaktPlan.stochastic} plan draws its intervals from
   * (plan-2051; null = fixed takt). Its state at this call is the start of every
   * run: {@link start} rewinds to it, so a restart without reconstruction
   * (engine reset, clock restart) replays the same stream — same seed,
   * bit-identical releases. The owner sets a freshly derived RNG on every bind.
   */
  setRng(rng: RngStream | RngFactory | null): void {
    for (let i = 0; i < this.count; i++) {
      const stream = typeof rng === 'function' ? rng('takt:' + (this.outputIds?.[i] ?? String(i))) : rng;
      this.rngs[i] = stream;
      this.rngStart[i] = stream ? stream.getState() : null;
    }
  }

  /** The caller resets the clock before starting a new run. */
  start(): void {
    this.generation++;
    for (let i = 0; i < this.count; i++) {
      const stream = this.rngs[i];
      const state = this.rngStart[i];
      if (stream && state) stream.setState(state);
    }
    for (let i = 0; i < this.count; i++) {
      resetTakt(this.states[i], this.plan);
      this.handles[i] = null;
      this.arm(i);
    }
  }

  headFreed(i: number): void {
    if (taktHeadFree(this.states[i], this.plan, this.clock.now(), this.rngs[i])) {
      this.hooks.release(i);
      this.arm(i);
    }
  }

  retime(i: number): void {
    retimeTakt(this.states[i], this.plan, this.clock.now(), this.rngs[i]);
    this.arm(i);
  }

  stop(): void {
    this.generation++;
  }

  private arm(i: number): void {
    const st = this.states[i];
    this.clock.cancel(this.handles[i]);
    this.handles[i] = null;
    if (st.nextAt === null) return; // blocked — released by headFreed
    const g = this.generation;
    this.handles[i] = this.clock.scheduleAction(st.nextAt, 'fleet.takt.arm', { i, g });
  }
}

export interface PauseHooks {
  setRun(i: number, run: boolean): void;
  wake(i: number): void;
  resumed(i: number): void;
}

/** Clock-driven pauses; stale chains stay queued but have no effects. */
export class PauseSource {
  private generation = 0;

  constructor(
    private readonly clock: SimClock,
    private readonly plan: PausePlan,
    private readonly count: number,
    private readonly hooks: PauseHooks,
  ) {
    clock.registerAction('fleet.pause.arm', data => {
      const { i, g } = data as { i: number; g: number };
      if (g !== this.generation) return;
      const run = !isPaused(this.plan, i, this.clock.now());
      this.hooks.setRun(i, run);
      if (run) { this.hooks.wake(i); this.hooks.resumed(i); }
      this.arm(i);
    });
  }

  exportState(): { generation: number } { return { generation: this.generation }; }
  validateState(value: unknown): string[] {
    const errors = validateShape(value, { generation: 0 });
    if (!integer((value as { generation?: unknown } | null)?.generation)) errors.push('pause: invalid generation');
    return errors;
  }
  prepareState(value: unknown): { generation: number } {
    const errors = this.validateState(value);
    if (errors.length) throw new Error(errors.join('; '));
    return { generation: (value as { generation: number }).generation };
  }
  swapState(s: { generation: number }): void { this.generation = s.generation; }

  start(): void {
    this.generation++;
    for (let i = 0; i < this.count; i++) this.arm(i, true);
  }

  replan(): void {
    this.generation++;
    const now = this.clock.now();
    for (let i = 0; i < this.count; i++) {
      const run = !isPaused(this.plan, i, now);
      this.hooks.setRun(i, run);
      if (run) this.hooks.wake(i);
      this.arm(i);
    }
  }

  paused(i: number, t: number): boolean {
    return isPaused(this.plan, i, t);
  }

  stop(): void {
    this.generation++;
  }

  private arm(i: number, initial = false): void {
    const p = this.plan;
    const now = this.clock.now();
    if (initial) this.hooks.setRun(i, !isPaused(p, i, now));
    const at = nextChangeOf(p, i, now);
    if (!Number.isFinite(at)) return;
    const g = this.generation;
    this.clock.scheduleAction(at, 'fleet.pause.arm', { i, g });
  }
}

export interface TaktSourceState {
  states: TaktState[]; handles: (ClockHandle | null)[]; generation: number;
  /** Per output: current stream state / state when the stream was bound (null = fixed takt). */
  rng: (RngStreamState | null)[]; rngStart: (RngStreamState | null)[];
}
export type PreparedTaktSource = TaktSourceState;

const u32 = (n: unknown): boolean => integer(n) && (n as number) <= 0xffffffff;
function validStreamState(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 4 && v.every(u32);
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).sort().join(',') === 'a,b,c,counter' && [o.a, o.b, o.c, o.counter].every(u32);
}
function cloneStreamState(v: RngStreamState): RngStreamState {
  return (Array.isArray(v) ? [...v] : { ...v }) as RngStreamState;
}
