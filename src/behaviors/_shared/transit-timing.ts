// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transit-timing.ts — reusable DES transit-timing geometry for transport
 * components (conveyors, curves, spirals).
 *
 * `createTransitTimer(self, belt)` resolves the belt speed (mm/s), the belt
 * length (mm), the entry/exit world positions for the in-transit tween, and
 * `transitTime` (seconds, entry → discharge over the FULL belt length).
 *
 * Why full length: in the continuous/physics view a part rides the surface to
 * the very end before the downstream picks it up — the sensor only gates ZPA
 * stop/run. The discharge sensor sits near the exit but not exactly at it, so
 * the DES transit must cover the whole belt (length / speed), NOT entry→sensor.
 * The sensor position therefore plays no part in the timing.
 *
 * Speed comes from the belt drive's `TargetSpeed` (mm/s), falling back to a
 * constant when no drive is configured. Length comes from the belt node's world
 * bounds along its longest axis: scene/world units are metres (the GLB unit), so
 * the extent is scaled ×1000 to millimetres to match the mm/s speed.
 */

import { Box3, Vector3, Quaternion } from 'three';
import type { Object3D } from 'three';
import {
  type MaterialFlowSelf,
  type MU,
  type TweenSpec,
} from '../../core/material-flow/material-flow-self';
import { muBugOffset, setMuForward } from './mu-reference';
import { DEFAULT_TRANSPORT_SPEED_MM_S } from '../../core/engine/rv-constants';

/** mm/s fallback when the belt has no configured drive — shared with the
 *  naming-convention scanner so DES timing and animation agree. */
const DEFAULT_SPEED_MM_S = DEFAULT_TRANSPORT_SPEED_MM_S;
/** Scene/world units are metres (the GLB unit); ×1000 converts a length to mm. */
const METRES_TO_MM = 1000;

/**
 * Resolved transit-timing model for one transport component. Speed/length are in
 * the C#-DES units (mm/s, mm); world positions are in metres (the GLB/Three scene
 * unit), matching the tween targets.
 */
export interface TransitTimer {
  /** Seconds entry → discharge over the full belt (`length / speed`). ≥ 0.001. */
  readonly transitTime: number;
  /** Belt speed in mm/s (≥ 0.001), from the belt drive's `TargetSpeed`. */
  readonly speed: number;
  /** Belt length in mm (world-bounds extent ×1000, metres → mm). */
  readonly length: number;
  /** Entry world position for the in-transit tween (entry → exit). */
  readonly entryPos: [number, number, number];
  /** Exit world position for the in-transit tween. */
  readonly exitPos: [number, number, number];
  /** Build the straight entry→exit position-tween spec for an in-transit MU. */
  tween(mu: MU): TweenSpec;
  /** Recompute the timing model (e.g. after a speed / topology change). */
  refresh(): void;
}

// Pre-allocated scratch values — no per-call allocation.
const _box = new Box3();
const _v = new Vector3();
const _q = new Quaternion();
const _fwd = new Vector3();
const _diff = new Vector3();
const _swap = new Vector3();
const _le = new Vector3(); // leading-edge entry (snap or bounds)
const _lx = new Vector3(); // leading-edge exit  (snap or bounds)
const _dir = new Vector3(); // unit flow direction

/**
 * Resolve the belt speed (mm/s) for the DES transit time from the live belt
 * drive's `TargetSpeed`, falling back to `DEFAULT_SPEED_MM_S` when there is no
 * drive (or it is non-positive). Division-protected (`Math.max(0.001, …)`).
 */
function resolveSpeed(self: MaterialFlowSelf<unknown>, belt: Object3D): number {
  const driveSpeed = self.drive(belt)?.TargetSpeed;
  return Math.max(0.001, driveSpeed && driveSpeed > 0 ? driveSpeed : DEFAULT_SPEED_MM_S);
}

/**
 * Resolve the belt length (mm) from the belt node's world bounds: the longest
 * extent ×1000 (metres → mm). Falls back to 1 mm only when the node carries no
 * renderable geometry (degenerate; keeps the transit time finite).
 */
function resolveLength(belt: Object3D): number {
  _box.makeEmpty();
  _box.expandByObject(belt);
  if (!_box.isEmpty()) {
    _box.getSize(_v);
    const longest = Math.max(_v.x, _v.y, _v.z);
    if (longest > 0) return longest * METRES_TO_MM;
  }
  return 1; // last-resort positive length (keeps transit time finite)
}

/**
 * Create a reusable transit timer over `self` and the resolved `belt` transport
 * node. Computes the timing model immediately; call `refresh()` to recompute
 * after a speed/topology change.
 */
