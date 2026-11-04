// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FollowSource — Per-frame world-pose provider for the camera Follow / Sit-On
 * modes (see CameraManager.tickFollow).
 *
 * It abstracts over WHAT is being followed so the tracking math in
 * CameraManager stays target-agnostic:
 *   - `Object3DFollowSource` wraps a scene node (Drive node, clone-MU, any
 *     selectable Object3D).
 *
 * The interface deliberately writes into caller-provided temps (no return-value
 * allocation) so the camera tick stays GC-free.
 *
 * `isAlive()` lets the camera tick detect a vanished target (MU consumed by a
 * Sink, node removed from the scene) and end the mode cleanly instead of
 * freezing on a stale pose.
 */

import { Vector3, Quaternion, Box3, Object3D } from 'three';
import type { ViewerHost } from './rv-viewer-host';

/** Per-frame world-pose provider for a follow target. */
export interface FollowSource {
  /** Local forward axis for Sit-On; defaults to the camera convention (-Z). */
  readonly seatForward?: 'negZ' | 'posZ';
  /** Optional Sit-On Y offset in the part frame, overriding the seat height. */
  readonly seatHeight?: number;
  /** Write the target's current world position into `out`. */
  getWorldPosition(out: Vector3): void;
  /** Write the target's current world rotation into `out` (used by Sit-On). */
  getWorldQuaternion(out: Quaternion): void;
  /** Write the target's world bounding box into `out` (used once for the seat offset). */
  getBounds(out: Box3): void;
  /** False once the target no longer exists (removed from scene / consumed). */
  isAlive(): boolean;
  /** Readable label for logging / UI. */
  readonly label: string;
  /**
   * Optional: the follow mode this source was driving has ended.
   *
   * Called by `CameraManager.stopFollowMode` AFTER the mode is already off and
   * the source detached, so a handler may safely call `stopFollowMode` again
   * (it returns immediately) — but before any restore flight, so a handler that
   * wants to suppress that still can.
   *
   * It exists because follow can now end from inside the CameraManager itself:
   * `animateCameraTo` releases an agent-eye follow before flying (plan-740
   * D-A6b), and the owner of that source has no other way to learn about it —
   * an OrbitControls `'start'` event is never fired for a programmatic flight.
   */
  onFollowStopped?(): void;
}

// Pre-allocated decompose scratch (module-level, never escapes synchronously).
const _decompPos = new Vector3();
const _decompQuat = new Quaternion();
const _decompScale = new Vector3();

/**
 * FollowSource backed by a Three.js Object3D — works for Drive nodes,
 * clone-based MUs and any selectable scene node.
 *
 * World pose is read straight from `matrixWorld` after forcing it up to date,
 * which is robust for "frozen" / baked nodes whose local transform may be
 * stale relative to their parents.
 */
export class Object3DFollowSource implements FollowSource {
  readonly label: string;
  private readonly node: Object3D;

  constructor(node: Object3D, label?: string, readonly seatForward: 'negZ' | 'posZ' = 'negZ') {
    this.node = node;
    this.label = label ?? node.name ?? 'node';
  }

  getWorldPosition(out: Vector3): void {
    // Force the world matrix up to date (parents → this node), then read the
    // translation column directly — robust for baked / frozen local transforms.
    this.node.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.node.matrixWorld);
  }

  getWorldQuaternion(out: Quaternion): void {
    this.node.updateWorldMatrix(true, false);
    this.node.matrixWorld.decompose(_decompPos, _decompQuat, _decompScale);
    out.copy(_decompQuat);
  }

  getBounds(out: Box3): void {
    out.setFromObject(this.node);
  }

  isAlive(): boolean {
    // A node removed from the scene graph has parent === null.
    return this.node.parent !== null;
  }
}

/**
 * Resolve a selected node path into a FollowSource, or null when the path is
 * not followable (no resolvable node).
 *
 * Instanced MUs (rendered through a shared MUInstancePool / InstancedMesh) are
 * NOT followable here: they are never selectable through the standard click
 * pipeline (their pseudo-path `template#slot` does not resolve via
 * `registry.getNode`), so `selectionManager.primaryPath` never points at one.
 * They therefore fall through to the `null` branch and the toolbar button is
 * disabled — no silent failure. (See plan-221 §2.3 / Finding 2, Phase 1b.)
 */
export function resolveFollowSource(viewer: ViewerHost, path: string): FollowSource | null {
  const registry = viewer.registry;
  if (!registry) return null;
  const node = registry.getNode(path);
  if (!node) return null;
  // Agv stamps its resolved path on the pose-driving root. Its PathTraveler
  // uses lookRotation(tangent, align), so that root's forward axis is +Z.
  const agvPath = node.userData.realvirtual?.AgvBehavior?.Path;
  const seatForward = typeof agvPath === 'string' && agvPath.length > 0 ? 'posZ' : 'negZ';
  return new Object3DFollowSource(node, path, seatForward);
}
