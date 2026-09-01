// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _smooth-motion-fakes.ts — a deterministic in-memory {@link SmoothMotionProvider}
 * for the PUBLIC port tests (plan-281 Phase 4).
 *
 * This is NOT a smooth-motion implementation and must never become one: the
 * jerk-limited S-curve exists exactly once, in the Rust core (plan-281
 * Alternative 2). The fake models trapezoid-free constant-velocity travel — just
 * enough to make a drive move, finish and brake — and its real job is to RECORD
 * what the host asked for, so the public tests can assert the protocol (create
 * once, configure with the drive's own limits, replan on a new command, one
 * `stepInto` per tick into the caller's snapshot, destroy on teardown) in a
 * build that has no access to the commercial artifact.
 *
 * NOTE: this file must not import anything from `@rv-private` — the generated
 * private-test-exclude list scans test files, not their helpers, so a private
 * import here would break the community build without being detected.
 */

import {
  SMOOTH_INVALID_HANDLE,
  SMOOTH_INVALID_LIMITS,
  SMOOTH_MOTION_ABI_VERSION,
  SMOOTH_OK,
  OUTCOME_ALREADY_AT_TARGET,
  OUTCOME_REACHED_REQUESTED_TARGET,
  type MotionSnapshot,
  type MotionState,
  type MotionStatus,
  type SmoothMotionProvider,
} from '../src/core/engine/rv-smooth-motion-port';

interface FakeContext {
  vmax: number;
  amax: number;
  jmax: number;
  startPos: number;
  pos: number;
  vel: number;
  acc: number;
  dir: number;
  requested: number;
  effective: number;
  elapsed: number;
  duration: number;
  finished: boolean;
}

/** One recorded host→core call. */
export interface FakeCall {
  op: string;
  handle: number;
  args: number[];
}

export class FakeSmoothMotionProvider implements SmoothMotionProvider {
  readonly abiVersion = SMOOTH_MOTION_ABI_VERSION;
  readonly calls: FakeCall[] = [];

  private readonly contexts = new Map<number, FakeContext>();
  private nextHandle = 1;
  createCount = 0;
  destroyCount = 0;

  get liveContexts(): number { return this.contexts.size; }

  /** Calls of one kind, in order. */
  opsOf(op: string): FakeCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  create(): number {
    const handle = this.nextHandle++;
    this.contexts.set(handle, {
      vmax: 0, amax: 0, jmax: 0,
      startPos: 0, pos: 0, vel: 0, acc: 0, dir: 0,
      requested: 0, effective: 0, elapsed: 0, duration: 0, finished: true,
    });
    this.createCount++;
    this.calls.push({ op: 'create', handle, args: [] });
    return handle;
  }

  destroy(handle: number): void {
    if (this.contexts.delete(handle)) this.destroyCount++;
    this.calls.push({ op: 'destroy', handle, args: [] });
  }

  configure(handle: number, vmax: number, amax: number, jerk: number): MotionStatus {
    this.calls.push({ op: 'configure', handle, args: [vmax, amax, jerk] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    const positiveFinite = (v: number) => Number.isFinite(v) && v > 0;
    if (!positiveFinite(vmax) || !positiveFinite(amax) || !positiveFinite(jerk)) {
      return SMOOTH_INVALID_LIMITS;
    }
    ctx.vmax = vmax; ctx.amax = amax; ctx.jmax = jerk;
    return SMOOTH_OK;
  }

  setState(handle: number, state: MotionState): MotionStatus {
    this.calls.push({ op: 'setState', handle, args: [state.position, state.velocity, state.acceleration] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    ctx.pos = state.position; ctx.vel = state.velocity; ctx.acc = state.acceleration;
    return SMOOTH_OK;
  }

  setTarget(handle: number, position: number, velocity: number, out: MotionSnapshot): MotionStatus {
    this.calls.push({ op: 'setTarget', handle, args: [position, velocity] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    if (ctx.vmax <= 0) return SMOOTH_INVALID_LIMITS;
    const distance = position - ctx.pos;
    ctx.startPos = ctx.pos;
    ctx.dir = Math.sign(distance);
    ctx.requested = position;
    ctx.effective = position;
    ctx.duration = Math.abs(distance) / ctx.vmax;
    ctx.elapsed = 0;
    ctx.finished = ctx.duration === 0;
    ctx.vel = ctx.finished ? 0 : ctx.dir * ctx.vmax;
    this.write(ctx, out);
    return SMOOTH_OK;
  }

  adjustDuration(handle: number, duration: number): MotionStatus {
    this.calls.push({ op: 'adjustDuration', handle, args: [duration] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    ctx.duration = Math.max(ctx.duration, duration); // F15: never faster than the limits allow
    return SMOOTH_OK;
  }

  stepInto(handle: number, dt: number, speedOverride: number, out: MotionSnapshot): MotionStatus {
    this.calls.push({ op: 'stepInto', handle, args: [dt, speedOverride] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    ctx.elapsed = Math.min(ctx.duration, ctx.elapsed + dt * speedOverride);
    const travelled = ctx.dir * ctx.vmax * ctx.elapsed;
    ctx.finished = ctx.elapsed >= ctx.duration;
    ctx.pos = ctx.finished ? ctx.effective : ctx.startPos + travelled;
    ctx.vel = ctx.finished ? 0 : ctx.dir * ctx.vmax;
    this.write(ctx, out);
    return SMOOTH_OK;
  }

  rebase(handle: number, state: MotionState): MotionStatus {
    this.calls.push({ op: 'rebase', handle, args: [state.position, state.velocity, state.acceleration] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    // Plan a constant-deceleration stop, mirroring the core's rebase contract.
    const stopDistance = ctx.amax > 0 ? (state.velocity * state.velocity) / (2 * ctx.amax) : 0;
    ctx.dir = Math.sign(state.velocity);
    ctx.startPos = state.position;
    ctx.pos = state.position;
    ctx.vel = state.velocity;
    ctx.acc = 0;
    ctx.requested = state.position;
    ctx.effective = state.position + ctx.dir * stopDistance;
    ctx.duration = ctx.amax > 0 ? Math.abs(state.velocity) / ctx.amax : 0;
    ctx.elapsed = 0;
    ctx.finished = ctx.duration === 0;
    return SMOOTH_OK;
  }

  shiftPosition(handle: number, delta: number): MotionStatus {
    this.calls.push({ op: 'shiftPosition', handle, args: [delta] });
    const ctx = this.contexts.get(handle);
    if (!ctx) return SMOOTH_INVALID_HANDLE;
    ctx.startPos += delta;
    ctx.pos += delta;
    ctx.requested += delta;
    ctx.effective += delta;
    return SMOOTH_OK;
  }

  private write(ctx: FakeContext, out: MotionSnapshot): void {
    // The linear model decelerates only inside `rebase`, so the braking point of
    // a travel profile is its end — enough for the host's re-arm arithmetic.
    out.position = ctx.pos;
    out.velocity = ctx.vel;
    out.acceleration = ctx.acc;
    out.requestedTarget = ctx.requested;
    out.effectiveTarget = ctx.effective;
    out.duration = ctx.duration;
    out.elapsed = ctx.elapsed;
    out.decelerationStart = ctx.duration;
    out.phaseCount = ctx.finished ? 0 : 1;
    out.outcome = ctx.duration === 0 ? OUTCOME_ALREADY_AT_TARGET : OUTCOME_REACHED_REQUESTED_TARGET;
    out.finished = ctx.finished;
    out.status = SMOOTH_OK;
  }
}
