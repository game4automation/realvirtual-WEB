// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.6 — visibility after a destructive bake is plain `.visible`.
 *
 * No index rewriting, no degenerate windows, no reconciler: a chunk or keep
 * mesh is hidden the three.js way and the renderer stops walking its subtree.
 *
 * Isolate follows the same rule: a chunk IS the geometry of everything it
 * absorbed, so it joins the focus pass like any other mesh. (Phase 1c deleted
 * the `_rvBakeInPlace` carve-out in `tagIsolateSubtree`, which existed because
 * an in-place chunk would have double-drawn its masked sources.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ISOLATE_FOCUS_LAYER, tagIsolateSubtree, untagIsolateSubtree } from '../src/core/engine/rv-group-registry';


const material = new MeshStandardMaterial({ color: 0x334455 });

function box(name: string, pos: [number, number, number], extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material.clone());
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

function buildCell(): Group {
  const cell = new Group();
  cell.name = 'Cell';
  // `WebVisibility` is a boundary (bake: 'chunk'), so it owns a chunk that
  // `.visible` can hide as a unit — that is the mechanism D8 relies on. (A
  // `Group` is NOT one any more: it is `merge` / `pick: 'none'` since 2026-09-21.)
  const panel = new Group();
  panel.name = 'Panel';
  panel.userData.realvirtual = { WebVisibility: {} };
  panel.add(box('Cover', [0, 0, 0]));
  cell.add(panel);
  const axis = new Group();
  axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearY' } };
  axis.add(box('Arm', [4, 0, 0]));
  cell.add(axis);
  cell.add(box('Beacon', [8, 0, 0], { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } }));
  return cell;
}

let bytes: ArrayBuffer;
beforeAll(async () => { bytes = await objectToGlb(buildCell()); });

async function load(): Promise<LoadResult> {
  const result = await loadGLB('cell.glb', new Scene(), {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
  });
  return result;
}

/** Meshes the renderer would actually walk into, the three.js way. */
function drawnMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  const walk = (n: Object3D, visible: boolean): void => {
    const effective = visible && n.visible;
    if (effective && (n as Mesh).isMesh) out.push(n as Mesh);
    for (const c of n.children) walk(c, effective);
  };
  walk(root, true);
  return out;
}

describe('destructive bake: visibility is plain .visible (plan-754 §9.6)', () => {
  it('no chunk mesh carries the in-place marker, and no reconciler is needed', async () => {
    const result = await load();
    let chunks = 0;
    result.root.traverse((n) => {
      if (!n.userData[RV_BAKE_CHUNK_KEY]) return;
      chunks++;
    });
    expect(chunks).toBeGreaterThan(0);
    // Nothing is masked: there is no per-source window table at all any more
    // (plan-756 step 1d) — every chunk carries exactly one pick structure.
    for (const c of result.bakedAsset!.chunks) expect(c.pick.segmentCount).toBeGreaterThan(0);
  });

  it('hiding a boundary hides its chunk — nothing else, no index rewrite', async () => {
    const result = await load();
    const panel = result.registry.getNode('Cell/Panel')!;
    const before = drawnMeshes(result.root);
    const panelChunks = before.filter((m) => m.parent === panel);
    expect(panelChunks.length).toBeGreaterThan(0);
    const indexBefore = panelChunks.map((m) => (m.geometry.index!.array as Uint32Array).slice());

    panel.visible = false;
    const after = drawnMeshes(result.root);
    expect(after.length).toBe(before.length - panelChunks.length);
    for (const m of panelChunks) expect(after).not.toContain(m);
    // The shared index buffer is untouched — that is the whole point.
    panelChunks.forEach((m, i) => {
      expect(Array.from(m.geometry.index!.array as Uint32Array)).toEqual(Array.from(indexBefore[i]));
    });

    panel.visible = true;
    expect(drawnMeshes(result.root).length).toBe(before.length);
  });

  it('hiding a keep mesh works the same way', async () => {
    const result = await load();
    const beacon = result.registry.getNode('Cell/Beacon') as Mesh;
    expect(beacon.isMesh).toBe(true);
    const before = drawnMeshes(result.root).length;
    beacon.visible = false;
    expect(drawnMeshes(result.root).length).toBe(before - 1);
  });

  it('isolate tags the chunk and keep meshes', async () => {
    const result = await load();
    const axis = result.registry.getNode('Cell/Axis')!;
    tagIsolateSubtree(axis);
    const tagged: Object3D[] = [];
    axis.traverse((n) => { if (n.layers.isEnabled(ISOLATE_FOCUS_LAYER)) tagged.push(n); });
    expect(tagged.some((n) => n.userData[RV_BAKE_CHUNK_KEY])).toBe(true);
    untagIsolateSubtree(axis);
    axis.traverse((n) => expect(n.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(false));
  });
});
