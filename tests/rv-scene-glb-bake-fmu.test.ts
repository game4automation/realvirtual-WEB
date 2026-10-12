// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 (Phase 1 remainder, done in Phase 4) — the scene bake's structural
 * path re-exports the file through GLTFExporter, which drops every bufferView
 * no node references. A scene document with its OWN `Fmu` node must keep its
 * package: the bake takes the bytes from the source file and appends them with
 * the same writer the asset editor uses (`embedFmuBufferViews`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { buildFmuExtras } from '../src/core/ops/rv-fmu-ops';
import { binaryResources, collectFmuEmbeds, extractGlbBufferViews, readGlbJson } from '../src/core/engine/rv-binary-resources';
import { sha256HexOf } from './helpers/glb-fixture';

let ftBytes: Uint8Array;
let ftSha: string;

async function sceneWithFmu(): Promise<ArrayBuffer> {
  const { readModelDescription } = await import('../src/core/engine/rv-fmu-model-description');
  const plant = new Group();
  plant.name = 'Plant';
  const floor = new Mesh(new BoxGeometry(1, 0.1, 1), new MeshStandardMaterial());
  floor.name = 'Floor';
  plant.add(floor);
  const hyd = new Object3D();
  hyd.name = 'Hyd';
  hyd.userData.realvirtual = {
    Fmu: buildFmuExtras({ fileName: 'Feedthrough.fmu', sha256: ftSha, bytes: ftBytes, description: await readModelDescription(ftBytes) }),
  };
  plant.add(hyd);
  binaryResources.put(ftSha, ftBytes, 'scene-bake-fmu-build');
  const glb = await exportAssetGlb(plant, 'Plant');
  // The bake must not lean on the store: the source file alone carries the bytes.
  binaryResources._resetForTesting();
  return glb;
}

function op(body: Record<string, unknown>): RvOp {
  return { id: `op_${Math.random().toString(36).slice(2)}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}

beforeEach(async () => {
  binaryResources._resetForTesting();
  ftBytes = new Uint8Array(await (await fetch(feedthroughUrl)).arrayBuffer());
  ftSha = await sha256HexOf(ftBytes);
});

describe('scene bake — FMU packages of the document\'s own Fmu nodes', () => {
  it('structural save (added node) keeps the package as a bufferView; reload finds the bytes', async () => {
    const source = await sceneWithFmu();
    const loaded = await loadGLB('plant.glb', new Scene(), {
      data: source.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false,
    });
    const plantNode = (() => { let f: Object3D | null = null; loaded.root.traverse((n) => { if (!f && n.name === 'Plant') f = n; }); return f; })();
    const parentPath = plantNode ? loaded.registry.getPathForNode(plantNode)! : loaded.registry.getPathForNode(loaded.root)!;
    binaryResources._resetForTesting();

    const edits = materialise([op({
      kind: 'addNode',
      nodePath: `${parentPath}/Waypoint`,
      spec: { parentPath, name: 'Waypoint', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {} },
    })]);
    const resolver = makeRegistryBakeResolver(loaded.registry, loaded.composition?.frames ?? []);
    const baked = await bakeIntoGlb(source, edits, resolver, { expectedNames: loaded.registry.getGltfNodeNames() });
    expect(baked.path).toBe('full');
    expect(baked.warnings.filter((w) => w.includes('FMU'))).toEqual([]);

    const json = readGlbJson(baked.glb)!;
    const [wanted] = collectFmuEmbeds(json);
    expect(wanted.sha256).toBe(ftSha);
    expect(wanted.bufferView).toBeGreaterThanOrEqual(0);
    expect((json.asset as any).extras.realvirtual.fmuBufferViews).toEqual([wanted.bufferView]);
    const [res] = extractGlbBufferViews(baked.glb, [wanted]);
    expect(await sha256HexOf(res.bytes)).toBe(ftSha);
    expect((json.nodes as Array<{ name?: string }>).some((n) => n.name === 'Waypoint')).toBe(true);

    // Reload through the real loader: the store is fed from the baked file.
    const glbBuf = baked.glb instanceof Uint8Array
      ? baked.glb.slice().buffer as ArrayBuffer
      : (baked.glb as ArrayBuffer).slice(0);
    await loadGLB('plant-2.glb', new Scene(), { data: glbBuf, preserveHierarchy: true, loadKinematicsSidecar: false });
    expect(binaryResources.get(ftSha)?.byteLength).toBe(ftBytes.byteLength);
  });
});
