// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-reference.ts — the MU's explicit, MUTABLE travel state: a FORWARD direction
 * and the REFERENCE POINT (the "Bug") derived from it.
 *
 * An MU is positioned by its transform ORIGIN, but the point that should align with
 * a transfer / booking edge is its LEADING EDGE (the "Bug" — bow). Rather than each
 * component GUESSING the travel direction per move from the transit geometry, the MU
 * carries its `forward` direction as the single source of truth — set by whichever
 * LENGTH-oriented component moves it, and UPDATED at a corner (the turntable rotates
 * the part, so it rewrites `forward`). PLACE-oriented components (a Source) hold the
 * MU at a fixed slot and never touch `forward`.
 *
 * `muBugOffset(mu)` = the origin → leading-edge distance along `mu.forward`, so a
 * component places the MU's ORIGIN one bug-offset BEHIND the edge:
 *   - a conveyor rides the part's leading edge along the belt → no hang-over past the
 *     belt end, and consecutive belts hand off continuously (shared snap plane);
 *   - a turntable discharges with the part's leading edge at the output snap.
 *
 * The offset = half the MU's world bounding-box extent along `forward`, cached on the
 * MU (geometry is constant). Because `forward` is the actual heading (and the part is
 * oriented along it), the world-AABB extent along it is the part's real length there.
 */

import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { MU } from '../../core/material-flow/material-flow-self';

const _box = new Box3();
const _size = new Vector3();

/** The MU's mutable travel state: a ground-plane unit `forward` + a cached world-
 *  bounds size (computed once; geometry is constant). */
interface MuTravel {
  visual?: { node?: Object3D; isInstanced?: boolean };
  forward?: [number, number, number];
  _bugSize?: [number, number, number];
}

/**
 * Set the MU's FORWARD heading (ground plane, world) AND orient the visual to FACE
 * it (its local +Z is aligned with forward). Called by a length-oriented component
 * when it starts moving the MU (a conveyor = the belt direction) or rotates it (a
 * turntable = the new discharge direction). Because the orientation is set from
 * `forward`, the part is ALWAYS exactly aligned with its travel direction — not left
 * at whatever a previous component (e.g. the turntable's ~89° dispatch) happened to
 * leave. Normalises; a degenerate input leaves `forward`/orientation unchanged.
 */
export function setMuForward(mu: MU, dirX: number, dirZ: number): void {
  const d = Math.hypot(dirX, dirZ);
  if (d < 1e-6) return;
  const fx = dirX / d, fz = dirZ / d;
  const m = mu as unknown as MuTravel;
  // Skip the (redundant) write when the heading is unchanged — a straight run keeps
  // one heading across every belt, so this fires once per direction change, not once
  // per accept.
  const f = m.forward;
  if (f && Math.abs(f[0] - fx) < 1e-4 && Math.abs(f[2] - fz) < 1e-4) return;
  m.forward = [fx, 0, fz];
  // Face local +Z along forward (ground plane). yaw = atan2(fx, fz): +Z→0, +X→90°,
  // −X→−90°, −Z→180°. The node is a scene child while a component moves it, so a
  // local Y-rotation IS the world heading.
  const node = m.visual?.node;
  if (node) node.rotation.set(0, Math.atan2(fx, fz), 0);
}

/** The MU's current forward heading as `[x, z]` (ground plane); defaults to +Z. */
export function muForward(mu: MU): [number, number] {
  const f = (mu as unknown as MuTravel).forward;
  return f ? [f[0], f[2]] : [0, 1];
}

/**
 * Measure an MU visual's bounds size in the part's OWN frame (un-rotating the
 * node, so a rotated world AABB can't inflate it) — the raw value `muBugOffset`
 * caches per MU. Exported for the plan-262 Phase 3 headless path: the DES
 * binding measures the size ONCE per source template and pre-sets it on every
 * spawned MU (visual AND headless), so both deliver IDENTICAL bug offsets.
 * Returns `null` when the node carries no measurable geometry.
 */
export function measureMuVisualBugSize(node: Object3D): [number, number, number] | null {
  // Size in the part's OWN frame: un-rotate the node, measure the axis-aligned
  // bounds, restore. Independent of the current world heading.
  const q = node.quaternion.clone();
  node.quaternion.identity();
  node.updateWorldMatrix(true, true);
  _box.makeEmpty();
  _box.expandByObject(node);
  node.quaternion.copy(q);
  node.updateWorldMatrix(true, true);
  if (_box.isEmpty()) return null;
  _box.getSize(_size);
  return [_size.x, _size.y, _size.z];
}

/**
 * Pre-set the MU's cached bug size from a source-template cache (plan-262
 * Phase 3). A headless MU (no visual, FastForward) has nothing to measure —
 * without a preset its bug offset would be 0 and its tween endpoints / ride
 * times would DIFFER from a visual MU's (a determinism break). No-op when
 * `size` is null or the MU already carries a size.
 */
export function presetMuBugSize(mu: MU, size: readonly [number, number, number] | null): void {
  if (!size) return;
  const m = mu as unknown as MuTravel;
  if (!m._bugSize) m._bugSize = [size[0], size[1], size[2]];
}

/**
 * Orient an (just-materialised) visual to the MU's recorded FORWARD heading —
 * the write `setMuForward` would have applied had the visual existed when the
 * heading was set. Used when a headless MU gets its visual on FastForward exit
 * (plan-262 Phase 3). No-op without a heading, without a plain node, or for an
 * instanced visual (its `node` is the SHARED InstancedMesh).
 */
export function applyMuForwardToVisual(mu: MU): void {
  const m = mu as unknown as MuTravel;
  const f = m.forward;
  const node = m.visual && !m.visual.isInstanced ? m.visual.node : undefined;
  if (!f || !node) return;
  node.rotation.set(0, Math.atan2(f[0], f[2]), 0);
}

/**
 * Half the MU's extent along its FORWARD axis — the origin → leading-edge offset
 * (the "Bug"). 0 when the MU has neither a visual nor a pre-set template size.
 * Because `setMuForward` keeps the part's LOCAL +Z aligned with travel, the
 * forward extent is simply the part's local +Z dimension — CONSTANT, so the
 * offset never drifts when the part is re-oriented at a corner. Measured once in
 * the part's OWN frame (or pre-set per source template via `presetMuBugSize`,
 * which lets HEADLESS MUs deliver the identical offset — plan-262 Phase 3).
 */
export function muBugOffset(mu: MU): number {
  const m = mu as unknown as MuTravel;
  let s = m._bugSize;
  if (!s) {
    const node = m.visual?.node;
    if (!node) return 0;
    const measured = measureMuVisualBugSize(node);
    if (!measured) return 0;
    s = measured;
    m._bugSize = s;
  }
  return 0.5 * s[2]; // half the forward (local +Z) dimension
}
