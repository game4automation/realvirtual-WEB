// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.18 — the post-load geometry readers after the prune.
 *
 * `TransportSurface._accumulateLocalAABB` and the collision manager's body
 * collector both used to SKIP the loader bake's chunk meshes (`_rvBakeInPlace`),
 * because the masked source meshes were still there and were the geometry.
 * After a destructive bake the chunk IS the geometry, so the skip had to go:
 * Phase 1c deleted both carve-outs (and `TransportSurface._isBakedHelper` with
 * them). These cases pin that a chunk mesh now COUNTS as geometry in both
 * readers, for the main model exactly as for a planner placement.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';


const material = new MeshStandardMaterial({ color: 0x334422 });

function box(name: string, pos: [number, number, number], size: [number, number, number]): Mesh {
  const m = new Mesh(new BoxGeometry(...size), material.clone());
  m.name = name;
  m.position.set(...pos);
  return m;
}

/**
 *   Line
 *   └─ Belt {TransportSurface}     boundary → owns a chunk
 *       └─ BeltMesh                merged into that chunk
 */
function buildLine(): Group {
  const line = new Group();
  line.name = 'Line';
  const belt = new Group();
  belt.name = 'Belt';
  belt.userData.realvirtual = { TransportSurface: { Speed: 100 } };
  belt.add(box('BeltMesh', [0, 0, 0], [4, 0.2, 1]));
  line.add(belt);
  return line;
}

let bytes: ArrayBuffer;
beforeAll(async () => { bytes = await objectToGlb(buildLine()); });

async function load(): Promise<LoadResult> {
  const result = await loadGLB('line.glb', new Scene(), {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
  });
  return result;
}

function chunkMeshesUnder(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  node.traverse((n) => { if (n.userData[RV_BAKE_CHUNK_KEY]) out.push(n as Mesh); });
  return out;
}

describe('collision + transport readers after the prune (plan-754 §9.18)', () => {
  it('the surface keeps its own chunk mesh as its only drawable', async () => {
    const result = await load();
    const belt = result.registry.getNode('Line/Belt')!;
    expect(belt).toBeTruthy();
    const chunks = chunkMeshesUnder(belt);
    expect(chunks.length).toBeGreaterThan(0);
    // The source mesh is gone; nothing below the belt is a plain CAD mesh.
    let plainMeshes = 0;
    belt.traverse((n) => { if ((n as Mesh).isMesh && !n.userData[RV_BAKE_CHUNK_KEY]) plainMeshes++; });
    expect(plainMeshes).toBe(0);
  });

  it('a destructive chunk is NOT flagged as an in-place helper — the skip inverts', async () => {
    const result = await load();
    for (const m of chunkMeshesUnder(result.root)) {
      // The collision manager's helper test and the transport gizmo AABB both
      // key on exactly this flag.
      const ud = m.userData as Record<string, unknown>;
      expect(ud._highlightOverlay === true).toBe(false);
      expect(ud._rvMachiningChunk).toBeUndefined();
    }
  });

  it('the TransportSurface gizmo AABB is derived from the chunk mesh', async () => {
    const result = await load();
    const beltPath = result.registry.getPathForNode(result.registry.getNode('Line/Belt')!)!;
    const entries = result.registry.getComponentsAt(beltPath);
    const surface = entries.find(([type]) => type === 'TransportSurface')?.[1] as RVTransportSurface;
    expect(surface).toBeTruthy();
    const aabb = (surface as unknown as { _computeGizmoAABB(): { isEmpty(): boolean; getSize(v: unknown): unknown } | null })
      ._computeGizmoAABB();
    expect(aabb, 'gizmo AABB must not be null after the prune').toBeTruthy();
    expect(aabb!.isEmpty()).toBe(false);
  });
});
