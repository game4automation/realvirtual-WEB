// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared synthetic fixture for the ribbon-handling tests (plan-459, reworked for
 * driven rollers by plan-460).
 *
 * There is no Unity-exported web GLB (the Unity port is a follow-up plan), so
 * the integration tests build their scene programmatically — the same approach
 * `tests/chain-fixture.ts` and `tests/energy-chain-fixture.ts` take.
 *
 * The fixture is shaped so it can be swapped for a real GLB without touching the
 * assertions: {@link ribbonHarness} returns the scene plus the registry, and the
 * `*Extras()` helpers produce exactly the rv_extras wire blocks a Unity export
 * must emit.
 *
 * Geometry: rollers sit on the X/Y plane of the path node with a common **Z**
 * axis, at the positions the caller gives — so a test can state its expected
 * path length analytically.
 *
 * ## Driven rollers (plan-460)
 *
 * A web is moved ONLY by a rotational `Drive` on a roller node. A spec marked
 * `driven: true` gets one, registered under the roller's own path exactly as the
 * loader would register it. {@link RibbonWebDriver} is the convenience on top:
 * it converts a target WEB speed in mm/s into the deg/s the driven rollers must
 * turn at, recomputed per tick so a winder whose radius shrinks still delivers
 * the commanded surface speed.
 *
 * `h.step(dt)` is the production tick order — drives first, then the web — and
 * is what a test should use. Reading the drive position difference is the whole
 * point of plan-460's sign handling, so a test that updates the manager before
 * moving the drives would legitimately see zero.
 *
 * NOT a `.test.ts` file, so vitest does not collect it.
 */

import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RibbonManager } from '../src/core/engine/rv-ribbon-manager';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { getComponentInstances } from '../src/core/engine/rv-component-registry';
import type { RuntimeNodeDeps } from '../src/core/engine/rv-scene-loader';
import type { RVRibbonPath } from '../src/core/engine/rv-ribbon-path';
import type { RVRibbonDancer } from '../src/core/engine/rv-ribbon-dancer';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { MM_TO_METERS } from '../src/core/engine/rv-constants';

/** rad -> deg. */
const RAD_TO_DEG = 180 / Math.PI;

/**
 * The minimum of `RVDrive` a driven roller reads: a signed position, the rotary
 * flag and the local axis. `currentSpeed` is kept because the DRIVE gizmo and
 * older helpers read it — plan-460 deliberately does NOT.
 */
export class FakeDrive {
  currentPosition = 0;
  currentSpeed = 0;
  targetPosition = 0;
  jogForward = false;
  jogBackward = false;
  /** Rotational unless a test says otherwise (a linear drive must be refused). */
  isRotary = true;
  /** Local drive axis, `ReverseDirection` already folded in (as `RVDrive.getAxis`). */
  readonly axis = new Vector3(0, 0, 1);

  getAxis(out: Vector3 = new Vector3()): Vector3 {
    return out.copy(this.axis);
  }

  /** Set a jog speed (signed) — the shape `RVDrive.updateJog` produces. */
  jog(speed: number): void {
    this.currentSpeed = speed;
    this.jogForward = speed > 0;
    this.jogBackward = speed < 0;
  }

  /** Advance the position as the real drive would, so deltas stay consistent. */
  tick(dt: number): void {
    this.currentPosition += this.currentSpeed * dt;
  }

  reset(): void {
    this.currentPosition = 0;
    this.currentSpeed = 0;
    this.jogForward = false;
    this.jogBackward = false;
  }
}

/**
 * Commands a WEB speed in mm/s and turns the driven rollers accordingly.
 *
 * The conversion `omega = v / r` uses the roller's CURRENT radius, so a shrinking
 * unwinder or a growing rewinder keeps delivering the commanded surface speed —
 * which is what makes the plan-459 winder assertions (`v * dt` of length per
 * tick) hold unchanged under the plan-460 speed model.
 */
export class RibbonWebDriver {
  /** Driven roller name -> its drive. */
  readonly drives = new Map<string, FakeDrive>();
  /** Driven roller name -> commanded surface speed in mm/s. */
  private readonly _targets = new Map<string, number>();
  private _default = 0;

  constructor(private readonly _radiusOf: (name: string) => number) {}

  /** mm/s — command every driven roller to this surface speed. */
  jog(vMmPerS: number): void {
    this._default = vMmPerS;
    this._targets.clear();
    for (const drive of this.drives.values()) drive.jog(0);
  }

  /** mm/s — command ONE driven roller, overriding {@link jog} for it. */
  jogRoller(name: string, vMmPerS: number): void {
    this._targets.set(name, vMmPerS);
  }

  /** mm/s — the surface speed currently commanded for `name`. */
  targetOf(name: string): number {
    return this._targets.get(name) ?? this._default;
  }

  /** The drive of one driven roller (for axis / linear-drive tests). */
  driveOf(name: string): FakeDrive | undefined {
    return this.drives.get(name);
  }

