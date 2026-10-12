// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared rig for the plan-729 MechanismPath tests (9.1 / 9.2).
 *
 * A planar two-link arm built from the REAL components — `RVKinematicMechanism`,
 * two driven `RVKinematicJoint`s, two `RVDrive`s — and ticked in the production
 * order of one fixed step:
 *
 *   manager.tickPaths (PRE 20) → manager.tickTargets (PRE 40)
 *     → drives.update (drive stage) → manager.tickMechanisms (SIM 200)
 *
 * Geometry (world metres, all links unrotated): shoulder at the origin, elbow at
 * (0.4, 0.3, 0), tool tip = the `Fore` link origin at (0.8, 0, 0). Both arms are
 * 0.5 m long, so the reachable annulus is 0 < r ≤ 1 m in the XY plane — and the
 * AUTHORED pose is bent, which is exactly what a zeroed inverse warm start
 * (`inv_q = 0` = authored pose) needs to stay off the straight-arm singularity.
 *
 * Returns null when the kinematic wasm artifact is unavailable; callers skip
 * loudly through `requireRig(ctx, rig)`.
 */

import { Object3D, Scene, Vector3 } from 'three';
import { RVKinematicManager } from '@rv-private/kinematic-mechanism/rv-kinematic-manager';
import {
  RVKinematicJoint,
  RVKinematicMechanism,
  RVKinematicTarget,
} from '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import {
  RVMechanismPath,
  RVMechanismTarget,
  type MechanismInterpolation,
} from '@rv-private/kinematic-mechanism/rv-mechanism-path';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import {
  applySchema,
  getRegisteredFactories,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalReapplyRegistry } from '../src/core/engine/rv-signal-reapply-registry';
import { releaseAllAxes } from '../src/core/engine/rv-axis-ownership';

export const DT = 1 / 60;

export interface WaypointSpec {
  name: string;
  pos: [number, number, number];
  interp?: MechanismInterpolation;
  speed?: number;
  wait?: number;
  /** Name of a bool signal to raise on arrival (registered by the rig). */
  setSignal?: string;
}

export interface PathSpec {
  name?: string;
  waypoints: string[];
  loop?: boolean;
  linearSpeed?: number;
  linearAccel?: number;
  speedOverride?: number;
  /** Signals by name (registered by the rig as PLCOutputBool / PLCInputBool). */
  signalStart?: string;
  signalIsStarted?: string;
  signalEnded?: string;
  /** Name of another path in the same rig to chain to (raw StartNextPath). */
  startNext?: string;
}

export interface RigOptions {
  waypoints: WaypointSpec[];
  paths: PathSpec[];
  /** Drive speed in deg/s (default 90). */
  driveSpeed?: number;
  /** Drive acceleration in deg/s² (default 2000). */
  driveAccel?: number;
  useAcceleration?: boolean;
  /** Also create a KinematicTarget on the same mechanism (coexistence test). */
  withKinematicTarget?: boolean;
}

export interface PathRig {
  scene: Scene;
  root: Object3D;
  fore: Object3D;
  mech: RVKinematicMechanism;
  manager: RVKinematicManager;
  registry: NodeRegistry;
  store: SignalStore;
  reapply: SignalReapplyRegistry;
  drives: RVDrive[];
  paths: Record<string, RVMechanismPath>;
  path: RVMechanismPath;
  targets: Record<string, RVMechanismTarget>;
  kinematicTarget: RVKinematicTarget | null;
  /** Signal PATH (store address) by signal name. */
  signal: Record<string, string>;
  tick(dt?: number): void;
  /** Tick until `pred()` holds; returns the tick count, or -1 after `maxTicks`. */
  runUntil(pred: () => boolean, maxTicks?: number, each?: () => void): number;
  tip(out?: Vector3): Vector3;
  dispose(): void;
}

function ref(path: string, componentType = 'UnityEngine.Transform'): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType };
}

function makeJoint(node: Object3D, over: Partial<RVKinematicJoint>): RVKinematicJoint {
  const factory = getRegisteredFactories().get('KinematicJoint')!;
  const inst = factory.create(node, null) as RVKinematicJoint;
  factory.afterCreate?.(inst, node);
  Object.assign(inst, over);
  return inst;
}

function makeDrive(node: Object3D, speed: number, accel: number, useAccel: boolean): RVDrive {
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.RotationZ;
  drive.TargetSpeed = speed;
  drive.Acceleration = accel;
  drive.UseAcceleration = useAccel;
  drive.initDrive();
  return drive;
}

