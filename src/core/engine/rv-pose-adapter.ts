// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pose-adapter — put drive AXES into a pose for one synchronous measurement
 * and take them out again, without touching any drive (plan-641 M6).
 *
 * `withPose(ctx, pose, fn)`:
 *
 *  1. resolves every pose key (a drive path or a unique drive name) to an
 *     `RVDrive`; unknown → `pose-unknown-drive`;
 *  2. adds the `Drive_Gear` slaves of a posed master, state-free
 *     (`master × GearFactor + Offset`, exactly `RVDriveGear.update`), chains
 *     included — unless the slave is posed explicitly;
 *  3. refuses any OTHER coupling to a posed drive it cannot compute
 *     (`pose-dependency-unsupported`: a behavior of an unposed drive holding
 *     the posed drive) — pose that axis explicitly to accept it;
 *  4. snapshots `position` / `quaternion` / `matrix` / `matrixWorld` of every
 *     node it is going to move, then writes the target transform of each axis
 *     PARENTS FIRST, refreshing the parent's world matrix before every child
 *     computation (the linear unit conversion reads it), via
 *     `RVDrive.computePoseTransform` — the drive's own formula as a pure
 *     function (`writeDriveLocalTransform`);
 *  5. runs `fn` SYNCHRONOUSLY — no tick, no await in between — and restores
 *     every snapshot in `finally`, in reverse order, also when `fn` throws.
 *
 * What it never does: write `currentPosition`, a target, the motion profile,
 * `basePosition`, or call `applySyncData` (which arms the smooth-rebase and
 * discontinuity state, `rv-drive.ts`). A running acceleration profile therefore
 * continues tick for tick as if no check had happened.
 *
 * Valid only in the RUNTIME tree (the caller decides — `ctx.editorTree`): there
 * kinematic group members hang under their axis after the bake and mover
 * chunks follow the boundary node. In the editor tree the CAD hierarchy stays,
 * so a pose would move the wrong parts → `pose-requires-runtime`.
 */

import type { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import { RVDrive } from './rv-drive';
import { RVDriveGear } from './rv-drive-gear';

/** Drive path or unique drive name → drive position (mm or deg, like `currentPosition`). */
export type PoseSpec = Readonly<Record<string, number>>;

export type PoseErrorCode =
  | 'pose-requires-runtime'
  | 'pose-unknown-drive'
  | 'pose-dependency-unsupported'
  | 'pose-invalid-value';

/** A pose that cannot be applied — `code` is the machine-readable reason. */
export class PoseError extends Error {
  constructor(readonly code: PoseErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PoseError';
  }
}

/** What the adapter needs from its caller (the viewer, or a test rig). */
export interface PoseContext {
  /** Every live drive. */
  readonly drives: readonly RVDrive[];
  /** Drive by node path; null when none. */
  drivePath(path: string): RVDrive | null;
  /** True when the measured tree is the editor (authoring) tree. */
  readonly editorTree: boolean;
}

/** One axis as it was applied (reported back to the caller). */
export interface AppliedAxis {
  readonly drive: string;
  readonly position: number;
  /** `explicit` = from the pose; `gear` = a Drive_Gear slave of a posed master. */
  readonly source: 'explicit' | 'gear';
}

interface Snapshot {
  readonly node: Object3D;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly matrix: Matrix4;
  readonly matrixWorld: Matrix4;
}

function resolveDrive(ctx: PoseContext, key: string): RVDrive | null {
  const byPath = ctx.drivePath(key);
  if (byPath) return byPath;
  const byName = ctx.drives.filter((d) => d.name === key);
  return byName.length === 1 ? byName[0] : null;
}

function depthOf(node: Object3D): number {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) d++;
  return d;
}

/** True when `value` is (or, for an array, contains) one of `drives`. */
function holdsDrive(value: unknown, drives: ReadonlySet<RVDrive>): boolean {
  if (value instanceof RVDrive) return drives.has(value);
  if (Array.isArray(value)) return value.some((v) => v instanceof RVDrive && drives.has(v));
  return false;
}

/**
 * Resolve `pose` into the full axis list (explicit + gear slaves), in apply
 * order (parents first). Throws {@link PoseError}. Pure — moves nothing.
 */
export function resolvePose(ctx: PoseContext, pose: PoseSpec): AppliedAxis[] {
  return planPose(ctx, pose).map(({ drive, position, source }) => ({ drive: drive.name, position, source }));
}