  /** Advance every driven roller's drive by `omega * dt` degrees. */
  tick(dt: number): void {
    for (const [name, drive] of this.drives) {
      const r = this._radiusOf(name);
      if (!(r > 0)) continue;
      const v = this.targetOf(name);
      const omegaDegPerS = (v / r) * RAD_TO_DEG;
      drive.currentSpeed = omegaDegPerS;
      drive.jogForward = omegaDegPerS > 0;
      drive.jogBackward = omegaDegPerS < 0;
      drive.currentPosition += omegaDegPerS * dt;
    }
  }

  reset(): void {
    this._default = 0;
    this._targets.clear();
    for (const drive of this.drives.values()) drive.reset();
  }
}

/** A roller spec in millimetres, in the path node's X/Y plane. */
export interface RollerSpec {
  name: string;
  xMm: number;
  yMm: number;
  /** mm — the authored radius (also the mesh size, so a measurement matches). */
  radiusMm: number;
  side?: 'Left' | 'Right';
  /** Make it a `RibbonWinder` instead of a plain `RibbonRoller`. */
  winder?: boolean;
  /** Make it a `RibbonDancer` instead of a plain `RibbonRoller`. */
  dancer?: boolean;
  /** Put a rotational `Drive` on its node — this roller drives the web. */
  driven?: boolean;
  /** Local axis of that drive; default `(0,0,1)`, i.e. parallel to `Axis: 'Z'`. */
  driveAxis?: [number, number, number];
  /** Make the drive LINEAR (which must NOT move a web). */
  driveIsLinear?: boolean;
  /** Extra rv_extras fields for the component. */
  extras?: Record<string, unknown>;
}

export interface RibbonHarness {
  scene: Scene;
  root: Object3D;
  /** The node that carries the `RibbonPath` rv_extras. */
  path: Object3D;
  /** Roller nodes, by spec name. */
  nodes: Map<string, Object3D>;
  /** The web-speed façade over every driven roller's drive. */
  drive: RibbonWebDriver;
  registry: NodeRegistry;
  signalStore: SignalStore;
  transportManager: RVTransportManager;
  ribbonManager: RibbonManager;
  deps: RuntimeNodeDeps;
  /** The tick list a loader-constructed REAL `RVDrive` lands in. */
  driveHost: { drives: RVDrive[] };
  /** Construct the `RibbonPath` on {@link path} through the loader. */
  buildPath(overrides?: Record<string, unknown>): RVRibbonPath;
  /** Add a SECOND path node over the given rollers (slitter fixtures). */
  addPath(name: string, rollerNames: string[], overrides?: Record<string, unknown>): RVRibbonPath;
  /** One production tick: advance the drives, then the web. */
  step(dt: number): void;
  /** The roller/winder/dancer component on a spec node. */
  roller(name: string): { radiusMm: number; angle: number } & Record<string, unknown>;
  /** The dancer component on a spec node. */
  dancer(name: string): RVRibbonDancer;
  /** Add a rotational `Drive` to a roller node AFTER the path was built. */
  addDrive(name: string, axis?: [number, number, number]): FakeDrive;
  /** Remove the `Drive` from a roller node again. */
  removeDrive(name: string): void;
}

/** A box mesh sized so `measureRadiusMm` returns `radiusMm` about the Z axis. */
function rollerMesh(radiusMm: number): Mesh {
  const r = radiusMm / MM_TO_METERS;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([
    -r, -r, -r, r, -r, -r, r, r, -r,
    -r, -r, r, r, -r, r, r, r, r,
  ]), 3));
  return new Mesh(geo, new MeshStandardMaterial());
}

/**
 * A registered scene with one `RibbonPath` node and N roller/winder/dancer
 * nodes. Nothing is constructed yet — call {@link RibbonHarness.buildPath}.
 */
