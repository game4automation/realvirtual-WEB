// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * tween-registry.ts — the central sim-time interpolator (Plan 194 §3).
 *
 * Every DES duration event (a conveyor transit, a router rotation, a station
 * pick-place) registers ONE tween here. On each render the registry walks the
 * active tweens and interpolates them by SIMULATION time:
 *
 *   progress = clamp01((simNow − t0) / (t1 − t0))
 *
 * Because the progress is driven by `simNow` (not wall-clock), the HybridSynced
 * time-lapse falls out for free — when `simNow` advances N× faster, the MU moves
 * N× faster with no special case. This is exactly the C#-DES `DESMUMover`
 * principle (DESMUMover.cs:88, Plan 194 §9.2).
 *
 * Three tween flavours (Plan 194 §3.1, path added by plan-268 Phase 3):
 *   - position tween — `target.position.lerpVectors(from, to, p)` (straight
 *     translation; linear lerp is 1:1 to the continuous transport physics when
 *     `transitTime = length/speed`).
 *   - drive tween — `drive.setPosition(from + (to−from)·p)` (rotation/linear via
 *     the REAL drive, so the acceleration curve and visuals match the continuous
 *     path 1:1).
 *   - path tween — the ARC-LENGTH address `fromS → toS` (meters) is lerped and
 *     the position sampled from the path (`getAbsPosition`), so a curved transit
 *     renders ON the curve instead of cutting the chord (plan-268 §5.1 "DES
 *     schneidet Kurven ab"). When the sampler exposes a tangent
 *     (`getAbsDirection`/`align`) and the target a `setQuaternion`, the pose is
 *     also oriented along the travel direction (same `lookRotation(tangent,
 *     align)` rule as the continuous `PathTraveler`).
 *
 * FastForward sub-mode: `onRender` writes NO transform at all (Plan 194 §3.2 /
 * DESManager.cs:327) — events still fire and time still advances, but the scene
 * is not animated.
 *
 * GC discipline (Plan 194 V3): tween records come from a PRE-ALLOCATED POOL, not
 * `{ tween: {...} }` object literals per event — at HybridSynced 50× that would
 * be thousands of allocations/second. `add()` rents a record; the render loop
 * returns finished records to the pool. The interpolation scratch `Vector3` is a
 * module-level singleton, reused every frame.
 *
 * Robustness (Plan 194 V4):
 *   - `duration = Math.max(0.001, …)` → never `(simNow−t0)/0 = NaN`.
 *   - null visual / null target → the tween is skipped (no crash).
 *   - cancelled events → `cancel(handle)` frees the record so a stale tween can
 *     never keep moving an MU that the DES no longer owns.
 *
 * PUBLIC module — imports nothing private. The DESRunner (private, P5) owns an
 * instance and calls `add`/`cancel`/`onRender`/`clear`.
 */

import { MathUtils, Quaternion, Vector3 } from 'three';
import { lookRotation } from '../engine/rv-pose-align';

// ─── Public target shapes (structural — no private/RV imports) ───────────

/** Sub-mode tag the registry honours on render (Plan 194 §3.2). */
export type TweenSubMode = 'animated' | 'hybrid' | 'fastforward' | 'step';

/** Per-record transform-write policy (plan-298 Phase 1). */
export type TweenWritePolicy = 'always' | 'finalOnly';

/** Interpolation profile for scalar drive records (plan-298 Phase 1). */
export type TweenEase = 'linear' | 'scurve';

/** Optional DRIVE tween behavior. Omitted options preserve the legacy path. */
export interface DriveTweenOptions {
  readonly writePolicy?: TweenWritePolicy;
  readonly ease?: TweenEase;
}

/**
 * A visual that a position tween moves. Structurally satisfied by both
 * `RVMovingUnit` and `InstancedMovingUnit` (`IMUAccessor.setPosition`), so the
 * public registry never imports the MU classes.
 */
export interface PositionTweenTarget {
  setPosition(v: Vector3): void;
}

/**
 * A drive a rotation/linear tween writes. Structurally satisfied by `RVDrive`
 * via a thin wrapper the DESRunner supplies (`v => { drive.currentPosition = v;
 * drive.applyToNode(); }`), so the public registry never imports `RVDrive`.
 */
export interface DriveTweenTarget {
  setPosition(value: number): void;
}

/**
 * The arc-length sampler a PATH tween interpolates along (plan-268 Phase 3).
 * Structurally satisfied by `RVPath` (`getAbsPosition(meters, out)` — constant
 * speed by construction, never `getPoint(t)`), so the public registry never
 * imports the path class. `getAbsDirection`/`align` are OPTIONAL: when present
 * AND the target exposes `setQuaternion`, the tween also orients the visual
 * along the travel tangent (`lookRotation(tangent, align)` — the exact pose
 * rule the continuous `PathTraveler` uses).
 */
export interface PathTweenSampler {
  getAbsPosition(meters: number, out: Vector3): Vector3;
  getAbsDirection?(meters: number, out: Vector3): Vector3;
  readonly align?: Vector3;
}

/**
 * A visual a path tween moves — position always, pose when it can. The Agv's
 * default target (material-flow-self `pathTween`) writes the component root's
 * position + quaternion; an MU visual without `setQuaternion` still works
 * (translation only).
 */
export interface PathTweenTarget extends PositionTweenTarget {
  setQuaternion?(q: Quaternion): void;
}

/** Opaque tween handle (an index into the pool). −1 means "no tween". */
export type TweenHandle = number;

/** JSON-only active tween window used by DES snapshot v3. */
export type TweenDataSnapshot =
  | {
      kind: 'position'; t0: number; t1: number; muId: number;
      from: [number, number, number]; to: [number, number, number];
    }
  | {
      kind: 'path'; t0: number; t1: number; muId: number; pathRef: string;
      fromS: number; toS: number;
    };

// ─── Pool record (mutable; never exposed) ────────────────────────────────

interface TweenRecord {
  /** In-use flag — a free record is `active = false`. */
  active: boolean;
  /** 'pos' | 'drive' | 'path' | '' (free). */
  kind: 'pos' | 'drive' | 'path' | '';
  /** Sim-time the tween starts. */
  t0: number;
  /** Sim-time the tween ends (always `> t0`, clamped via Math.max). */
  t1: number;
  /** Position/path tween target (null for drive tweens / free records). */
  posTarget: PositionTweenTarget | null;
  /** Drive tween target (null for position/path tweens / free records). */
  driveTarget: DriveTweenTarget | null;
  /** Arc-length sampler for PATH tweens (null otherwise / free records). */
  pathSampler: PathTweenSampler | null;
  /** Stable registry id for persisted path records. */
  pathRef: string;
  /** Start value — Vector3 for pos, scalar for drive/path (in `fromScalar`;
   *  path tweens store the arc-length addresses fromS/toS in meters there). */
  fromVec: Vector3;
  toVec: Vector3;
  fromScalar: number;
  toScalar: number;
  /**
   * Integer id of the DES MU this position tween moves, or −1 (untracked).
   * plan-262 Phase 3: HEADLESS MUs (FastForward, `visual === null`) register
   * their tween WINDOW here with a null `posTarget` (no write, normal reap);
   * `activeWindowForMu` / `attachTargetForMu` use the id to position and
   * re-connect the visual when the MU is materialised on FastForward exit.
   */
  muId: number;
  /** Monotonic generation, bumped on free — guards stale-handle cancels. */
  gen: number;
  /** Transform-write policy (DRIVE only; other kinds always use `always`). */
  writePolicy: TweenWritePolicy;
  /** Scalar interpolation profile (DRIVE only; other kinds stay linear). */
  ease: TweenEase;
}

/** Module-level interpolation scratch — reused every record, every frame (V3). */
const _scratch = new Vector3();
/** Path-tween tangent/pose scratches — reused every record, every frame (V3). */
const _scratchDir = new Vector3();
const _scratchQuat = new Quaternion();
/** Default up vector for the optional path-tween pose (Y up, glTF convention). */
const _PATH_UP = new Vector3(0, 1, 0);

/**
 * The central sim-time tween registry. One instance per DESRunner.
 *
 * @param initialCapacity initial pool size (grows geometrically on demand).
 */
export class TweenRegistry {
  /** Pre-allocated record pool (Plan 194 V3 — no per-event allocation). */
  private _pool: TweenRecord[] = [];
  /** Indices of currently-active records (compacted in place on render). */
  private _active: number[] = [];
  /** Free-list of pool indices ready to be rented. */
  private _free: number[] = [];
  /** Last explicit FastForward state, used by reasoned event-time settles. */
  private _ffActive = false;

  constructor(initialCapacity = 256) {
    this._grow(Math.max(1, initialCapacity));
  }

  /** Number of live tweens (diagnostics / tests). */
  get activeCount(): number {
    return this._active.length;
  }

  /** Pool size (diagnostics / tests — verifies no per-event growth). */
  get poolSize(): number {
    return this._pool.length;
  }

  // ─── Registration ──────────────────────────────────────────────────────

  /**
   * Register a POSITION tween (straight translation). The `from`/`to` vectors
   * are COPIED into the pooled record (the caller may mutate or reuse theirs).
   *
   * plan-262 Phase 3: with a `muId` (≥ 0), a NULL target still creates a record
   * — the render loop skips the write (nothing to move) but the tween WINDOW
   * (t0/t1/from/to) is kept and reaped normally, so a headless MU can be
   * positioned (`activeWindowForMu`) and re-connected (`attachTargetForMu`)
   * when it is materialised on FastForward exit. Without a `muId` the old
   * behaviour stands: null target → no record, handle −1.
   *
   * @returns a handle for `cancel()`, or −1 when the target is null and no
   *          `muId` is supplied (skipped).
   */
  addPosition(
    target: PositionTweenTarget | null,
    from: Vector3,
    to: Vector3,
    t0: number,
    duration: number,
    muId = -1,
  ): TweenHandle {
    if (!target && muId < 0) return -1; // null visual, untracked → skip (V4)
    const idx = this._rent();
    const r = this._pool[idx];
    r.active = true;
    r.kind = 'pos';
    r.t0 = t0;
    r.t1 = t0 + Math.max(0.001, duration); // duration=0 guard (V4)
    r.posTarget = target;
    r.driveTarget = null;
    r.pathSampler = null;
    r.fromVec.copy(from);
    r.toVec.copy(to);
    r.muId = muId;
    this._active.push(idx);
    return this._encode(idx, r.gen);
  }

  /**
   * Register a PATH tween (plan-268 Phase 3): the ARC-LENGTH address is lerped
   * `fromS → toS` (meters) over the window and the position sampled from the
   * path (`getAbsPosition`) — a curved transit renders ON the curve instead of
   * cutting the chord. FastForward behaves exactly like the other flavours:
   * NO transform write while running, the final value (the arc-length END
   * position) is written when the tween finishes or `settle()` runs.
   *
   * No `muId` variant here (unlike `addPosition`): a path tween's target is a
   * persistent scene node (the vehicle root), not a poolable MU visual — the
   * headless-MU materialisation channel does not apply.
   *
   * @returns a handle for `cancel()`, or −1 when sampler or target is null (V4).
   */
  addPath(
    sampler: PathTweenSampler | null,
    target: PathTweenTarget | null,
    fromS: number,
    toS: number,
    t0: number,
    duration: number,
    muId = -1,
    pathRef = '',
  ): TweenHandle {
    if (!sampler || (!target && muId < 0)) return -1;
    const idx = this._rent();
    const r = this._pool[idx];
    r.active = true;
    r.kind = 'path';
    r.t0 = t0;
    r.t1 = t0 + Math.max(0.001, duration); // duration=0 guard (V4)
    r.posTarget = target;
    r.driveTarget = null;
    r.pathSampler = sampler;
    r.pathRef = pathRef;
    r.fromScalar = Number.isFinite(fromS) ? fromS : 0;
    r.toScalar = Number.isFinite(toS) ? toS : 0;
    r.muId = muId;
    this._active.push(idx);
    return this._encode(idx, r.gen);
  }

  /**
   * Register a DRIVE tween (rotation / linear via the real drive).
   *
   * @returns a handle for `cancel()`, or −1 when the drive is null (skipped).
   */
  addDrive(
    drive: DriveTweenTarget | null,
    from: number,
    to: number,
    t0: number,
    duration: number,
    opts?: DriveTweenOptions,
  ): TweenHandle {
    if (!drive) return -1; // null drive → skip (V4)
    const idx = this._rent();
    const r = this._pool[idx];
    r.active = true;
    r.kind = 'drive';
    r.t0 = t0;
    r.t1 = t0 + Math.max(0.001, duration); // duration=0 guard (V4)
    r.posTarget = null;
    r.driveTarget = drive;
    r.pathSampler = null;
    r.fromScalar = from;
    r.toScalar = to;
    r.muId = -1;
    r.writePolicy = opts?.writePolicy ?? 'always';
    r.ease = opts?.ease ?? 'linear';
    this._active.push(idx);
    return this._encode(idx, r.gen);
  }

  /**
   * Cancel a tween (e.g. its DES event was cancelled). Frees the pooled record
   * so a stale tween can never keep animating an MU (V4). Stale or already-freed
   * handles are ignored via the generation check.
   */
  cancel(handle: TweenHandle): void {
    if (handle < 0) return;
    const idx = this._decodeIdx(handle);
    const gen = this._decodeGen(handle);
    const r = this._pool[idx];
    if (!r || !r.active || r.gen !== gen) return; // stale / double-cancel
    this._freeRecord(idx);
    // Remove from the active list (linear scan — cancels are rare vs. renders).
    const ai = this._active.indexOf(idx);
    if (ai >= 0) this._active.splice(ai, 1);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  /**
   * Interpolate every active tween at `simNow`. Finished tweens write their final
   * value once, then are returned to the pool.
   *
   * In `fastforward` mode the INTERMEDIATE (still-running) tweens are NOT written —
   * the parts don't animate (max throughput, just the clock advances). But a tween
   * that FINISHES this pass STILL writes its final value before being reaped: that
   * leaves every reaped part at its correct end position, so switching back to a
   * slower factor is clean (the running tweens then self-correct on the first frame).
   * Skipping the final write too (the old behaviour) stranded finished parts at stale
   * positions — the "wrong animation when leaving FF".
   */
  onRender(
    simNow: number,
    subMode: TweenSubMode,
    ffActive = subMode === 'fastforward',
  ): void {
    this._ffActive = ffActive;
    const noWrite = subMode === 'fastforward';
    const active = this._active;
    let write = 0; // compaction write cursor

    for (let read = 0; read < active.length; read++) {
      const idx = active[read];
      const r = this._pool[idx];
      if (!r.active) continue; // defensive (cancel compacts already)

      const finished = simNow >= r.t1;
      // Animate every frame; in fastforward write ONLY the final value (p = 1).
      const policySuppressesWrite = r.writePolicy === 'finalOnly'
        && !finished
        && (simNow < r.t0 || ffActive);
      if ((!noWrite && !policySuppressesWrite) || finished) {
        const rawP = finished ? 1 : MathUtils.clamp((simNow - r.t0) / (r.t1 - r.t0), 0, 1);
        const p = r.ease === 'scurve' ? rawP * rawP * (3 - 2 * rawP) : rawP;
        if (r.kind === 'pos' && r.posTarget) {
          _scratch.lerpVectors(r.fromVec, r.toVec, p);
          r.posTarget.setPosition(_scratch);
        } else if (r.kind === 'drive' && r.driveTarget) {
          r.driveTarget.setPosition(r.fromScalar + (r.toScalar - r.fromScalar) * p);
        } else if (r.kind === 'path' && r.posTarget && r.pathSampler) {
          // Arc-length sampling (plan-268 Phase 3): lerp the arc ADDRESS, then
          // sample the position from the path — constant speed on curves.
          const s = r.fromScalar + (r.toScalar - r.fromScalar) * p;
          r.pathSampler.getAbsPosition(s, _scratch);
          r.posTarget.setPosition(_scratch);
          // Optional pose: orient along the tangent when both sides support it
          // (same lookRotation(tangent, align) rule as the continuous traveler).
          const tgt = r.posTarget as PathTweenTarget;
          if (tgt.setQuaternion && r.pathSampler.getAbsDirection) {
            r.pathSampler.getAbsDirection(s, _scratchDir);
            tgt.setQuaternion(
              lookRotation(_scratchDir, r.pathSampler.align ?? _PATH_UP, _scratchQuat),
            );
          }
        }
      }

      if (finished) {
        // Finished — reap into the pool (do NOT keep in the active list).
        this._freeRecord(idx);
      } else {
        // Still running — keep (compact in place).
        active[write++] = idx;
      }
    }

    active.length = write;
  }

  /**
   * Force EVERY active tween to its EXACT position at `simNow` — running AND
   * finished — unconditionally writing the transform regardless of sub-mode.
   * Finished tweens are reaped as in `onRender`.
   *
   * This is the "settle" step when LEAVING FastForward (des-runner
   * `setSubMode`): FastForward's `onRender` skips the transform write for
   * still-running tweens (max throughput), so on exit every mid-transit MU is
   * stranded at its pre-FF position. Calling `settle(simNow)` snaps them all to
   * the true sim position BEFORE continuous animation resumes, so the next
   * animated frame continues smoothly instead of teleporting the parts.
   */
  settle(
    simNow: number,
    reason: 'event' | 'ffExit' = 'ffExit',
    ffActive = this._ffActive,
  ): void {
    const active = this._active;
    let write = 0;

    for (let read = 0; read < active.length; read++) {
      const idx = active[read];
      const r = this._pool[idx];
      if (!r.active) continue;

      const finished = simNow >= r.t1;
      const finalOnlyExit = reason === 'ffExit' && r.writePolicy === 'finalOnly';
      const suppress = reason === 'event'
        && r.writePolicy === 'finalOnly'
        && !finished
        && (simNow < r.t0 || ffActive);

      if (!suppress) {
        const rawP = finished || finalOnlyExit
          ? 1
          : MathUtils.clamp((simNow - r.t0) / (r.t1 - r.t0), 0, 1);
        const p = r.ease === 'scurve' ? rawP * rawP * (3 - 2 * rawP) : rawP;
        this._writeRecord(r, p);
      }

      if (finished || finalOnlyExit) {
        this._freeRecord(idx);
      } else {
        active[write++] = idx;
      }
    }

    active.length = write;
    if (reason === 'ffExit') this._ffActive = false;
  }

  /**
   * DEV-ONLY diagnostic (plan-262 Phase 2 safety net): the set of position-tween
   * targets whose tween window is still RUNNING at `simNow` (`t1 > simNow` —
   * finished-but-unreaped records are excluded). The DES runner's dev guard uses
   * it to warn when a des hook of a type WITHOUT `samplesLiveGeometry` dispatches
   * while the event-time settle is disabled and its MU is mid-tween.
   *
   * Returns `null` in production builds — the compile-time `import.meta.env.DEV`
   * constant makes the scan dead code there (zero cost).
   */
  devActivePositionTargets(simNow: number): ReadonlySet<PositionTweenTarget> | null {
    if (!import.meta.env.DEV) return null;
    const out = new Set<PositionTweenTarget>();
    for (const idx of this._active) {
      const r = this._pool[idx];
      if (r.active && r.kind === 'pos' && r.posTarget && r.t1 > simNow) out.add(r.posTarget);
    }
    return out;
  }

  // ─── Headless-MU materialisation (plan-262 Phase 3) ─────────────────────

  /**
   * The ACTIVE position-tween window of MU `muId` at `simNow`, or null. When
   * several windows contain `simNow` (a ride tween registered over a belt
   * transit), the LATEST-STARTING one wins — matching the render order rule
   * that a later-registered tween's write wins the frame. The returned vectors
   * are COPIES (safe to keep). Used to position a headless MU's freshly spawned
   * visual on FastForward exit.
   */
  activeWindowForMu(
    muId: number,
    simNow: number,
  ): { from: Vector3; to: Vector3; t0: number; t1: number } | null {
    if (muId < 0) return null;
    let best: TweenRecord | null = null;
    for (const idx of this._active) {
      const r = this._pool[idx];
      if (!r.active || r.kind !== 'pos' || r.muId !== muId) continue;
      if (simNow < r.t0 || simNow > r.t1) continue;
      if (!best || r.t0 >= best.t0) best = r; // latest registration wins
    }
    return best
      ? { from: best.fromVec.clone(), to: best.toVec.clone(), t0: best.t0, t1: best.t1 }
      : null;
  }

  /** Write the exact current position of the latest active MU tween into `out`. */
  positionForMu(muId: number, simNow: number, out: Vector3): boolean {
    if (muId < 0) return false;
    let best: TweenRecord | null = null;
    for (const idx of this._active) {
      const r = this._pool[idx];
      if (!r.active || r.muId !== muId || (r.kind !== 'pos' && r.kind !== 'path')) continue;
      if (simNow < r.t0 || simNow > r.t1) continue;
      if (!best || r.t0 >= best.t0) best = r;
    }
    if (!best) return false;
    const p = MathUtils.clamp((simNow - best.t0) / Math.max(0.001, best.t1 - best.t0), 0, 1);
    if (best.kind === 'path' && best.pathSampler) {
      const s = best.fromScalar + (best.toScalar - best.fromScalar) * p;
      best.pathSampler.getAbsPosition(s, out);
    } else {
      out.lerpVectors(best.fromVec, best.toVec, p);
    }
    return true;
  }

  /**
   * Connect a freshly materialised visual to every RUNNING position record of
   * MU `muId` that has no target yet (headless records), so the tween continues
   * writing the new visual seamlessly (FastForward exit). Records that already
   * carry a target are left alone. Returns the number of records connected.
   */
  attachTargetForMu(muId: number, target: PositionTweenTarget): number {
    if (muId < 0) return 0;
    let n = 0;
    for (const idx of this._active) {
      const r = this._pool[idx];
      if (r.active && (r.kind === 'pos' || r.kind === 'path') && r.muId === muId && !r.posTarget) {
        r.posTarget = target;
        n++;
      }
    }
    return n;
  }

  /** Free every active tween (Reset-on-Switch / dispose). */
  clear(): void {
    for (const idx of this._active) this._freeRecord(idx);
    this._active.length = 0;
  }

  /** Capture only reconstructable MU tween windows as pure JSON. */
  toSnapshot(): TweenDataSnapshot[] {
    const out: TweenDataSnapshot[] = [];
    for (const idx of this._active) {
      const r = this._pool[idx];
      if (!r.active || r.muId < 0) continue;
      if (r.kind === 'pos') {
        out.push({
          kind: 'position', t0: r.t0, t1: r.t1, muId: r.muId,
          from: [r.fromVec.x, r.fromVec.y, r.fromVec.z],
          to: [r.toVec.x, r.toVec.y, r.toVec.z],
        });
      } else if (r.kind === 'path' && r.pathRef) {
        out.push({
          kind: 'path', t0: r.t0, t1: r.t1, muId: r.muId,
          pathRef: r.pathRef, fromS: r.fromScalar, toS: r.toScalar,
        });
      }
    }
    return out;
  }

  /** Rebind JSON tween windows after MU and path registries are restored. */
  fromSnapshot(
    saved: readonly TweenDataSnapshot[],
    resolveTarget: (muId: number) => PositionTweenTarget | null,
    resolvePath: (pathRef: string) => PathTweenSampler | null,
  ): void {
    this.clear();
    for (const tween of saved) {
      const duration = Math.max(0.001, tween.t1 - tween.t0);
      if (tween.kind === 'position') {
        _scratch.set(tween.from[0], tween.from[1], tween.from[2]);
        _scratchDir.set(tween.to[0], tween.to[1], tween.to[2]);
        this.addPosition(resolveTarget(tween.muId), _scratch, _scratchDir, tween.t0, duration, tween.muId);
      } else {
        this.addPath(
          resolvePath(tween.pathRef),
          resolveTarget(tween.muId) as PathTweenTarget | null,
          tween.fromS,
          tween.toS,
          tween.t0,
          duration,
          tween.muId,
          tween.pathRef,
        );
      }
    }
  }

  // ─── Pool internals ────────────────────────────────────────────────────

  private _grow(by: number): void {
    const start = this._pool.length;
    for (let i = 0; i < by; i++) {
      this._pool.push({
        active: false, kind: '', t0: 0, t1: 0,
        posTarget: null, driveTarget: null, pathSampler: null, pathRef: '',
        fromVec: new Vector3(), toVec: new Vector3(),
        fromScalar: 0, toScalar: 0, muId: -1, gen: 0,
        writePolicy: 'always', ease: 'linear',
      });
      this._free.push(start + i);
    }
  }

  /** Rent a free pool index, growing the pool if exhausted. */
  private _rent(): number {
    if (this._free.length === 0) this._grow(this._pool.length); // geometric
    return this._free.pop()!;
  }

  /** Return a record to the pool (bumps its generation to invalidate handles). */
  private _freeRecord(idx: number): void {
    const r = this._pool[idx];
    r.active = false;
    r.kind = '';
    r.posTarget = null;
    r.driveTarget = null;
    r.pathSampler = null;
    r.pathRef = '';
    r.muId = -1;
    r.writePolicy = 'always';
    r.ease = 'linear';
    r.gen++;
    this._free.push(idx);
  }

  // Handle = (idx << 20) | gen — packs the generation so a freed-and-reused
  // record's old handle is detected as stale on cancel. (idx is small; 20 bits
  // of generation is ample for a per-record monotonic counter.)
  private _encode(idx: number, gen: number): TweenHandle {
    return (idx << 20) | (gen & 0xfffff);
  }
  private _decodeIdx(handle: TweenHandle): number {
    return handle >>> 20;
  }
  private _decodeGen(handle: TweenHandle): number {
    return handle & 0xfffff;
  }

  /** Write one record at an already-clamped/eased progress value. */
  private _writeRecord(r: TweenRecord, p: number): void {
    if (r.kind === 'pos' && r.posTarget) {
      _scratch.lerpVectors(r.fromVec, r.toVec, p);
      r.posTarget.setPosition(_scratch);
    } else if (r.kind === 'drive' && r.driveTarget) {
      r.driveTarget.setPosition(r.fromScalar + (r.toScalar - r.fromScalar) * p);
    } else if (r.kind === 'path' && r.posTarget && r.pathSampler) {
      const s = r.fromScalar + (r.toScalar - r.fromScalar) * p;
      r.pathSampler.getAbsPosition(s, _scratch);
      r.posTarget.setPosition(_scratch);
      const tgt = r.posTarget as PathTweenTarget;
      if (tgt.setQuaternion && r.pathSampler.getAbsDirection) {
        r.pathSampler.getAbsDirection(s, _scratchDir);
        tgt.setQuaternion(
          lookRotation(_scratchDir, r.pathSampler.align ?? _PATH_UP, _scratchQuat),
        );
      }
    }
  }
}
