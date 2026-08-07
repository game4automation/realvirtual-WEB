// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-des.ts — the GENERIC drive-level DES motion primitive.
 *
 * "Give the drive a DES logic": given a target axis position, compute the move
 * TIME and schedule the completion event, building a `{kind:'drive'}` tween so the
 * real drive turns/translates 1:1 over the window (the optics match). The
 * COMPONENT still computes WHERE to go (a turntable's rotation angle, a conveyor's
 * transit distance, a future RBG/stacker axis target) — this primitive owns only
 * TIME + tween + scheduling, the part that is identical for EVERY positioned axis.
 * So one mechanism serves turntable rotation, conveyor transit and future
 * multi-axis (RBG) moves instead of each component re-deriving its own DES times.
 *
 * DES-ONLY: it calls `self.in` (the DES scheduler), which is a dev-throw in
 * continuous mode — callers must guard on `self.mode === 'des'`. It lives in
 * `_shared` (NOT in the engine RVDrive, NOT on DriveHandle) because it depends on
 * the material-flow scheduler + TweenSpec, which the engine layer must not import.
 */

import type { DesHookName, MU } from '../../core/material-flow/material-flow-self';

/** A visual a position-move tween translates (its `setPosition` moves the MU). */
export interface PositionMoveTarget {
  setPosition(v: { x: number; y: number; z: number }): void;
}

/** The real drive the DES move tween writes to each frame (engine RVDrive shape). */
export interface DriveTweenTarget {
  positionOverwrite: boolean;
  currentPosition: number;
  applyToNode(): void;
}

/** One single-axis DES move: an axis at `speed` (axis units/s) going `from`→`to`. */
export interface DriveMoveSpec {
  /** The real drive to animate; `null` → time-only (no tween, e.g. headless/tests). */
  readonly drive: DriveTweenTarget | null;
  /** Axis speed in the axis' own units (deg/s rotary, mm/s linear) — caller-resolved. */
  readonly speed: number;
  /** Current commanded axis position (deg or mm). */
  readonly from: number;
  /** Target commanded axis position (deg or mm). */
  readonly to: number;
}

/** Minimal scheduler surface — any material-flow `self` satisfies it. */
interface DesScheduleSelf {
  in(delay: number, hook: DesHookName, mu?: MU | null, data?: unknown): number;
}

/**
 * DES move TIME. Constant-speed profile: `|to-from| / speed`, division-guarded.
 *
 * PROFILE HOOK: trapezoidal (accel ramps) and sinusoidal / S-curve move times land
 * here later, selected by the drive's parameterization (Acceleration /
 * UseAcceleration), exactly like the C# drive. For now every move is
 * constant-speed (matches today's DES). Keep this the SINGLE home for DES
 * move-time so every caller (turntable, conveyor, RBG) stays in sync.
 */
export function driveMoveTime(speed: number, from: number, to: number): number {
  return Math.max(0.001, Math.abs(to - from) / Math.max(0.001, speed));
}

/**
 * Compute the move time (`driveMoveTime`), build the `{kind:'drive'}` tween that
 * turns the real drive `from`→`to` over the window, and schedule `hook` after that
 * time. Returns the scheduled dt (so multi-axis callers can take `max()` and fire a
 * single phase-complete hook). DES-ONLY — guard on `self.mode === 'des'`.
 */
export function scheduleDriveMove(
  self: DesScheduleSelf,
  spec: DriveMoveSpec,
  hook: DesHookName,
  mu: MU | null,
): number {
  const dt = driveMoveTime(spec.speed, spec.from, spec.to);
  const drv = spec.drive;
  // The {kind:'drive'} tween: the private TweenRegistry interpolates from→to over
  // the scheduled window and writes the real drive via setPosition each frame
  // (positionOverwrite skips the physics integrator on the DES path).
  const data = drv
    ? {
        tween: {
          kind: 'drive' as const,
          drive: {
            setPosition(v: number): void {
              drv.positionOverwrite = true;
              drv.currentPosition = v;
              drv.applyToNode();
            },
          },
          from: spec.from,
          to: spec.to,
        },
      }
    : undefined;
  self.in(dt, hook, mu, data);
  return dt;
}

/** One straight position move of a visual from `from`→`to` (world coords). */
export interface PositionMoveSpec {
  /** The visual to translate (the MU's `visual`); null → time-only (no tween). */
  readonly target: unknown | null;
  /** Start world position. */
  readonly from: readonly [number, number, number];
  /** Target world position. */
  readonly to: readonly [number, number, number];
  /** Move duration in seconds. */
  readonly time: number;
}

/**
 * Schedule a straight POSITION move of a visual (a `{kind:'position'}` tween) and
 * fire `hook` after `time` seconds. The companion of `scheduleDriveMove` for parts
 * that translate in WORLD space rather than riding a positioned axis — e.g. a
 * turntable RIDING a part from the incoming belt onto its centre, then from the
 * centre out to the discharge edge. Because the tween is registered AFTER the
 * upstream belt's transit tween, its writes WIN in the same render — so it cleanly
 * overrides the belt's stale exit-position write on the hand-off frame (no jump).
 * DES-ONLY — guard on `self.mode === 'des'`.
 */
export function schedulePositionMove(
  self: DesScheduleSelf,
  spec: PositionMoveSpec,
  hook: DesHookName,
  mu: MU | null,
): number {
  const dt = Math.max(0.001, spec.time);
  // plan-262 Phase 3: a HEADLESS MU (null target in FastForward) still gets a
  // tween SPEC when its id is known — the runner keeps the window (write
  // skipped) so the MU can be positioned when materialised on FF exit.
  const muId = mu && typeof (mu as { id?: unknown }).id === 'number'
    ? (mu as { id: number }).id
    : undefined;
  const data = spec.target != null || muId !== undefined
    ? {
        tween: {
          kind: 'position' as const,
          target: spec.target ?? null,
          ...(muId !== undefined ? { muId } : {}),
          from: spec.from,
          to: spec.to,
        },
      }
    : undefined;
  self.in(dt, hook, mu, data);
  return dt;
}
