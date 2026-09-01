// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared synthetic fixture for the plan-362 EnergyChain integration tests.
 *
 * There is no energy chain in any GLB in this repo (`../realvirtual-WebViewer-Private~/projects/Development/fixtures/tests.glb`
 * has no such node, and the Festo files are an AAS document and a catalogue
 * part), so every V1 test builds its scene programmatically — the same approach
 * `tests/rv-lamp-lifecycle.test.ts` and `tests/rv-asset-glb-export.test.ts` use.
 *
 * The chain is deliberately built the way the REFERENCE case looks: the two
 * straight strands in ONE mesh, the half-circle bend in a SECOND mesh, each
 * with its own local transform. A single SkinnedMesh cannot represent that,
 * which is exactly the property the rigging has to get right.
 *
 * NOT a `.test.ts` file, so vitest does not collect it.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { EnergyChainManager } from '../src/core/engine/rv-energy-chain-manager';
import type { RuntimeNodeDeps } from '../src/core/engine/rv-scene-loader';

export interface ChainGeometrySpec {
  /** mm */ rMm?: number;
  /** mm */ linkMm?: number;
  /** mm */ lengthMm?: number;
  /** mm */ widthMm?: number;
}

const DEFAULTS: Required<ChainGeometrySpec> = {
  rMm: 55, linkMm: 35, lengthMm: 815, widthMm: 42,
};

function geometryFrom(points: number[]): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
  return geo;
}

/**
 * Two meshes forming one chain in its CAD rest pose, laid out along +Z with
 * the bend at the larger Z and the transverse axis Y.
 *
 * `strandOffset` / `bendOffset` are the LOCAL transforms of the two meshes:
 * the vertex data is authored relative to them, so a rigging implementation
 * that forgets to compose `mesh.matrixWorld` into the bind frame produces
 * visibly wrong numbers instead of accidentally correct ones.
 */
export function makeChainMeshes(spec: ChainGeometrySpec = {}): {
  strands: Mesh; bend: Mesh; rMm: number; linkMm: number; lengthMm: number;
} {
  const { rMm, linkMm, lengthMm, widthMm } = { ...DEFAULTS, ...spec };
  const R = rMm / 1000, h = linkMm / 1000, L = lengthMm / 1000, width = widthMm / 1000;
  const strandLen = (L - Math.PI * R) / 2;
  const c = strandLen;

  const strandOffset: [number, number, number] = [0, 0.5, -0.25];
  const bendOffset: [number, number, number] = [0.01, -0.3, 1.75];

  const strandPts: number[] = [];
  for (const vBase of [-R, R]) {
    for (let zi = 0; zi <= 40; zi++) {
      const z = (strandLen * zi) / 40;
      for (let yi = 0; yi <= 5; yi++) {
        const y = vBase - h / 2 + (h * yi) / 5;
        for (let xi = 0; xi <= 3; xi++) {
          const x = -width / 2 + (width * xi) / 3;
          strandPts.push(x - strandOffset[0], y - strandOffset[1], z - strandOffset[2]);
        }
      }
    }
  }

  const bendPts: number[] = [];
  for (let ti = 0; ti <= 30; ti++) {
    const theta = (Math.PI * ti) / 30;
    for (let ri = 0; ri <= 5; ri++) {
      const r = R - h / 2 + (h * ri) / 5;
      const z = c + r * Math.sin(theta);
      const y = -r * Math.cos(theta);
      for (let xi = 0; xi <= 3; xi++) {
        const x = -width / 2 + (width * xi) / 3;
        bendPts.push(x - bendOffset[0], y - bendOffset[1], z - bendOffset[2]);
      }
    }
  }

  const strands = new Mesh(geometryFrom(strandPts), new MeshStandardMaterial({ color: 0x445566 }));
  strands.name = '28';
  strands.position.set(...strandOffset);

  const bend = new Mesh(geometryFrom(bendPts), new MeshStandardMaterial({ color: 0x445566 }));
  bend.name = '31';
  bend.position.set(...bendOffset);

  return { strands, bend, rMm, linkMm, lengthMm };
}

export interface ChainHarness {
  scene: Scene;
  root: Object3D;
  /** The node carrying the EnergyChain component. */
  chain: Object3D;
  /** Node standing in for the carrier the moving chain end is bolted to. */
  follower: Object3D;
  registry: NodeRegistry;
  signalStore: SignalStore;
  transportManager: RVTransportManager;
  energyChainManager: EnergyChainManager;
  deps: RuntimeNodeDeps;
  /** Move the follower along the travel axis by `mm` and refresh world matrices. */
  moveFollower(mm: number): void;
}

/** A registered scene with one two-mesh chain plus a follower node. */
export function chainHarness(spec: ChainGeometrySpec = {}): ChainHarness {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);

  const chain = new Object3D();
  chain.name = 'EnergyChain';
  const { strands, bend } = makeChainMeshes(spec);
  chain.add(strands, bend);
  root.add(chain);

  const follower = new Object3D();
  follower.name = 'Slide';
  // Sits at the open end of the HIGH strand: +R above the bend center plane.
  follower.position.set(0, (spec.rMm ?? DEFAULTS.rMm) / 1000, 0);
  root.add(follower);

  scene.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  registry.registerNode('Root/EnergyChain', chain);
  registry.registerNode('Root/Slide', follower);

  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const energyChainManager = new EnergyChainManager();

  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager, energyChainManager,
  };

  return {
    scene, root, chain, follower, registry, signalStore, transportManager,
    energyChainManager, deps,
    moveFollower(mm: number) {
      follower.position.z += mm / 1000;
      scene.updateMatrixWorld(true);
    },
  };
}

/** A wire-format `ComponentReference` exactly as the Unity exporter writes it. */
export function transformRef(path: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType: 'UnityEngine.Transform' };
}