export function ribbonHarness(specs: RollerSpec[]): RibbonHarness {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);

  const path = new Object3D();
  path.name = 'Ribbon';
  root.add(path);

  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  registry.registerNode('Root/Web', path);

  const nodes = new Map<string, Object3D>();
  for (const spec of specs) {
    const node = new Object3D();
    node.name = spec.name;
    node.position.set(spec.xMm / MM_TO_METERS, spec.yMm / MM_TO_METERS, 0);
    node.add(rollerMesh(spec.radiusMm));
    // A roll child so a RibbonWinder has something to scale (and so the authored,
    // deliberately NON-UNIT scale is exercised by the export test).
    if (spec.winder) {
      const roll = new Object3D();
      roll.name = 'Roll';
      roll.scale.set(2, 1, 2);
      node.add(roll);
      registry.registerNode(`Root/${spec.name}/Roll`, roll);
    }
    root.add(node);
    registry.registerNode(`Root/${spec.name}`, node);
    nodes.set(spec.name, node);
  }

  const componentOf = (name: string): Record<string, unknown> => {
    const node = nodes.get(name);
    const instances = node ? getComponentInstances(node) : [];
    return (instances[0] ?? {}) as Record<string, unknown>;
  };
  const radiusOf = (name: string): number => {
    const inst = componentOf(name) as { radiusMm?: number };
    return typeof inst.radiusMm === 'number' ? inst.radiusMm : 0;
  };

  const drive = new RibbonWebDriver(radiusOf);
  const registerDrive = (name: string, axis: [number, number, number], linear: boolean): FakeDrive => {
    const fake = new FakeDrive();
    fake.axis.set(axis[0], axis[1], axis[2]);
    fake.isRotary = !linear;
    registry.register('Drive', `Root/${name}`, fake);
    drive.drives.set(name, fake);
    return fake;
  };
  for (const spec of specs) {
    if (!spec.driven) continue;
    registerDrive(spec.name, spec.driveAxis ?? [0, 0, 1], spec.driveIsLinear === true);
  }

  scene.updateMatrixWorld(true);

  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const ribbonManager = new RibbonManager();

  // A drive lifecycle host, so a test may construct a REAL `RVDrive` on a roller
  // node through the loader (`constructComponentOnNode`) instead of a FakeDrive.
  const driveHost = {
    drives: [] as RVDrive[],
    addDrive(d: RVDrive): boolean {
      if (driveHost.drives.includes(d)) return false;
      driveHost.drives.push(d);
      return true;
    },
    removeDrive(d: RVDrive): boolean {
      const i = driveHost.drives.indexOf(d);
      if (i < 0) return false;
      driveHost.drives.splice(i, 1);
      return true;
    },
  };

  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager, ribbonManager, driveHost,
  };

  // Rollers first: a RibbonPath resolves them through the component instances.
  const constructRollers = (): void => {
    for (const spec of specs) {
      const node = nodes.get(spec.name)!;
      if (node.userData.realvirtual) continue;
      const type = spec.winder ? 'RibbonWinder' : spec.dancer ? 'RibbonDancer' : 'RibbonRoller';
      const data: Record<string, unknown> = {
        RadiusMm: spec.radiusMm,
        Axis: 'Z',
        RibbonSide: spec.side ?? 'Left',
        ...(spec.winder
          ? {
            CoreRadiusMm: 76.2,
            RibbonThicknessMm: 0.1,
            InitialWoundLengthMm: -1,
            RollMesh: transformRef(`Root/${spec.name}/Roll`),
          }
          : {}),
        ...(spec.dancer
          ? { TravelAxis: 'Y', TravelMinMm: -200, TravelMaxMm: 200, HomeMm: 0, Strands: 2 }
          : {}),
        ...(spec.extras ?? {}),
      };
      node.userData.realvirtual = { [type]: data };
      constructComponentOnNode(deps, node, type, data);
    }
  };

  const makePath = (node: Object3D, rollerNames: string[], overrides: Record<string, unknown>): RVRibbonPath => {
    constructRollers();
    const data: Record<string, unknown> = {
      Rollers: rollerNames.map((n) => transformRef(`Root/${n}`)),
      RibbonWidthMm: 500,
      RibbonThicknessMm: 0.1,
      TextureLengthMm: 1000,
      SamplesPerMeter: 64,
      ...overrides,
    };
    node.userData.realvirtual = { RibbonPath: data };
    return constructComponentOnNode(deps, node, 'RibbonPath', data) as RVRibbonPath;
  };

  return {
    scene, root, path, nodes, drive, registry, signalStore, transportManager, ribbonManager, deps, driveHost,
    buildPath(overrides: Record<string, unknown> = {}) {
      return makePath(path, specs.map((s) => s.name), overrides);
    },
    addPath(name: string, rollerNames: string[], overrides: Record<string, unknown> = {}) {
      const node = new Object3D();
      node.name = name;
      root.add(node);
      registry.registerNode(`Root/${name}`, node);
      scene.updateMatrixWorld(true);
      return makePath(node, rollerNames, overrides);
    },
    step(dt: number) {
      drive.tick(dt);
      ribbonManager.update(dt);
    },
    roller(name: string) {
      return componentOf(name) as { radiusMm: number; angle: number } & Record<string, unknown>;
    },
    dancer(name: string) {
      return componentOf(name) as unknown as RVRibbonDancer;
    },
    addDrive(name: string, axis: [number, number, number] = [0, 0, 1]) {
      return registerDrive(name, axis, false);
    },
    removeDrive(name: string) {
      registry.unregisterComponent('Drive', `Root/${name}`);
      drive.drives.delete(name);
    },
  };
}

/** A wire-format node `ComponentReference` exactly as the Unity exporter writes it. */
export function transformRef(path: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType: 'UnityEngine.Transform' };
}

/** A wire-format drive `ComponentReference`. */
export function driveRef(path: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType: 'realvirtual.Drive' };
}

/** A wire-format signal `ComponentReference`. */
export function signalRef(path: string, componentType: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType };
}