export async function buildArmRig(opts: RigOptions): Promise<PathRig | null> {
  const manager = new RVKinematicManager();
  const ok = await manager.ensureSolverLoaded();
  if (!ok) {
    manager.dispose();
    return null;
  }

  const scene = new Scene();
  const root = new Object3D(); root.name = 'Arm'; scene.add(root);
  // The drives sit AT the joint pivots and carry their Body B as a child — the
  // authored shape of a real asset: an actively driven link is moved by its
  // Drive's own transform, the mechanism only poses the passive links.
  const base = new Object3D(); base.name = 'Base'; root.add(base);
  const m1 = new Object3D(); m1.name = 'M1'; root.add(m1);
  const upper = new Object3D(); upper.name = 'Upper'; upper.position.set(0.4, 0.3, 0); m1.add(upper);
  const m2 = new Object3D(); m2.name = 'M2'; upper.add(m2);
  const fore = new Object3D(); fore.name = 'Fore'; fore.position.set(0.4, -0.3, 0); m2.add(fore);
  const j1 = new Object3D(); j1.name = 'J1'; root.add(j1);
  const j2 = new Object3D(); j2.name = 'J2'; root.add(j2);
  const pathsNode = new Object3D(); pathsNode.name = 'Paths'; root.add(pathsNode);
  const signalsNode = new Object3D(); signalsNode.name = 'Signals'; root.add(signalsNode);
  scene.updateMatrixWorld(true);

  const speed = opts.driveSpeed ?? 90;
  const accel = opts.driveAccel ?? 2000;
  const useAccel = opts.useAcceleration ?? true;
  const d1 = makeDrive(m1, speed, accel, useAccel);
  const d2 = makeDrive(m2, speed, accel, useAccel);

  // Anchors in each body's own frame, millimetres (see contact-e2e for the convention).
  makeJoint(j1, {
    JointType: 'Revolute', BodyA: base, BodyB: upper,
    AnchorA: new Vector3(0, 0, 0), AnchorB: new Vector3(-400, -300, 0),
    AxisA: new Vector3(0, 0, 1), DrivenBy: d1,
  });
  makeJoint(j2, {
    JointType: 'Revolute', BodyA: upper, BodyB: fore,
    AnchorA: new Vector3(0, 0, 0), AnchorB: new Vector3(-400, 300, 0),
    AxisA: new Vector3(0, 0, 1), DrivenBy: d2,
  });

  const mech = new RVKinematicMechanism(root);
  mech.build();
  manager.register(mech);
  manager.notifyBuilt(mech);

  const registry = new NodeRegistry();
  const store = new SignalStore();
  const reapply = new SignalReapplyRegistry();
  const signal: Record<string, string> = {};
  const addSignal = (name: string, plcType: string): string => {
    if (signal[name]) return signal[name];
    const n = new Object3D(); n.name = name; signalsNode.add(n);
    const p = NodeRegistry.computeNodePath(n);
    registry.registerNode(p, n);
    store.register(name, p, false, plcType);
    signal[name] = p;
    return p;
  };

  scene.traverse((n) => {
    if (!n.parent) return;
    registry.registerNode(NodeRegistry.computeNodePath(n), n);
  });
  registry.register('KinematicMechanism', NodeRegistry.computeNodePath(root), mech);

  const ctx = { registry, signalStore: store, reapply, kinematicManager: manager } as unknown as ComponentContext;

  // Waypoints.
  const targets: Record<string, RVMechanismTarget> = {};
  const tFactory = getRegisteredFactories().get('MechanismTarget')!;
  for (const wp of opts.waypoints) {
    const n = new Object3D(); n.name = wp.name; n.position.set(...wp.pos); pathsNode.add(n);
    const p = NodeRegistry.computeNodePath(n);
    registry.registerNode(p, n);
    const extras: Record<string, unknown> = {
      InterpolationToTarget: wp.interp ?? 'Linear',
      WaitForSeconds: wp.wait ?? 0,
    };
    if (wp.speed !== undefined) extras.SpeedToTarget = wp.speed;
    n.userData.realvirtual = { MechanismTarget: extras };
    const inst = tFactory.create(n, null) as RVMechanismTarget;
    tFactory.afterCreate?.(inst, n);
    applySchema(inst as unknown as Record<string, unknown>, RVMechanismTarget.schema, extras);
    if (wp.setSignal) inst.SetSignal = addSignal(wp.setSignal, 'PLCInputBool');
    registry.register('MechanismTarget', p, inst);
    targets[wp.name] = inst;
  }
  scene.updateMatrixWorld(true);

  // Paths — all created and registered BEFORE any init, so StartNextPath resolves.
  const paths: Record<string, RVMechanismPath> = {};
  const pFactory = getRegisteredFactories().get('MechanismPath')!;
  const specs = opts.paths.map((spec, i) => ({ spec, name: spec.name ?? (i === 0 ? 'Path' : `Path${i}`) }));
  const pathNodes: Record<string, string> = {};
  for (const { name } of specs) {
    const n = new Object3D(); n.name = name; pathsNode.add(n);
    const p = NodeRegistry.computeNodePath(n);
    registry.registerNode(p, n);
    pathNodes[name] = p;
  }
  for (const { spec, name } of specs) {
    const n = registry.getNode(pathNodes[name])!;
    const extras: Record<string, unknown> = {
      Mechanism: ref(NodeRegistry.computeNodePath(root), 'realvirtual.KinematicMechanism'),
      TargetLink: ref(NodeRegistry.computeNodePath(fore)),
      Path: spec.waypoints.map((w) => ref(NodeRegistry.computeNodePath(targets[w].node), 'MechanismTarget')),
      LoopPath: spec.loop ?? false,
      SpeedOverride: spec.speedOverride ?? 1,
      LinearSpeedToTarget: spec.linearSpeed ?? 200,
      LinearAcceleration: spec.linearAccel ?? 1000,
    };
    if (spec.startNext) extras.StartNextPath = ref(pathNodes[spec.startNext], 'MechanismPath');
    n.userData.realvirtual = { MechanismPath: extras };
    const inst = pFactory.create(n, null) as RVMechanismPath;
    pFactory.afterCreate?.(inst, n);
    applySchema(inst as unknown as Record<string, unknown>, RVMechanismPath.schema, extras);
    inst.Mechanism = mech;
    inst.TargetLink = fore;
    inst.SignalStart = spec.signalStart ? addSignal(spec.signalStart, 'PLCOutputBool') : null;
    inst.SignalIsStarted = spec.signalIsStarted ? addSignal(spec.signalIsStarted, 'PLCInputBool') : null;
    inst.SignalEnded = spec.signalEnded ? addSignal(spec.signalEnded, 'PLCInputBool') : null;
    registry.register('MechanismPath', pathNodes[name], inst);
    paths[name] = inst;
  }
  for (const t of Object.values(targets)) t.init(ctx);
  for (const p of Object.values(paths)) p.init(ctx);

  let kinematicTarget: RVKinematicTarget | null = null;
  if (opts.withKinematicTarget) {
    const n = new Object3D(); n.name = 'KT'; n.position.set(0.8, 0, 0); root.add(n);
    kinematicTarget = new RVKinematicTarget(n);
    kinematicTarget.Mechanism = mech;
    kinematicTarget.TargetLink = fore;
    kinematicTarget.init(ctx);
  }

  const drives = [d1, d2];
  const tipScratch = new Vector3();
  const rig: PathRig = {
    scene, root, fore, mech, manager, registry, store, reapply, drives,
    paths, path: paths[specs[0].name], targets, kinematicTarget, signal,
    tick(dt = DT): void {
      manager.tickPaths(dt);
      manager.tickTargets();
      for (const d of drives) d.update(dt);
      manager.tickMechanisms(dt);
    },
    runUntil(pred, maxTicks = 2000, each): number {
      for (let i = 1; i <= maxTicks; i++) {
        rig.tick();
        each?.();
        if (pred()) return i;
      }
      return -1;
    },
    tip(out = tipScratch): Vector3 {
      fore.updateWorldMatrix(true, false);
      return fore.getWorldPosition(out);
    },
    dispose(): void {
      for (const p of Object.values(paths)) p.dispose();
      kinematicTarget?.dispose();
      manager.dispose();
      releaseAllAxes();
    },
  };
  return rig;
}

/** Skip loudly when the solver artifact is missing (mechanism-inverse pattern). */
export function requireRig(
  ctx: { skip: (note?: string) => void },
  rig: PathRig | null,
): rig is PathRig {
  if (!rig) {
    ctx.skip('rv_kinematic_solver.wasm unavailable — plan-404 artifact missing');
    return false;
  }
  return true;
}

/** Distance of `p` from the infinite line through `a` → `b`, metres. */
export function distanceToLine(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = new Vector3().subVectors(b, a);
  const len = ab.length();
  if (len < 1e-12) return p.distanceTo(a);
  const ap = new Vector3().subVectors(p, a);
  return ap.cross(ab).length() / len;
}
