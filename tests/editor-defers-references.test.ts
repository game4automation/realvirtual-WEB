// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 2 (§ 9.4) — the asset editor's load DEFERS its references.
 *
 * An authoring load (`preserveHierarchy` + `preserveAuthoringHierarchy`) keeps
 * the open document's OWN content unbaked and authorable, and every
 * non-embedded reference in it is a placement exactly like in the HMI: an
 * EMPTY reference node right after `loadModel`, materialised by
 * `viewer.placements` (baked, `_rvBakeChunk` chunks) once the join settles.
 * Pinned here on a REAL `RVViewer`:
 *  - empty after `loadModel`, populated after the join; chunk meshes;
 *  - the editor arenas never collect a chunk mesh;
 *  - a chunk hit resolves to the SURVIVING node (`BakeRegistry.resolveHit`),
 *    a click selects the outermost reference, a double-click drills to it;
 *  - an `embedded` reference keeps its inlined content (never deferred) next
 *    to a deferred one in the same document;
 *  - F11: stored children under a non-embedded reference are discarded and
 *    reported (`reference-content-discarded`), never shown twice;
 *  - the layout planner does not adopt the editor's placements (mode-scoped).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Raycaster, Vector3 } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { EditorArenaManager } from '../src/core/editor/rv-editor-arena';
import { resolveReferenceSelection } from '../src/core/engine/rv-reference-scope';
import { getDeferredPlacement } from '../src/core/engine/rv-asset-reference';
import { loadAuthoringModel, AUTHORING_LOAD_FLAGS } from '../src/core/editor/rv-authoring-load';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import {
  INNER_URL, CELL_REF_NODE_ID, SLIDE_NODE_ID, bootNestedViewer, findByName, makeOuter, referenceNode, sleep,
  type Booted,
} from './helpers/nested-placement-fixture';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';

let booted: Booted | null = null;
afterEach(() => {
  booted?.h.dispose();
  booted = null;
  resetProblemsForTests();
});

/** The OUTER Machine (own Frame mesh + reference `Cell_1` → INNER) as document bytes. */
async function machineBytes(extra?: (root: Group) => void): Promise<ArrayBuffer> {
  const root = makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: INNER_URL, planner: true }]);
  extra?.(root);
  return objectToGlb(root);
}

function chunkMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((n) => { if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) out.push(n as Mesh); });
  return out;
}

function byIdentity(root: Object3D, id: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && identityIdOf(n) === id) hit = n; });
  return hit;
}

describe('plan-774 F2 — the editor load defers its references', () => {
  it('reference node EMPTY after loadModel, populated (baked chunks) after the join; own content stays unbaked', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    await v.loadModel('machine.glb', { data: await machineBytes(), ...AUTHORING_LOAD_FLAGS });
    const root = v.currentModelRoot!;
    const cell = findByName(root, 'Cell_1')!;
    // Right after the load: an empty reference node, the placement in flight.
    expect(cell.children).toHaveLength(0);
    expect(v.placements.state).toBe('materializing');
    // The OWN content is the authored tree: the Frame mesh, no chunk.
    expect(findByName(root, 'Frame')).toBeInstanceOf(Mesh);
    expect(chunkMeshes(root)).toHaveLength(0);

    booted.open();
    await v.whenSceneReady();
    expect(cell.children.length).toBeGreaterThan(0);
    const chunks = chunkMeshes(cell);
    expect(chunks.length).toBeGreaterThan(0);
    // Every chunk lives inside the placement — none in the own content.
    for (const c of chunkMeshes(root)) {
      let inside = false;
      for (let n: Object3D | null = c; n; n = n.parent) if (n === cell) inside = true;
      expect(inside, `${c.name} is inside the placement`).toBe(true);
    }
    // The surviving component node of the placed asset is there; its CAD part is not.
    expect(byIdentity(cell, SLIDE_NODE_ID)).not.toBeNull();
    expect(findByName(cell, 'Body')).toBeNull();
    expect(v.bakeRegistry.instanceOf(cell)).not.toBeNull();
  });

  it('loadAuthoringModel: the join returns once the placements arrived (placementsReady)', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const joined = await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    expect(joined).toMatchObject({ ok: true, placementsReady: true, pending: 0 });
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(chunkMeshes(cell).length).toBeGreaterThan(0);
  });

  it('the editor arenas never collect a chunk mesh (only own content)', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    const root = v.currentModelRoot!;
    // plan-774 Phase 3 (root cause of an order-dependent red): two frames after
    // the load the viewer's async BVH build TRANSFERS the own meshes' buffers to
    // its worker (`_startAsyncBvhBuild`). An arena built inside that window
    // parks the Frame in its retry set (`stats().deferred`, re-tried every 15
    // frames) — neither `refOf` nor `isStandalone`. Alone the join returned
    // before the build started; next to other browser files the frames shifted
    // into the window. The production editor rides it out through the retry;
    // this test asserts the steady state, so it waits for the build first.
    await v.whenBvhIdle();
    const manager = new EditorArenaManager({ scene: v.scene, materialThreshold: 1 });
    try {
      manager.build(root);
      const frame = findByName(root, 'Frame') as Mesh;
      expect(manager.stats().deferred, 'no own mesh waits for its buffers').toBe(0);
      expect(manager.refOf(frame) !== undefined || manager.isStandalone(frame), 'own Frame is collected').toBe(true);
      const chunks = chunkMeshes(root);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(manager.refOf(c), `${c.name} not in an arena`).toBeUndefined();
        expect(manager.isStandalone(c), `${c.name} not standalone`).toBe(false);
      }
    } finally {
      manager.dispose();
    }
  });

  it('a chunk hit resolves to the surviving node; click → outermost reference, double-click → drill', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    const root = v.currentModelRoot!;
    const cell = findByName(root, 'Cell_1')!;
    const slide = byIdentity(cell, SLIDE_NODE_ID)!;
    expect(slide).not.toBeNull();
    root.updateMatrixWorld(true);

    // A real ray straight down onto the Slide's Tool (the Tool merged into its chunk).
    const tool = new Vector3();
    slide.getWorldPosition(tool);
    const raycaster = new Raycaster(new Vector3(tool.x, tool.y + 5, tool.z), new Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(cell, true)
      .filter((h) => h.object.userData?.[RV_BAKE_CHUNK_KEY] === true);
    expect(hits.length, 'the ray hits placement chunk geometry').toBeGreaterThan(0);
    const first = hits[0] as typeof hits[0] & { rvOwner?: number };
    const resolved = v.bakeRegistry.resolveHit(first.object, first.rvOwner ?? -1);
    expect(resolved).toBe(slide);

    // The HMI selection rule applies to that node inside the editor document.
    const click = resolveReferenceSelection(slide, 'viewport', 0, root);
    expect(click.node).toBe(cell);
    const drill = resolveReferenceSelection(slide, 'viewport', 1, root);
    expect(drill.node).toBe(slide);
  });

  it('embedded + deferred in ONE document: the embedded reference keeps its inlined content, the other is a placement', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes((root) => {
      const embedded = new Object3D();
      embedded.name = 'Inlined_1';
      setNodeId(embedded, 'nid-inlined');
      setAssetReference(embedded, { assetId: 'cat:inlined', path: INNER_URL, embedded: true });
      const part = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial({ color: 0x224488 }));
      part.name = 'InlinedPart';
      embedded.add(part);
      root.add(embedded);
    });
    await loadAuthoringModel(v, 'mix.glb', { identity: {}, keepBaked: false, data: bytes });
    const root = v.currentModelRoot!;
    const inlined = findByName(root, 'Inlined_1')!;
    expect(findByName(inlined, 'InlinedPart')).toBeInstanceOf(Mesh);
    expect(chunkMeshes(inlined)).toHaveLength(0);
    expect(getDeferredPlacement(inlined)).toBeNull();
    expect(v.bakeRegistry.instanceOf(inlined)).toBeNull();
    const cell = findByName(root, 'Cell_1')!;
    expect(v.bakeRegistry.instanceOf(cell)).not.toBeNull();
    expect(getProblems().filter((p) => p.code === 'reference-content-discarded')).toEqual([]);
  });
});

