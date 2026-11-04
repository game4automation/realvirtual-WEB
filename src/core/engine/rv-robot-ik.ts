// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-ik.ts — TypeScript pendant of RobotIK.cs (realvirtual Robotics Pro).
 *
 * Marks a robot node and resolves its ordered axis drives + child IK paths.
 * Registering it makes "RobotIK" show as a component chip in the hierarchy /
 * inspector (like Drive, IKPath, IKTarget). The actual IK replay/motion is
 * driven by RVIKPath; RobotIK is the anchor that the path visualizer and (later)
 * the interactive solver hang off.
 *
 * Property parity: schema keys = GLB extras keys = C# field names (PascalCase).
 * Object refs (Axis[]) are read from raw node extras in init() (resolveComponentRefs
 * mutates instance ref fields — see RVIKPath for the same pattern).
 */

import type { Object3D } from 'three';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import type { RVDrive } from './rv-drive';
import type { RVIKPath } from './rv-ik-path';
import { isRef, resolveAxisDrivesFromNode } from './rv-ik-path';
import { storedReferenceValue } from './rv-node-path-rewrite.mjs';
import { directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import type { JointChainParams, OpwParams } from './rv-ik-solver';
import {
  clearRobotIkProblems,
  reportRobotIkAxesUnresolved,
  reportRobotIkChainUnresolved,
  reportRobotIkOpwUnusable,
  reportRobotIkTcpUnresolved,
  reportRobotIkWristTypeMissing,
} from '../hmi/problems-store';
import { debug } from './rv-debug';

export class RVRobotIK implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RobotIK');

  readonly node: Object3D;
  isOwner = true;

  WristType: 'Spherical' | 'NonSpherical' = 'Spherical';
  ElbowInUnityX = false;
  DrawGizmos = true;

  private _registry: NodeRegistry | null = null;
  private _axisDrives: RVDrive[] = [];
  private _jointChain: JointChainParams | null = null;
  private _jointChainComputed = false;
  /** Why the last derivation attempt returned null — the `detail` of the Problems entry. */
  private _chainFailure: string | null = null;
  /** The rig shape the last FAILED attempt saw (see {@link chainShapeSignature}). */
  private _chainShape = 0;
  /** Resolved once in `init()` — the Problems entries key and display on it. */
  private _nodePath = '';

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this._registry = context.registry;
    this._axisDrives = this.resolveAxisDrives(context.registry);
    this._nodePath = context.registry.getPathForNode(this.node) ?? NodeRegistry.computeNodePath(this.node);
    debug('loader', `  RobotIK: ${this.node.name} axes=${this._axisDrives.length} wrist=${this.WristType}`);
    // Paths WITHOUT an onSceneReady pass (createRuntimeNode, constructComponentOnNode)
    // have no re-parenting left to happen, so the rig is already final here and the
    // diagnosis can run — on the loading paths it waits for onSceneReady() below.
    if (!context.expectSceneReady) this.reportDiagnostics();
  }

  /** Warm the joint-chain cache while the drives are still at their home pose.
   *  Runs AFTER the loader's kinematic re-parenting (Phase 8b) — computing in
   *  init() would snapshot a hierarchy that re-parenting may still change. */
  onSceneReady(): void {
    // matrixWorld may not have been computed yet at this loader phase (the
    // global refresh runs later). Pre-freeze (Phase 11) the local transforms
    // are still authoritative, so refreshing here is safe — post-freeze it
    // would corrupt baked matrices and must never be done (see edit plugin).
    this.node.updateWorldMatrix(true, true);
    this.getJointChain();
    this.reportDiagnostics();
  }

  /**
   * Put everything this robot quietly cannot do into the Problems panel.
   *
   * Runs ONCE per load (after the kinematic re-parenting, so a chain that only
   * becomes serial there is not blamed), clears first so a repaired rig loses
   * its entry, and reports nothing when the rig is sound. It is pure
   * diagnosis — no fallback, no correction, no change to any computed value.
   */
  private reportDiagnostics(): void {
    const path = this._nodePath || this.node.name;
    clearRobotIkProblems(path);
    const label = this.node.name || path;
    const subject = { nodePath: path, label };
    const raw = this.rawExtras();

    // No axes at all: the robot cannot move by any route, so it is reported on
    // its own rather than as a chain reason the user cannot act on.
    const declaredAxes = Array.isArray(raw?.['Axis']) ? (raw['Axis'] as unknown[]).length : 0;
    if (this._axisDrives.length === 0) {
      reportRobotIkAxesUnresolved({ ...subject, declared: declaredAxes });
    } else if (!this.getJointChain()) {
      reportRobotIkChainUnresolved({
        ...subject,
        reason: this._chainFailure ?? 'The axis drives do not form a serial 6-revolute chain.',
      });
    }

    // A TCP written in the file that names nothing is a silent whole-tool pose
    // error (the chain collapses onto the axis-6 flange). A robot with NO TCP at
    // all is the documented flange-plus-toolOffset case and not a problem.
    const writtenTcp = this.writtenTcpReference();
    if (writtenTcp !== null && !this.resolveTcpNode()) {
      reportRobotIkTcpUnresolved({ ...subject, written: writtenTcp });
    }

    if (!this.getOpwParams()) reportRobotIkOpwUnusable(subject);

    // The schema default is 'Spherical', so an export that predates the field
    // silently solves a cobot with the wrong model.
    if (raw && raw['WristType'] === undefined) {
      reportRobotIkWristTypeMissing({ ...subject, assumed: this.WristType });
    }
  }

  /** The raw `RobotIK` extras of this node — the untouched export, as every
   *  other reader here uses them (instance ref fields are mutated before init). */
  private rawExtras(): Record<string, unknown> | undefined {
    return (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
  }

  /** The TCP reference AS WRITTEN, for the Problems detail — null when the file
   *  carries none (which is a supported rig, not a defect). */
  private writtenTcpReference(): string | null {
    const ref = this.rawExtras()?.['TCP'];
    if (typeof ref === 'string') return ref.length > 0 ? ref : null;
    if (!isRef(ref)) return null;
    const stored = storedReferenceValue(ref);
    return typeof stored === 'string' && stored.length > 0 ? stored : JSON.stringify(stored);
  }

  /** Ordered axis drives (Axis[0..5]) resolved from the serialized RobotIK.Axis. */
  getAxisDrives(): RVDrive[] {
    return this._axisDrives;
  }

  /**
   * The serialized `RobotIK.ToolOffset`, verbatim — a raw Unity Vector3 in
   * Unity-local units, NOT converted to the glTF frame.
   *
   * Read separately from {@link getOpwParams} on purpose: that getter returns
   * null for a rig without a finite `a1`, and the program export (plan-773
   * Phase 4) needs the tool offset even then, exactly like Unity's exporter
   * which reads `robot.ToolOffset` independently of a1..c4
   * (`IKPathToProgram.cs:62`). Unity applies no handedness conversion to it
   * either and says why in the same line: approximate, not a verified
   * right-handed tool frame.
   */
  getToolOffset(): [number, number, number] {
    const to = this.rawExtras()?.['ToolOffset'] as { x?: number; y?: number; z?: number } | undefined;
    return [+(to?.x ?? 0), +(to?.y ?? 0), +(to?.z ?? 0)];
  }

  /** OPW/Pieper solver parameters from the serialized RobotIK extras.
   *  Returns null if the robot has no analytical params (non-OPW / not rigged). */
  getOpwParams(): OpwParams | null {
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
    if (!raw || !Number.isFinite(+(raw['a1'] as number))) return null;
    const to = (raw['ToolOffset'] as { x?: number; y?: number; z?: number } | undefined) ?? {};
    return {
      a1: +(raw['a1'] as number), a2: +(raw['a2'] as number), b: +(raw['b'] as number),
      c1: +(raw['c1'] as number), c2: +(raw['c2'] as number), c3: +(raw['c3'] as number), c4: +(raw['c4'] as number),
      elbowInUnityX: !!raw['ElbowInUnityX'],
      toolOffset: [to.x ?? 0, to.y ?? 0, to.z ?? 0],
    };
  }

  /**
   * Per-axis kinematic chain for the numerical Cobot solver (plan-233 Phase 2).
   * Derived from the scene graph: for each axis the home transform relative to
   * the PREVIOUS axis node (i=0: relative to the robot root), with any static
   * intermediate nodes folded into the segment. Computed once and cached — the
   * cache is warmed in onSceneReady() while all drives are at their home pose
   * (the derivation itself is joint-state independent, see computeJointChain).
   * Returns null when the robot is not a valid 6-revolute-axis chain → callers
   * fall back to the analytic Pieper solve.
   */
  getJointChain(): JointChainParams | null {
    if (this._jointChain) return this._jointChain;
    // A FAILED derivation must not be frozen. It used to be: `_jointChainComputed`
    // was set BEFORE the computation, so a rig whose axes were not yet nested when
    // the cache was warmed could never solve again — not after a re-parent, not
    // after a repair, never. A failure is therefore repeated, but only when the
    // shape it depends on actually changed; a per-frame caller asking a genuinely
    // broken rig pays one allocation-free integer fold.
    const shape = this.chainShapeSignature();
    if (this._jointChainComputed && shape === this._chainShape) return null;
    this._jointChainComputed = true;
    this._chainShape = shape;
    this._chainFailure = null;
    this._jointChain = this.computeJointChain();
    return this._jointChain;
  }

  /**
   * Allocation-free fingerprint of everything a FAILED chain derivation depends
   * on: how many axis drives there are and which node each axis hangs under.
   * Re-parenting — the one thing that turns a non-serial rig into a serial one —
   * changes it; a frame in which nothing moved does not. `Object3D.id` is a
   * stable integer per object, so this is integer arithmetic only.
   */
  private chainShapeSignature(): number {
    const drives = this._axisDrives;
    let h = drives.length;
    for (let i = 0; i < drives.length; i++) {
      h = (h * 31 + (drives[i].node.parent?.id ?? 0)) | 0;
    }
    return h;
  }

  /** The resolved TCP node (serialized RobotIK.TCP), or null when the robot has
   *  no TCP — used by the LIN replay to read the current tool pose. */
  getTcpNode(): Object3D | null {
    return this.resolveTcpNode();
  }

  /** All IK paths defined under this robot (children with an IKPath component). */
  getPaths(): RVIKPath[] {
    if (!this._registry) return [];
    return this._registry.findAllInChildren<RVIKPath>(this.node, 'IKPath').map((r) => r.instance);
  }

  private computeJointChain(): JointChainParams | null {
    const drives = this.getAxisDrives();
    if (drives.length !== 6) {
      this._chainFailure = `RobotIK.Axis resolved to ${drives.length} drive(s); the solver models exactly 6 revolute axes.`;
      return null;
    }

    const axisHomePos = new Float64Array(18);
    const axisHomeRot = new Float64Array(24);
    const axisDir = new Float64Array(18);

    // Cold path (once per robot) — locals are fine, no hot-path GC concern.
    const rel = new Matrix4();
    const home = new Matrix4();
    const pos = new Vector3();
    const quat = new Quaternion();
    const scl = new Vector3();
    const hp = new Vector3();
    const hq = new Quaternion();

    let anyLimits = false;

    for (let i = 0; i < 6; i++) {
      const drive = drives[i];
      // The solver models revolute joints only — a linear/virtual axis in the
      // chain would silently produce wrong FK, so bail to the Pieper fallback.
      if (!isRotation(drive.Direction)) {
        this._chainFailure = `${axisLabel(i, drive.node)} is a ${drive.Direction} drive; the solver models revolute joints only.`;
        return null;
      }
      const axisNode = drive.node;
      const prevNode = i === 0 ? this.node : drives[i - 1].node;
      const parent = axisNode.parent;
      if (!parent) {
        this._chainFailure = `${axisLabel(i, axisNode)} has no parent node — it is not part of the robot's hierarchy.`;
        return null;
      }
      // prev must be an ancestor of the axis node (otherwise the rig is not a
      // serial chain and the segment folding below would be meaningless).
      let a: Object3D | null = parent;
      while (a && a !== prevNode) a = a.parent;
      if (!a) {
        const expected = i === 0
          ? `the robot node "${this.node.name}"`
          : `${axisLabel(i - 1, prevNode)}`;
        this._chainFailure = `${axisLabel(i, axisNode)} is not a descendant of ${expected} `
          + `(its parent is "${parent.name || '(unnamed)'}"), so the axis nodes are siblings rather than a serial chain.`;
        return null;
      }

      // Home local matrix of the axis node itself. Use the drive's captured base
      // pose (NOT node.position/quaternion) so an already-applied StartPosition
      // does not leak into the chain.
      home.compose(drive.getHomeLocalPosition(hp), drive.getHomeLocalQuaternion(hq), axisNode.scale);
      // rel = prev⁻¹ · parent(axis) · home. prev's own joint rotation cancels
      // (parent(axis) lives inside prev's rotated subtree), leaving only the
      // static intermediate nodes folded into this segment. matrixWorld is read
      // directly — frozen nodes have it baked (updateWorldMatrix would corrupt).
      rel.copy(prevNode.matrixWorld).invert().multiply(parent.matrixWorld).multiply(home);
      rel.decompose(pos, quat, scl);
      // Same frame convention as targetPoseInBase in the `'chain'` frame
      // (plan-772 F5): the relative translation IS the segment offset, taken
      // as it is. `scl` is decomposed only because `Matrix4.decompose` needs
      // the out-parameter. This used to divide by it, which is wrong twice
      // over: a node's own scale is not part of its offset, and the sign
      // `decompose()` puts on `scale.x` for a mirrored node would flip the
      // segment. Measured consequence on the IRB2400 of DemoRobotIK.glb,
      // whose TCP node is authored with scale (0.5, 0.5, -0.5): the chain read
      // its tool as 0.8058 m where the serialized OPW parameters say 0.4029 m
      // — exactly twice as long, and mirrored (plan-772 B1).
      axisHomePos[i * 3 + 0] = pos.x;
      axisHomePos[i * 3 + 1] = pos.y;
      axisHomePos[i * 3 + 2] = pos.z;
      axisHomeRot[i * 4 + 0] = quat.x;
      axisHomeRot[i * 4 + 1] = quat.y;
      axisHomeRot[i * 4 + 2] = quat.z;
      axisHomeRot[i * 4 + 3] = quat.w;

      // Rotation axis of the drive in the axis node's LOCAL frame (glTF-space,
      // sign included — same mapping the drive itself uses in initDrive).
      const dir = directionToGltfAxis(drive.Direction);
      if (drive.ReverseDirection) dir.negate();
      axisDir[i * 3 + 0] = dir.x;
      axisDir[i * 3 + 1] = dir.y;
      axisDir[i * 3 + 2] = dir.z;

      if (drive.UseLimits) anyLimits = true;
    }

    // TCP relative to axis 5 (intermediate nodes folded). Without a TCP node the
    // chain FK targets the axis-5 flange and the OPW toolOffset carries the tool
    // shift inside the solver's Pieper cold-start.
    let tcpLocalOffset: [number, number, number] = [0, 0, 0];
    let tcpLocalRot: [number, number, number, number] = [0, 0, 0, 1];
    const tcpNode = this.resolveTcpNode();
    if (tcpNode) {
      rel.copy(drives[5].node.matrixWorld).invert().multiply(tcpNode.matrixWorld);
      rel.decompose(pos, quat, scl);
      // No scale division — see the axis segment above. This is the node that
      // made the defect measurable: the IRB's TCP is authored at scale
      // (0.5, 0.5, -0.5), so the division doubled and mirrored its tool.
      tcpLocalOffset = [pos.x, pos.y, pos.z];
      tcpLocalRot = [quat.x, quat.y, quat.z, quat.w];
    }

    const chain: JointChainParams = { axisHomePos, axisHomeRot, axisDir, tcpLocalOffset, tcpLocalRot };
    if (anyLimits) {
      const lower = new Float64Array(6);
      const upper = new Float64Array(6);
      for (let i = 0; i < 6; i++) {
        const d = drives[i];
        lower[i] = d.UseLimits ? d.LowerLimit : -360;
        upper[i] = d.UseLimits ? d.UpperLimit : 360;
      }
      chain.jointLimits = { lower, upper };
    }
    return chain;
  }

  /** Resolve the serialized RobotIK.TCP node ref from the raw extras (same
   *  raw-read pattern as getOpwParams — instance ref fields are mutated by
   *  resolveComponentRefs and must not be trusted).
   *
   *  TCP is a GameObject reference in Unity, which the exporter serializes as a
   *  plain node-path STRING (component refs become ComponentReference objects).
   *  Accept both forms — rejecting the string silently collapsed the chain TCP
   *  to the A6 flange (~0.24 m / 180° gripper pose error on the CRX). */
  private resolveTcpNode(): Object3D | null {
    if (!this._registry) return null;
    const raw = (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['RobotIK'];
    const ref = raw?.['TCP'];
    // plan-769 Phase 1b / 3: a stored reference of this file in any form — its
    // verdict, never a guess (a path string, a ComponentReference, an address).
    const stored = typeof ref === 'string' || isRef(ref) ? storedReferenceValue(ref) : null;
    if (stored === null) return null;
    return this._registry.storedNode(this.node, stored);
  }

  private resolveAxisDrives(registry: NodeRegistry): RVDrive[] {
    return resolveAxisDrivesFromNode(registry, this.node);
  }
}

/** `Axis[2] "J3"` — how a chain-derivation failure names the axis it tripped on. */
function axisLabel(index: number, node: Object3D): string {
  return `Axis[${index}] "${node.name || '(unnamed)'}"`;
}

registerComponent({
  type: 'RobotIK',
  schema: RVRobotIK.schema,
  capabilities: {
    pick: 'select',
    ui: { badge: '#7e57c2', filter: 'Robots', category: 'robotics' },
    // The rig of a library robot sits on its asset root (the chain base), so a
    // placed robot needs it on the placement root (2026-10-25, library CRX).
    carriesToPlacementRoot: true,
  },
  create: (node: Object3D) => new RVRobotIK(node),
});
