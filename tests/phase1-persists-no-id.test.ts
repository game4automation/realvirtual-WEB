// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 F17 (Phase 1a part of 9.14) — Phase 1 persists no id; since Phase 3a the
 * asset editor export writes ids, since Phase 3b the scene save too. The seeded
 * NodeIds live under the runtime key `_rvNodeId` only; the two GLB writers of the
 * viewer must not carry them into a file:
 *  - the scene save's structural path (D4: re-parse → objectToGlb, no sanitizer)
 *    strips them explicitly before the export;
 *  - the asset editor's export (`sanitizeUserDataForExport`) drops every `_` key.
 * A Unity node therefore comes back without `NodeId` — the next load seeds the same
 * id again (deterministic), nothing ID-formatted is in the file.
 */
import { describe, expect, it } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { objectToGlb } from '../src/core/import/rv-import-object';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

function op(body: Record<string, unknown>): RvOp {
  return { id: `op_${Math.random().toString(36).slice(2)}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}

async function plantBytes(): Promise<ArrayBuffer> {
  const plant = new Group();
  plant.name = 'Plant';
  const floor = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshStandardMaterial());
  floor.name = 'Floor';
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearX' } };
  plant.add(floor, axis);
  return objectToGlb(plant);
}

function idsIn(json: Record<string, unknown>): { runtime: number; nodeId: number } {
  const text = JSON.stringify(json);
  return { runtime: (text.match(/_rvNodeId/g) ?? []).length, nodeId: (text.match(/"NodeId"/g) ?? []).length };
}

describe('plan-769 F17 — Phase 1 persists no id', () => {
  it('Phase 3b: the scene save (structural path, D4) writes every NodeId, never the runtime seed', async () => {
    const source = await plantBytes();
    const loaded = await loadGLB('plant.glb', new Scene(), { data: source.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false });
    let plant: Object3D | null = null;
    loaded.root.traverse((n) => { if (!plant && n.name === 'Plant') plant = n; });
    expect(identityIdOf(plant!)).not.toBeNull(); // seeded in memory
    const parentPath = loaded.registry.getPathForNode(plant!)!;
    const edits = materialise([op({
      kind: 'addNode',
      nodePath: `${parentPath}/Waypoint`,
      spec: { parentPath, name: 'Waypoint', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {} },
    })]);
    const baked = await bakeIntoGlb(source, edits, makeRegistryBakeResolver(loaded.registry, []), { expectedNames: loaded.registry.getGltfNodeNames() });
    expect(baked.path).toBe('full');
    const json = readGlbJson(baked.glb)! as { nodes: unknown[] };
    // One per node plus the scene root.
    expect(idsIn(json as unknown as Record<string, unknown>)).toEqual({ runtime: 0, nodeId: json.nodes.length + 1 });
  });

  it('Phase 3a: the asset editor export PROMOTES the seeds — every node a NodeId, no runtime key', async () => {
    const loaded = await loadGLB('plant.glb', new Scene(), { data: await plantBytes(), preserveHierarchy: true, loadKinematicsSidecar: false });
    let withSeed = 0;
    loaded.root.traverse((n) => { if (identityIdOf(n)) withSeed++; });
    expect(withSeed).toBeGreaterThan(2);
    const glb = await exportAssetGlb(loaded.root, 'Plant', undefined, undefined, { registry: loaded.registry });
    const json = readGlbJson(glb)! as { nodes: unknown[] };
    // One per node plus the scene root.
    expect(idsIn(json as unknown as Record<string, unknown>)).toEqual({ runtime: 0, nodeId: json.nodes.length + 1 });
  });
});