describe('plan-774 F11 — stored children under a reference node are discarded, never shown twice', () => {
  for (const mode of ['editor', 'runtime'] as const) {
    it(`${mode} load: the stale copy is detached before materialisation and reported`, async () => {
      booted = await bootNestedViewer();
      const v = booted.h.viewer;
      const bytes = await machineBytes((root) => {
        const cell = findByName(root, 'Cell_1')!;
        const stale = new Group();
        stale.name = 'StaleCopy';
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xff0000 }));
        mesh.name = 'StaleBody';
        stale.add(mesh);
        cell.add(stale);
      });
      if (mode === 'editor') {
        await loadAuthoringModel(v, 'legacy.glb', { identity: {}, keepBaked: false, data: bytes });
      } else {
        await v.loadModel('legacy.glb', { data: bytes });
        await v.whenSceneReady();
      }
      const root = v.currentModelRoot!;
      expect(findByName(root, 'StaleCopy')).toBeNull();
      expect(findByName(root, 'StaleBody')).toBeNull();
      const cell = findByName(root, 'Cell_1')!;
      expect(v.bakeRegistry.instanceOf(cell)).not.toBeNull();
      expect(byIdentity(cell, SLIDE_NODE_ID)).not.toBeNull();
      const problems = getProblems().filter((p) => p.code === 'reference-content-discarded');
      expect(problems).toHaveLength(1);
      expect(problems[0].nodePath).toContain('Cell_1');
      expect(problems[0].title).toContain('Cell_1');
    });
  }

  it('the entry is per document: the next load clears it', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes((root) => { findByName(root, 'Cell_1')!.add(new Group()); });
    await loadAuthoringModel(v, 'legacy.glb', { identity: {}, keepBaked: false, data: bytes });
    expect(getProblems().some((p) => p.code === 'reference-content-discarded')).toBe(true);
    await loadAuthoringModel(v, 'clean.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    expect(getProblems().some((p) => p.code === 'reference-content-discarded')).toBe(false);
  });
});

describe('plan-774 — the layout planner does not adopt the editor\'s placements', () => {
  it('the planner is mode-scoped out of editor mode', () => {
    const planner = new LayoutPlannerPlugin();
    expect(planner.modes).toBeDefined();
    expect(planner.modes).not.toContain('editor');
  });

  it('an editor load with a planner-scoped plugin registered: no onModelLoaded for it, the viewer\'s instancer owns the placement', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    v.modes.register({ id: 'editor', label: 'Editor', runtime: 'detached' })
      .register({ id: 'planner', label: 'Planner' })
      .register({ id: 'des', label: 'DES' });
    v.modes.setMode('editor');
    const onModelLoaded = vi.fn();
    const probe = { id: 'planner-probe', modes: [...(new LayoutPlannerPlugin().modes ?? [])], onModelLoaded } as unknown as RVViewerPlugin;
    v.use(probe);
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: false, data: await machineBytes() });
    await sleep(0);
    expect(onModelLoaded).not.toHaveBeenCalled();
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(v.bakeRegistry.instanceOf(cell)).not.toBeNull();
    expect(v.placements.instanceOf(cell)).not.toBeNull();
    expect(getDeferredPlacement(cell)).toBeNull();
  });
});

void referenceNode;