function planPose(ctx: PoseContext, pose: PoseSpec): Array<{ drive: RVDrive; position: number; source: 'explicit' | 'gear' }> {
  const keys = Object.keys(pose);
  if (keys.length === 0) return [];
  if (ctx.editorTree) {
    throw new PoseError('pose-requires-runtime',
      'A pose can only be set in the runtime (baked) tree — in the editor tree kinematic group members are not '
      + 'children of their axis. Measure without pose here, or switch to the runtime view.');
  }
  const values = new Map<RVDrive, { position: number; source: 'explicit' | 'gear' }>();
  for (const key of keys) {
    const v = Number(pose[key]);
    if (!Number.isFinite(v)) throw new PoseError('pose-invalid-value', `Pose value for "${key}" is not a number`, { drive: key });
    const drive = resolveDrive(ctx, key);
    if (!drive) throw new PoseError('pose-unknown-drive', `No drive "${key}" (use the drive's node path or unique name)`, { drive: key });
    values.set(drive, { position: v, source: 'explicit' });
  }
  // Drive_Gear slaves follow their master, state-free, until a fixpoint (chains).
  for (let changed = true; changed;) {
    changed = false;
    for (const d of ctx.drives) {
      if (values.has(d)) continue;
      for (const b of d.driveBehaviors) {
        if (!(b instanceof RVDriveGear)) continue;
        const master = b.masterDrive;
        const mv = master ? values.get(master) : undefined;
        if (!mv) continue;
        values.set(d, { position: mv.position * b.GearFactor + b.Offset, source: 'gear' });
        changed = true;
        break;
      }
    }
  }
  // Any other coupling to a posed axis cannot be computed without running it.
  const posed = new Set(values.keys());
  for (const d of ctx.drives) {
    if (posed.has(d)) continue;
    for (const b of d.driveBehaviors) {
      if (b instanceof RVDriveGear) continue;
      for (const field of Object.keys(b as object)) {
        if (holdsDrive((b as unknown as Record<string, unknown>)[field], posed)) {
          throw new PoseError('pose-dependency-unsupported',
            `Drive "${d.name}" is coupled to a posed axis through ${b.constructor?.name ?? 'a behavior'}.${field} — `
            + 'pose that axis explicitly as well.',
            { drive: d.name, behavior: b.constructor?.name ?? null, field });
        }
      }
    }
  }
  return [...values.entries()]
    .map(([drive, v]) => ({ drive, position: v.position, source: v.source }))
    .sort((a, b) => depthOf(a.drive.node) - depthOf(b.drive.node));
}

/**
 * Run `fn` with the axes of `pose` set, synchronously, and restore every node
 * transform afterwards — also when `fn` throws. `fn` must not await: the pose
 * exists only for the duration of the synchronous call. Returns `fn`'s result
 * and the applied axes.
 */
export function withPose<T>(ctx: PoseContext, pose: PoseSpec, fn: () => T): { result: T; axes: AppliedAxis[] } {
  const plan = planPose(ctx, pose);
  if (plan.length === 0) return { result: fn(), axes: [] };
  const snapshots: Snapshot[] = plan.map(({ drive }) => ({
    node: drive.node,
    position: drive.node.position.clone(),
    quaternion: drive.node.quaternion.clone(),
    matrix: drive.node.matrix.clone(),
    matrixWorld: drive.node.matrixWorld.clone(),
  }));
  try {
    for (const { drive, position } of plan) {
      const node = drive.node;
      // The linear unit conversion reads the parent's world matrix — an
      // ancestor axis posed a moment ago must be reflected in it.
      node.parent?.updateWorldMatrix(true, false);
      if (drive.computePoseTransform(position, node.position, node.quaternion)) {
        node.updateMatrix();
        node.updateMatrixWorld(true);
      }
    }
    const result = fn();
    return { result, axes: plan.map(({ drive, position, source }) => ({ drive: drive.name, position, source })) };
  } finally {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const s = snapshots[i];
      s.node.position.copy(s.position);
      s.node.quaternion.copy(s.quaternion);
      s.node.matrix.copy(s.matrix);
      s.node.matrixWorld.copy(s.matrixWorld);
    }
    // Descendant world matrices follow the restored nodes (outermost first).
    for (const s of snapshots) {
      for (const child of s.node.children) child.updateMatrixWorld(true);
    }
  }
}
