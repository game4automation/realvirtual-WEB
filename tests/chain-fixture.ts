// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared synthetic fixture for the plan-733 `Chain` tests.
 *
 * There is no Unity-exported chain GLB in the repository yet (the Unity export
 * side is Phase 3 of the plan), so the integration tests build their scene
 * programmatically — the same approach `tests/energy-chain-fixture.ts` takes.
 *
 * The fixture is deliberately shaped so it can be swapped for a real GLB later
 * without touching the assertions: {@link chainHarness} returns the scene plus
 * the registry, and {@link straightSpline} / {@link squareLoopSpline} produce
 * exactly the `Chain.Spline` wire block a Unity export must emit. When the
 * exporter lands, `tests/chain-glb-fixture.test.ts` loads the real file and
 * compares against the same expectations (plan test 9.4).
 *
 * NOT a `.test.ts` file, so vitest does not collect it.
 */

import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { ChainManager } from '../src/core/engine/rv-chain-manager';
import type { RuntimeNodeDeps } from '../src/core/engine/rv-scene-loader';

/** The `Chain.Spline` wire block: metres, chain-node local, arc-length equidistant. */
export interface SplineBlock {
  closed: boolean;
  length: number;
  samples: number[];
}

/**
 * A straight run of `lengthM` metres along +Z starting at the origin, with the
 * up vector constant at +Y. Every sample is exact, so a position assertion can
 * use the analytic value instead of a tolerance chosen to fit the code.
 */
export function straightSpline(lengthM = 2, sampleCount = 5): SplineBlock {
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const z = (lengthM * i) / (sampleCount - 1);
    samples.push(0, 0, z, 0, 0, 1, 0, 1, 0);
  }
  return { closed: false, length: lengthM, samples };
}

/**
 * A closed square loop in the XZ plane, side `sideM`, traversed
 * +Z → +X → −Z → −X. The last sample repeats the first, which is the `closed`
 * contract of the format. Up stays +Y; the tangent turns, so it also exercises
 * the tangent interpolation and (with `chainOrientation: 'Vertical'`) the flip.
 */
export function squareLoopSpline(sideM = 1, perSide = 4): SplineBlock {
  const corners: Array<[number, number]> = [[0, 0], [0, sideM], [sideM, sideM], [sideM, 0]];
  const samples: number[] = [];
  for (let c = 0; c < 4; c++) {
    const [x0, z0] = corners[c];
    const [x1, z1] = corners[(c + 1) % 4];
    const tx = Math.sign(x1 - x0);
    const tz = Math.sign(z1 - z0);
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      samples.push(x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t, tx, 0, tz, 0, 1, 0);
    }
  }
  // Close the loop: repeat the very first sample.
  samples.push(...samples.slice(0, 9));
  return { closed: true, length: 4 * sideM, samples };
}

/** The minimum of `RVDrive` a chain reads. Registered as a `Drive` in the registry. */
export class FakeDrive {
  currentPosition = 0;
  reset(): void {
    this.currentPosition = 0;
  }
}

function box(name: string): Mesh {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const mesh = new Mesh(geo, new MeshStandardMaterial());
  mesh.name = name;
  return mesh;
}

export interface ChainHarness {
  scene: Scene;
  root: Object3D;
  /** The node that carries the `Chain` rv_extras. */
  chain: Object3D;
  /** The element template (a child of {@link chain}), carrying `ChainElement`. */
  template: Object3D;
  drive: FakeDrive;
  registry: NodeRegistry;
  signalStore: SignalStore;
  transportManager: RVTransportManager;
  chainManager: ChainManager;
  deps: RuntimeNodeDeps;
  /** The `Chain` rv_extras payload, pre-filled with the fixture's references. */
  chainExtras(overrides?: Record<string, unknown>): Record<string, unknown>;
}

export interface ChainHarnessSpec {
  spline?: SplineBlock;
  /** Extra `ChainElement` fields on the template node. */
  elementExtras?: Record<string, unknown>;
}

/** A registered scene with one chain node, one element template and one drive. */
export function chainHarness(spec: ChainHarnessSpec = {}): ChainHarness {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);

  const chain = new Object3D();
  chain.name = 'Chain';
  root.add(chain);

  const template = box('Carrier');
  template.userData.realvirtual = {
    ChainElement: { AlignWithChain: true, ...(spec.elementExtras ?? {}) },
  };
  chain.add(template);

  scene.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  registry.registerNode('Root/Chain', chain);
  registry.registerNode('Root/Chain/Carrier', template);

  const drive = new FakeDrive();
  const driveNode = new Object3D();
  driveNode.name = 'ChainDrive';
  root.add(driveNode);
  registry.registerNode('Root/ChainDrive', driveNode);
  registry.register('Drive', 'Root/ChainDrive', drive);

  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const chainManager = new ChainManager();

  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager, chainManager,
  };

  return {
    scene, root, chain, template, drive, registry, signalStore, transportManager,
    chainManager, deps,
    chainExtras(overrides: Record<string, unknown> = {}) {
      return {
        ConnectedDrive: driveRef('Root/ChainDrive'),
        ChainElement: transformRef('Root/Chain/Carrier'),
        NameChainElement: 'Carrier',
        NumberOfElements: 4,
        CalculatedDeltaPosition: true,
        Spline: spec.spline ?? straightSpline(),
        ...overrides,
      };
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