export function createTransitTimer(
  self: MaterialFlowSelf<unknown>,
  belt: Object3D,
): TransitTimer {
  let speed = 0.001;
  let length = 1;
  let entryPos: [number, number, number] = [0, 0, 0];
  let exitPos: [number, number, number] = [0, 0, 0];

  function compute(): void {
    speed = resolveSpeed(self, belt);
    length = resolveLength(belt);

    // Entry/exit world positions from the belt-node bounds along its longest axis.
    const entry = new Vector3();
    const exit = new Vector3();
    _box.makeEmpty();
    _box.expandByObject(belt);
    if (!_box.isEmpty()) {
      _box.getSize(_v);
      const cx = (_box.min.x + _box.max.x) * 0.5;
      const cz = (_box.min.z + _box.max.z) * 0.5;
      // Parts ride on the belt's TOP edge (the roller surface) — the general rule
      // for conveyors. Using the bounds CENTRE sank parts into the rollers.
      const top = _box.max.y;
      // Span the longest axis (the transport direction in most belt layouts).
      if (_v.x >= _v.y && _v.x >= _v.z) {
        entry.set(_box.min.x, top, cz); exit.set(_box.max.x, top, cz);
      } else if (_v.z >= _v.x && _v.z >= _v.y) {
        entry.set(cx, top, _box.min.z); exit.set(cx, top, _box.max.z);
      } else {
        entry.set(cx, _box.min.y, cz); exit.set(cx, _box.max.y, cz);
      }

      // The bounds give the two ends but NOT which is entry vs exit — plain
      // min→max runs any belt that flows in a -world direction BACKWARDS
      // (visible as parts moving the wrong way around a loop). Orient entry→exit
      // along the belt's flow: its local +Z (the Conveyor flow convention — see
      // Conveyor.ts "Material flows along its local +Z"). Projecting +Z (world)
      // onto (exit−entry) and swapping on a negative dot makes the tween follow
      // the real transport sense regardless of how the belt is rotated/placed.
      belt.getWorldQuaternion(_q);
      _fwd.set(0, 0, 1).applyQuaternion(_q);
      if (_fwd.dot(_diff.copy(exit).sub(entry)) < 0) {
        _swap.copy(entry); entry.copy(exit); exit.copy(_swap);
      }
    } else {
      belt.getWorldPosition(entry); exit.copy(entry);
    }
    entryPos = [entry.x, entry.y, entry.z];
    exitPos = [exit.x, exit.y, exit.z];
    // Note: the transit TIME is computed lazily in the `transitTime` getter from the
    // leading-edge (snap) distance / speed — the full-belt travel — so it stays in
    // sync with the snap-anchored tween path; nothing time-related is cached here.
  }

  compute();

  // Resolve the LEADING-EDGE path (entry→exit) for this transit into _le/_lx. Prefer
  // the input/output PORT snap planes so consecutive belts share an identical
  // hand-off point (no gap/jerk); fall back to the bounds-derived entry/exit. Lazy —
  // ports are resolved by the time tween()/transitTime are read (onAccept), even
  // though the timer is built in setup(). Returns true when snaps were used.
  function leadingEdge(): boolean {
    const inSnap = self.inputs?.()[0]?.snapNode;
    const outSnap = self.outputs?.()[0]?.snapNode;
    if (inSnap && outSnap) {
      inSnap.getWorldPosition(_le);
      outSnap.getWorldPosition(_lx);
      // HEIGHT from the belt's TOP edge (entryPos[1] = belt-bounds max.y = roller
      // surface) — parts ride ON the rollers. Taken from the bounds (NOT the snap Y)
      // so it is consistent across adjacent level belts whose snap nodes may sit at
      // slightly different heights (which used to make parts jump at the hand-off).
      // Horizontal (X/Z) still follows the snaps (continuity + bug).
      _le.y = _lx.y = entryPos[1];
      return true;
    }
    _le.set(entryPos[0], entryPos[1], entryPos[2]);
    _lx.set(exitPos[0], exitPos[1], exitPos[2]);
    return false;
  }

  return {
    get transitTime(): number {
      // Travel distance = the leading-edge path length (snap-to-snap when available,
      // so the part traverses the full pitch at belt speed, uniform across joins).
      leadingEdge();
      const distMm = _lx.distanceTo(_le) * METRES_TO_MM;
      return Math.max(0.001, (distMm > 0 ? distMm : length) / speed);
    },
    get speed(): number { return speed; },
    get length(): number { return length; },
    get entryPos(): [number, number, number] { return entryPos; },
    get exitPos(): [number, number, number] { return exitPos; },
    tween(mu: MU): TweenSpec {
      // The MU ORIGIN rides one bug-offset BEHIND the leading edge, so its LEADING
      // EDGE (the "Bug") — not its centre — follows the path: it never hangs over the
      // belt end, and since belt_N.input_snap == belt_{N-1}.output_snap the origin
      // path is continuous across the hand-off (no jump).
      leadingEdge();
      _dir.copy(_lx).sub(_le);
      const len = _dir.length();
      if (len > 1e-6) _dir.multiplyScalar(1 / len); else _dir.set(0, 0, 1);
      // The MU now travels along this belt — record its heading as the single source
      // of truth (SSOT) for the bug direction, then take the bug along it.
      setMuForward(mu, _dir.x, _dir.z);
      const bug = muBugOffset(mu);
      return {
        tween: {
          kind: 'position',
          target: (mu as { visual?: unknown }).visual ?? null,
          // plan-262 Phase 3: the MU id rides the spec so the runner keeps the
          // tween window for a headless MU (materialisation on FF exit).
          muId: mu.id,
          from: [_le.x - _dir.x * bug, _le.y - _dir.y * bug, _le.z - _dir.z * bug],
          to: [_lx.x - _dir.x * bug, _lx.y - _dir.y * bug, _lx.z - _dir.z * bug],
        },
      };
    },
    refresh(): void {
      compute();
    },
  };
}
