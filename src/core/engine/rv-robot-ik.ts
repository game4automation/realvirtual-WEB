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
import type { NodeRegistry } from './rv-node-registry';
import type { RVDrive } from './rv-drive';
import type { RVIKPath } from './rv-ik-path';
import { isRef, resolveAxisDrivesFromNode } from './rv-ik-path';
import { directionToGltfAxis, isRotation } from './rv-coordinate-utils';
import type { JointChainParams, OpwParams } from './rv-ik-solver';
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

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this._registry = context.registry;
    this._axisDrives = this.resolveAxisDrives(context.registry);
    debug('loader', `  RobotIK: ${this.node.name} axes=${this._axisDrives.length} wrist=${this.WristType}`);
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
  }

  /** Ordered axis drives (Axis[0..5]) resolved from the serialized RobotIK.Axis. */
  getAxisDrives(): RVDrive[] {
    return this._axisDrives;
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
    if (!this._jointChainComputed) {
      this._jointChainComputed = true;
      this._jointChain = this.computeJointChain();
    }
    return this._jointChain;
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
    if (drives.length !== 6) return null;

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
      if (!isRotation(drive.Direction)) return null;
      const axisNode = drive.node;
      const prevNode = i === 0 ? this.node : drives[i - 1].node;
      const parent = axisNode.parent;
      if (!parent) return null;
      // prev must be an ancestor of the axis node (otherwise the rig is not a
      // serial chain and the segment folding below would be meaningless).
      let a: Object3D | null = parent;
      while (a && a !== prevNode) a = a.parent;
      if (!a) return null;

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
      // Same scale normalization as targetPoseInBase: chain and target must live
      // in the same scale-free (meter) frame.
      axisHomePos[i * 3 + 0] = pos.x / (scl.x || 1);
      axisHomePos[i * 3 + 1] = pos.y / (scl.y || 1);
      axisHomePos[i * 3 + 2] = pos.z / (scl.z || 1);
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
      tcpLocalOffset = [pos.x / (scl.x || 1), pos.y / (scl.y || 1), pos.z / (scl.z || 1)];
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
    const path = typeof ref === 'string' && ref.length > 0 ? ref : isRef(ref) ? ref.path : null;
    if (!path) return null;
    return this._registry.getNode(path);
  }

  private resolveAxisDrives(registry: NodeRegistry): RVDrive[] {
    return resolveAxisDrivesFromNode(registry, this.node);
  }
}

registerComponent({
  type: 'RobotIK',
  schema: RVRobotIK.schema,
  capabilities: {
    selectable: true,
    inspectorVisible: true,
    hierarchyVisible: true,
    badgeColor: '#7e57c2',
    filterLabel: 'Robots',
  },
  create: (node: Object3D) => new RVRobotIK(node),
});
