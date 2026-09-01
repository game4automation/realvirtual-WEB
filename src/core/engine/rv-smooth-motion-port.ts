// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-smooth-motion-port.ts — Public interface + registry for jerk-limited
 * ("smooth") drive motion (plan-281 §2.6, Phase 4).
 *
 * WHAT LIVES HERE — and what deliberately does not:
 *
 * The numerical core is a PROTECTED, closed-source artifact (Rust →
 * `rv_smooth_motion.wasm`, crate `realvirtualReleaseDLLs/rv-smooth-motion`) that
 * ships only in licensed builds. Unity consumes the very same crate as a native
 * DLL, so the 7-segment S-curve exists exactly once (plan-281 E1/E3). This file
 * therefore contains the PORT ONLY: types, the ABI contract, a registry and the
 * fallback rule. There is NO solver mathematics in the public repo and there
 * must never be a TypeScript re-implementation of the S-curve (plan-281
 * Alternative 2, "verworfen" — a second numeric truth is the exact drift this
 * whole plan removes).
 *
 * FALLBACK CONTRACT (G0, plan-281 §0):
 * Without a registered provider a drive that asks for `SmoothAcceleration`
 * keeps running the well-known trapezoidal ramp (`computeRampedSpeed` in
 * rv-drive.ts) and the viewer emits exactly ONE degradation warning per loaded
 * model — not one per drive and not one per tick. The community build stays
 * fully functional; it just does not get jerk limiting.
 *
 * READY GATE (plan-281 Finding #14):
 * The IK provider loads fire-and-forget, which is tolerable there (a robot that
 * starts in replay mode can switch later). Smooth motion cannot work that way:
 * the backend must never change mid-profile (G0.3), so the decision
 * "rust or trapezoid" has to be settled BEFORE the first drive is constructed.
 * The private side calls {@link SmoothMotionRegistry.expect} synchronously while
 * registering and resolves the gate with `register()`/`fail()`; the application
 * awaits {@link SmoothMotionRegistry.whenReady} before `loadModel`.
 */

/** ABI version this host speaks. Must equal `rv_smooth_abi_version()`. */
export const SMOOTH_MOTION_ABI_VERSION = 1;

// ── Status codes (crate ABI.md, identical on native and WASM) ──────────────
export const SMOOTH_OK = 0;
export const SMOOTH_INVALID_HANDLE = -1;
export const SMOOTH_INVALID_ARGUMENT = -2;
export const SMOOTH_INVALID_LIMITS = -3;
export const SMOOTH_INVALID_STATE = -4;
export const SMOOTH_ABI_MISMATCH = -5;
export const SMOOTH_PANIC = -100;

/** One of the `SMOOTH_*` status codes. `0` is the only success value. */
export type MotionStatus = number;

/** Human-readable status, for warnings and findings. */
export function smoothStatusText(status: MotionStatus): string {
  switch (status) {
    case SMOOTH_OK: return 'ok';
    case SMOOTH_INVALID_HANDLE: return 'invalid handle';
    case SMOOTH_INVALID_ARGUMENT: return 'invalid argument (NaN/Infinity or out of range)';
    case SMOOTH_INVALID_LIMITS: return 'invalid limits (vmax/amax/jerk must be finite and > 0)';
    case SMOOTH_INVALID_STATE: return 'invalid state';
    case SMOOTH_ABI_MISMATCH: return 'ABI mismatch';
    case SMOOTH_PANIC: return 'core panic / wasm trap';
    default: return `unknown status ${status}`;
  }
}

// ── PlanOutcome (snapshot `outcome`, crate ABI.md) ─────────────────────────
/** The requested target is reachable and the profile ends exactly there. */
export const OUTCOME_REACHED_REQUESTED_TARGET = 0;
/**
 * The requested target is NOT reachable without violating the limits (the
 * braking distance already exceeds the remaining distance). The profile ends at
 * the earliest physically reachable stop instead — plan-281 F2. Hosts must use
 * `effectiveTarget`, never `requestedTarget`, for crossing/at-target logic (F4).
 */
export const OUTCOME_STOPPED_AT_EARLIEST_REACHABLE = 1;
/** Already at the target within the endpoint tolerance; nothing to do. */
export const OUTCOME_ALREADY_AT_TARGET = 2;

/** Position/velocity/acceleration triple in the drive's own unit system. */
export interface MotionState {
  position: number;
  velocity: number;
  acceleration: number;
}

/**
 * Mutable mirror of the core's `RvMotionSnapshot` (crate ABI.md, sizeof 80).
 *
 * Deliberately a PLAIN MUTABLE OBJECT that the host allocates once and the
 * provider overwrites in place: `stepInto` runs for every smooth drive on every
 * fixed tick, and an object (or array, or JSON) per tick would put the whole
 * drive population into the GC's young generation (plan-281 NFR "Hot Path:
 * keine Heap-Allokation").
 */
export interface MotionSnapshot {
  position: number;
  velocity: number;
  acceleration: number;
  /** What the host asked for. */
  requestedTarget: number;
  /** Where the profile actually ends — see {@link OUTCOME_STOPPED_AT_EARLIEST_REACHABLE}. */
  effectiveTarget: number;
  /** Nominal profile duration in seconds (before speed override). */
  duration: number;
  /** Profile time consumed so far in seconds. */
  elapsed: number;
  /** Profile time at which the braking phase starts, in seconds. */
  decelerationStart: number;
  phaseCount: number;
  /** One of the `OUTCOME_*` constants. */
  outcome: number;
  /** True once the profile has run to its end. */
  finished: boolean;
  /** Status of the call that produced this snapshot. */
  status: MotionStatus;
}

/** Allocate one reusable snapshot. Call once per drive, never per tick. */
export function createMotionSnapshot(): MotionSnapshot {
  return {
    position: 0,
    velocity: 0,
    acceleration: 0,
    requestedTarget: 0,
    effectiveTarget: 0,
    duration: 0,
    elapsed: 0,
    decelerationStart: 0,
    phaseCount: 0,
    outcome: OUTCOME_ALREADY_AT_TARGET,
    finished: true,
    status: SMOOTH_OK,
  };
}

/** Allocate one reusable state scratch. Call once per drive, never per tick. */
export function createMotionState(): MotionState {
  return { position: 0, velocity: 0, acceleration: 0 };
}

/**
 * The commercial smooth-motion core, as the public engine sees it.
 *
 * Implemented ONLY on the private side (`realvirtual-WebViewer-Private~/src/
 * smooth-motion/rv-smooth-motion-provider.ts`) over the raw WASM ABI. Handles
 * are the core's generational `u32` ids; `0` is always invalid.
 *
 * DEVIATION from the plan's literal sketch (§2.6), deliberate and documented:
 * `setTarget` there returns a `MotionSnapshot`. Here it takes the caller's
 * snapshot as an out-parameter and returns the status instead, so a replan
 * reuses the drive's single snapshot object and there is exactly one snapshot
 * shape in the system. Same reasoning as `stepInto`.
 */
export interface SmoothMotionProvider {
  /** `rv_smooth_abi_version()` of the loaded artifact. */
  readonly abiVersion: number;
  /** Number of contexts created but not yet destroyed — leak assertions. */
  readonly liveContexts?: number;

  /** Create a motion context. Returns the handle, or `0` on failure. */
  create(): number;
  /** Release a context. Safe to call with a stale handle (no-op). */
  destroy(handle: number): void;
  /** Set the kinematic limits. All three must be finite and > 0. */
  configure(handle: number, vmax: number, amax: number, jerk: number): MotionStatus;
  /** Overwrite the current state WITHOUT planning (use before `setTarget`). */
  setState(handle: number, state: MotionState): MotionStatus;
  /** Plan a profile to `position` ending at `velocity`; fills `out`. */
  setTarget(handle: number, position: number, velocity: number, out: MotionSnapshot): MotionStatus;
  /**
   * Stretch the freshly planned profile to `duration` seconds (Unity's
   * `DriveTo(target, time)`). Clamped to the physically minimal duration —
   * limits are never violated (plan-281 F15).
   */
  adjustDuration(handle: number, duration: number): MotionStatus;
  /**
   * Advance the profile by `dt · speedOverride` and write the resulting state
   * into `out`. The ONLY call on the hot path; allocates nothing.
   */
  stepInto(handle: number, dt: number, speedOverride: number, out: MotionSnapshot): MotionStatus;
  /**
   * Set the authoritative state and plan a continuous stop from it. This is the
   * host's answer to every discontinuous external position change: hard limit
   * clamp, raycast correction, reset, return from PositionOverwrite/ownership
   * (plan-281 §2.7).
   */
  rebase(handle: number, state: MotionState): MotionStatus;
  /**
   * Shift state, profile and effective target by `delta` in one atomic step —
   * the drive wrap-around (`JumpToLowerLimitOnUpperLimit`). Time and velocity
   * are preserved, so the motion continues seamlessly across the seam.
   */
  shiftPosition(handle: number, delta: number): MotionStatus;
  /** Discard ALL core state (used by tests / a hard teardown). */
  resetAll?(): MotionStatus;
}

/** State of the load gate. */
export type SmoothMotionGateState = 'idle' | 'pending' | 'ready' | 'failed';

/**
 * Module-singleton registry. The public engine only ever talks to this object;
 * it never imports anything from the private tree (G0: public must not reference
 * private, the wiring happens at runtime exactly like the IK solver's).
 */
class SmoothMotionRegistry {
  private _provider: SmoothMotionProvider | null = null;
  private _state: SmoothMotionGateState = 'idle';
  private _detail = '';
  private _gate: Promise<boolean> | null = null;
  private _settle: ((ready: boolean) => void) | null = null;

  /** The registered provider, or null in a build without one. */
  get provider(): SmoothMotionProvider | null {
    return this._provider;
  }

  /** True when a provider is registered and its ABI matches. */
  get available(): boolean {
    return this._provider !== null;
  }

  /** ABI version of the registered provider, or 0 when there is none. */
  get abiVersion(): number {
    return this._provider?.abiVersion ?? 0;
  }

  get state(): SmoothMotionGateState {
    return this._state;
  }

  /** Why the gate failed (empty unless `state === 'failed'`). */
  get failureDetail(): string {
    return this._detail;
  }

  /**
   * Announce that a provider load has STARTED. Must be called synchronously by
   * the private registration so `whenReady()` cannot resolve `false` in the
   * window between "registration began" and "wasm finished loading".
   */
  expect(): void {
    if (this._state === 'ready') return;
    this._state = 'pending';
    this._detail = '';
    if (!this._gate) {
      this._gate = new Promise<boolean>((resolve) => { this._settle = resolve; });
    }
  }

  /** Publish a loaded, ABI-checked provider and open the gate. */
  register(provider: SmoothMotionProvider): void {
    this._provider = provider;
    this._state = 'ready';
    this._detail = '';
    this._settle?.(true);
    this._settle = null;
    this._gate = Promise.resolve(true);
  }

  /**
   * Close the gate as failed — no provider, the trapezoidal fallback owns every
   * drive from here on. Never throws: every caller's reaction is identical.
   */
  fail(detail: string): void {
    this._provider = null;
    this._state = 'failed';
    this._detail = detail;
    this._settle?.(false);
    this._settle = null;
    this._gate = Promise.resolve(false);
  }

  /**
   * Awaited by the application BEFORE the first `loadModel` (Finding #14).
   * Resolves `true` when a provider is available, `false` when the build has
   * none or the load failed. Never rejects and never blocks a build that never
   * called `expect()` — the community build resolves immediately.
   */
  whenReady(): Promise<boolean> {
    if (this._state === 'ready') return Promise.resolve(true);
    if (this._state === 'idle' || this._state === 'failed') return Promise.resolve(false);
    return this._gate ?? Promise.resolve(false);
  }

  /** Drop provider and gate (tests, and a full viewer teardown). */
  reset(): void {
    this._provider = null;
    this._state = 'idle';
    this._detail = '';
    this._settle?.(false);
    this._settle = null;
    this._gate = null;
  }
}

/** The one registry instance. */
export const smoothMotionRegistry = new SmoothMotionRegistry();

// ── Degradation warning: exactly once per model ────────────────────────────

let degradationWarned = false;

/**
 * Warn ONCE per loaded model that smooth motion degraded to the trapezoidal
 * ramp. Called by every smooth-requesting drive; only the first one speaks, so a
 * 500-drive model produces one line, not five hundred (plan-281 G0.1).
 */
export function warnSmoothMotionDegraded(driveName: string): void {
  if (degradationWarned) return;
  degradationWarned = true;
  const reason = smoothMotionRegistry.state === 'failed'
    ? `provider failed to load: ${smoothMotionRegistry.failureDetail}`
    : 'no smooth-motion provider in this build';
  console.warn(
    `[smooth-motion] "${driveName}" requests SmoothAcceleration but ${reason} — `
    + 'falling back to the trapezoidal acceleration ramp for every drive in this model. '
    + 'Jerk limiting is a licensed feature.',
  );
}

/** Re-arm the once-per-model warning. Called from `clearModel()`. */
export function resetSmoothMotionDegradation(): void {
  degradationWarned = false;
}

/** True when the once-per-model warning has already been emitted (tests). */
export function hasWarnedSmoothMotionDegraded(): boolean {
  return degradationWarned;
}
