// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 4 (§ 9.8, F9 + user decision "mechanism authoring on owned
 * content only") — whole-tree editor tools act on OWNED content.
 *
 * A placed reference is baked like in the HMI; the editor authors the open
 * document, not the assets it places. So:
 *  - selection stats / heaviest parts (the heatmap's input), material stats,
 *    the material-preset "Select" index, select-similar (MCP universe + the
 *    editor's selectable map), the merge / separate candidates, the vertex
 *    circle probe and the pivot circle pick ignore placed content;
 *  - the editor arenas never collect placed content — neither chunks nor the
 *    placements' KEEP meshes — and those keep meshes still render (own layer)
 *    and pick through the HMI path (`BakeRegistry.resolveHit`);
 *  - mechanism snap (query + MCP `web_query("mechanism.snapList")`), anchor
 *    (`mechanism.setAnchorSnap` with a pick) and the face pick REFUSE on placed
 *    content with the guard's wording.
 *
 * The tool tests use a plain tree (`Machine` → own parts + reference `Cell_1`
 * with stand-in placed content + an EMBEDDED reference whose content is owned);
 * the arena test is a real authoring load (editor-document harness) with a Lamp
 * (`bake:'keep'`) inside the placed asset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Raycaster, Scene, Vector3,
} from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import {
  forEachOwnedNode, isOwnedContent, isPlacedReferenceNode, placedContentRefusal,
} from '../src/core/engine/rv-reference-scope';
import { indexMeshPathsByMaterialValue } from '../src/core/editor/rv-asset-material';
import { buildMeshUniverse } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { queryValue } from './helpers/query-value';
import { executeValue } from './helpers/execute-value';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { setMechanismUiBridge, type MechanismUiBridge } from '../src/core/engine/rv-kinematic-registry';
import { EditorArenaManager } from '../src/core/editor/rv-editor-arena';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { computeHeaviestParts, computeSelectionStats } from '@rv-private/plugins/asset-editor/selection-stats';
import { computeMaterialStats } from '@rv-private/plugins/asset-editor/shared/material-stats';
import { buildMergeMenuItem } from '@rv-private/plugins/asset-editor/mesh-merge-actions';
import { querySnapCandidates } from '@rv-private/plugins/asset-editor/mechanism/mechanism-snap-query';
import { queryVertexCircle, resetVertexCircleMemo } from '@rv-private/plugins/asset-editor/mechanism/mechanism-circle-vertex-query';
import {
  cancelMechanismPick, getMechanismPickSnapshot, startMechanismPick,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-pick';
import { buildEditorMarqueeMap, buildEditorSelectableMap } from '@rv-private/plugins/asset-editor/index';
import { computeBoxSelectPaths } from '../src/plugins/layout-planner/box-select-hit';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { dataUrlOf, referenceNode } from './helpers/nested-placement-fixture';
import { openEditorDocumentBytes, type EditorDocumentHarness } from './helpers/editor-document-harness';
import { group, withComponent } from './fixtures/bake-fixture';

// ─── Plain-tree world ───────────────────────────────────────────────────────

const SHARED = new MeshStandardMaterial({ color: 0x808080, metalness: 0, roughness: 0.5 });

function box(name: string, size = 1): Mesh {
  const m = new Mesh(new BoxGeometry(size, size, size), SHARED);
  m.name = name;
  return m;
}

interface World {
  scene: Scene;
  root: Group;
  registry: NodeRegistry;
  own: Mesh[];
  placed: Mesh[];
  cell: Object3D;
  slide: Object3D;
  joint: Object3D;
}

/**
 * `Machine`: Frame + Part (own), Joint (own, KinematicJoint), `Cell_1` (placed
 * reference: PlacedBody + Slide/Tool — stand-ins for its baked content) and
 * `Inlined` (EMBEDDED reference: its Fixture mesh IS this file's content).
 */
function makeWorld(): World {
  const scene = new Scene();
  const root = group('Machine');
  scene.add(root);
  const frame = box('Frame');
  const part = box('Part', 0.5);
  part.position.set(-2, 0, 0);
  root.add(frame, part);
  const joint = withComponent(group('Joint'), 'KinematicJoint', { JointType: 'Revolute' });
  root.add(joint);

  const cell = new Object3D();
  cell.name = 'Cell_1';
  setNodeId(cell, 'nid-cell');
  setAssetReference(cell, { assetId: 'cat:cell', path: 'cell.glb' });
  cell.position.set(3, 0, 0);
  const placedBody = box('PlacedBody');
  const slide = withComponent(group('Slide'), 'Drive', { Direction: 'LinearX' });
  const tool = box('Tool', 0.2);
  slide.add(tool);
  cell.add(placedBody, slide);
  root.add(cell);

  const inlined = new Object3D();
  inlined.name = 'Inlined';
  setAssetReference(inlined, { assetId: 'cat:fixture', path: 'fixture.glb', embedded: true });
  const fixture = box('Fixture', 0.3);
  fixture.position.set(0, 2, 0);
  inlined.add(fixture);
  root.add(inlined);

  scene.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return { scene, root, registry, own: [frame, part, fixture], placed: [placedBody, tool], cell, slide, joint };
}

function viewerOf(w: World, extra: Record<string, unknown> = {}): RVViewer {
  return {
    scene: w.scene,
    registry: w.registry,
    get currentModelRoot() { return w.root; },
    modes: { activeMode: 'editor' },
    markRenderDirty() {},
    ...extra,
  } as unknown as RVViewer;
}

describe('plan-774 F9 — the owned-content predicate', () => {
  it('placed reference and everything below it are not owned; an embedded reference is', () => {
    const w = makeWorld();
    expect(isPlacedReferenceNode(w.cell)).toBe(true);
    expect(isOwnedContent(w.cell, w.root)).toBe(false);
    for (const m of w.placed) expect(isOwnedContent(m, w.root), m.name).toBe(false);
    for (const m of w.own) expect(isOwnedContent(m, w.root), m.name).toBe(true);
    const seen: string[] = [];
    forEachOwnedNode(w.root, (n) => { seen.push(n.name); });
    expect(seen).toEqual(expect.arrayContaining(['Machine', 'Frame', 'Part', 'Joint', 'Inlined', 'Fixture']));
    expect(seen).not.toContain('Cell_1');
    expect(seen).not.toContain('PlacedBody');
    expect(seen).not.toContain('Tool');
  });
});

describe('plan-774 F9 — whole-tree tools ignore placed content', () => {
  it('selection stats + heaviest parts (the heatmap input): own meshes only; a placed root counts nothing', () => {
    const w = makeWorld();
    const stats = computeSelectionStats([w.root]);
    expect(stats.total.meshes).toBe(w.own.length);
    const parts = computeHeaviestParts([w.root]);
    expect(parts.all.map((p) => p.node.name).sort()).toEqual(w.own.map((m) => m.name).sort());
    expect(computeSelectionStats([w.cell]).total.objects).toBe(0);
    expect(computeSelectionStats([w.slide]).total.objects).toBe(0);
    expect(computeHeaviestParts([w.cell]).all).toEqual([]);
  });

  it('material stats count own meshes only', () => {
    const w = makeWorld();
    expect(computeMaterialStats(w.root).meshCount).toBe(w.own.length);
  });

  it('material-preset "Select" index lists own meshes only', () => {
    const w = makeWorld();
    const paths = [...indexMeshPathsByMaterialValue(w.root).values()].flat();
    expect(paths.sort()).toEqual(w.own.map((m) => NodeRegistry.computeNodePath(m)).sort());
  });

  it('select-similar universe (MCP) and the editor selectable map (Select menu, owned half of the marquee): own meshes only', () => {
    const w = makeWorld();
    const v = viewerOf(w);
    const expected = w.own.map((m) => w.registry.getPathForNode(m)!).sort();
    expect([...buildMeshUniverse(v).keys()].sort()).toEqual(expected);
    expect([...buildEditorSelectableMap(v).keys()].sort()).toEqual(expected);
  });

  it('review fix R2: the MARQUEE map adds one entry per top-level placed reference (not its content, not a nested reference); box select hits it', () => {
    const w = makeWorld();
    // A reference nested in the placement is the placement's content: no entry.
    const nested = new Object3D();
    nested.name = 'Nested_1';
    setAssetReference(nested, { assetId: 'cat:nested', path: 'nested.glb' });
    nested.add(box('NestedBody', 0.2));
    w.cell.add(nested);
    w.scene.updateMatrixWorld(true);
    nested.traverse((n) => w.registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const v = viewerOf(w);
    const cellPath = w.registry.getPathForNode(w.cell)!;
    const own = w.own.map((m) => w.registry.getPathForNode(m)!);
    const marquee = buildEditorMarqueeMap(v);
    expect([...marquee.keys()].sort()).toEqual([...own, cellPath].sort());
    expect(marquee.get(cellPath)).toBe(w.cell);
    // "Select ▸ similar" keeps the owned-mesh universe.
    expect([...buildEditorSelectableMap(v).keys()].sort()).toEqual([...own].sort());

    // A rectangle over the placement (right of the own parts) selects the reference node.
    const camera = new PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) } as unknown as HTMLCanvasElement;
    const rect = { l: 700, t: 300, w: 300, h: 400 };
    expect(computeBoxSelectPaths(camera, canvas, rect, marquee, w.registry, null)).toEqual([cellPath]);
    expect(computeBoxSelectPaths(camera, canvas, rect, buildEditorSelectableMap(v), w.registry, null)).toEqual([]);
    // Hidden placement → not boxable.
    w.cell.visible = false;
    expect(buildEditorMarqueeMap(v).has(cellPath)).toBe(false);
  });

  it('merge candidates: an own subtree is offered, a placed reference / placed node is not', () => {
    const w = makeWorld();
    const item = buildMergeMenuItem(viewerOf(w));
    const target = (node: Object3D) => ({ node, path: w.registry.getPathForNode(node)! }) as never;
    expect(item.condition!(target(w.root))).toBe(true);
    expect(item.condition!(target(w.cell))).toBe(false);
    expect(item.condition!(target(w.slide))).toBe(false);
  });

  it('vertex circle probe: answers on an own mesh, nothing on a placed one at the same spot', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400; canvas.height = 400;
    Object.assign(canvas.style, { width: '400px', height: '400px', position: 'fixed', left: '0px', top: '0px' });
    document.body.appendChild(canvas);
    try {
      const w = makeWorld();
      const camera = new PerspectiveCamera(50, 1, 0.01, 100);
      const v = viewerOf(w, { renderer: { domElement: canvas }, camera });
      const cursorOn = (mesh: Mesh): { x: number; y: number } => {
        // Aim just inside the front-top-right corner of the box.
        const p = new Vector3(0.45, 0.45, 0.5).multiplyScalar((mesh.geometry as BoxGeometry).parameters.width)
          .applyMatrix4(mesh.matrixWorld).project(camera);
        return { x: (p.x + 1) * 200, y: (1 - p.y) * 200 };
      };
      const look = (mesh: Mesh): void => {
        const at = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
        camera.position.set(at.x, at.y, at.z + 3);
        camera.lookAt(at);
        camera.updateMatrixWorld(true);
      };
      const opts = { snapRadiusPx: 1000 };
      const own = w.own[0]!; // Frame
      look(own);
      resetVertexCircleMemo();
      const c1 = cursorOn(own);
      expect(queryVertexCircle(v, own, c1.x, c1.y, opts), 'own mesh answers').not.toBeNull();
      const placed = w.placed[0]!; // PlacedBody, same size
      look(placed);
      resetVertexCircleMemo();
      const c2 = cursorOn(placed);
      expect(queryVertexCircle(v, placed, c2.x, c2.y, opts)).toBeNull();
    } finally {
      canvas.remove();
    }
  });
});

// ─── Mechanism refusal ─────────────────────────────────────────────────────

function refusalFor(w: World, node: Object3D): string {
  return `"${node.name}" is part of the placed asset "${w.cell.name}". `
    + 'Open that asset (double-click the reference) to author its mechanism.';
}

function hitAt(w: World, node: Object3D) {
  return {
    raycastForRVNodeDetailed: () => ({
      path: w.registry.getPathForNode(node)!, hitPoint: [0, 0, 0], hitNormal: [0, 1, 0],
    }),
  };
}

describe('plan-774 — mechanism authoring refuses placed content', () => {
  it('the refusal text (guard wording, outermost reference)', () => {
    const w = makeWorld();
    expect(placedContentRefusal(w.slide, '"Slide"', w.root)).toBe(refusalFor(w, w.slide));
    expect(placedContentRefusal(w.own[0]!, '"Frame"', w.root)).toBeNull();
  });

  it('snap query: placed hit → refused, no candidates; own hit → candidates', () => {
    const w = makeWorld();
    const placed = querySnapCandidates(viewerOf(w, { raycastManager: hitAt(w, w.slide) }), 10, 10);
    expect(placed).toMatchObject({ candidates: [], refused: refusalFor(w, w.slide) });
    const own = querySnapCandidates(viewerOf(w, { raycastManager: hitAt(w, w.own[0]!) }), 10, 10);
    expect(own?.refused).toBeUndefined();
    expect(own?.candidates.length).toBeGreaterThan(0);
  });

  it('face pick (armed mechanism pick): hover names the refusal, a click commits nothing and stays armed', () => {
    const w = makeWorld();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    let committed = 0;
    try {
      const v = viewerOf(w, {
        renderer: { domElement: canvas }, camera: new PerspectiveCamera(), raycastManager: hitAt(w, w.slide),
      });
      startMechanismPick(v, 'anchor', 'Pick anchor A', () => { committed++; });
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
      expect(getMechanismPickSnapshot().hoverLabel).toBe(refusalFor(w, w.slide));
      window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10, button: 0 }));
      expect(committed).toBe(0);
      expect(getMechanismPickSnapshot().active).toBe(true);
      expect(getMechanismPickSnapshot().hoverLabel).toBe(refusalFor(w, w.slide));
    } finally {
      cancelMechanismPick();
      canvas.remove();
    }
  });
});

describe('plan-774 — the MCP mechanism commands refuse placed content', () => {
  let w: World;
  let viewer: RVViewer;
  let disposeDoc: () => void;
  let raycast: { raycastForRVNodeDetailed: () => unknown };

  beforeEach(async () => {
    await __clearDraftStoresForTests();
    w = makeWorld();
    const canvas = document.createElement('canvas');
    raycast = hitAt(w, w.slide);
    viewer = {
      scene: w.scene, registry: w.registry, signalStore: null, transportManager: null,
      get currentModelRoot() { return w.root; },
      renderer: { domElement: canvas },
      camera: new PerspectiveCamera(),
      get raycastManager() { return raycast; },
      modes: {
        activeMode: 'editor', has: () => true, setMode() {}, list: () => [{ id: 'editor' }],
        available: () => [{ id: 'editor' }], restrictedFallback: () => null, subscribe: () => () => {},
      },
      selectionManager: { select() {}, selectPaths() {}, clear() {}, getSnapshot: () => ({ selectedPaths: [] as string[] }) },
      getPlugin: () => undefined,
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
      rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    } as unknown as RVViewer;
    const doc = scratchAssetDocument(viewer);
    setActiveAssetContext({ viewer, doc });
    disposeDoc = () => doc.dispose();
    setMechanismUiBridge({ list: () => [] } as unknown as MechanismUiBridge);
  });

  afterEach(() => {
    setMechanismUiBridge(null);
    setActiveAssetContext(null);
    disposeDoc();
  });

  it('mechanism.snapList on a placed point → error with the refusal', async () => {
    const r = JSON.parse(await queryValue(viewer, 'mechanism.snapList', { x: 0.5, y: 0.5, maxCandidates: 12 })) as Record<string, unknown>;
    expect(r.error).toBe(refusalFor(w, w.slide));
    expect(r.candidates).toBeUndefined();
  });

  it('mechanism.snapList on an own point → candidates', async () => {
    raycast = hitAt(w, w.own[0]!);
    const r = JSON.parse(await queryValue(viewer, 'mechanism.snapList', { x: 0.5, y: 0.5, maxCandidates: 12 })) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.hit).toBe(true);
  });

  it('mechanism.setAnchorSnap with a pick on placed content → refused, nothing written', async () => {
    const jointPath = w.registry.getPathForNode(w.joint)!;
    const pickJson = JSON.stringify({
      nodePath: w.registry.getPathForNode(w.slide), worldPosition: [3, 0, 0], worldNormal: [0, 1, 0],
    });
    const before = JSON.stringify(w.joint.userData.realvirtual);
    const r = JSON.parse(await executeValue(viewer, 'mechanism.setAnchorSnap', {
      path: jointPath, componentType: 'KinematicJoint', side: 'A', candidateId: '', assignBody: true, pickJson,
    })) as Record<string, unknown>;
    expect(r.error).toBe(refusalFor(w, w.slide));
    expect(JSON.stringify(w.joint.userData.realvirtual)).toBe(before);
  });

  it('review fix R3: addJoint with a placed body (A or B) or on a placed node → refused, nothing written', async () => {
    const jointPath = w.registry.getPathForNode(w.joint)!;
    const slidePath = w.registry.getPathForNode(w.slide)!;
    const framePath = w.registry.getPathForNode(w.own[0]!)!;
    const before = JSON.stringify(w.joint.userData.realvirtual);
    for (const args of [
      { path: jointPath, jointType: 'Revolute', bodyBPath: slidePath, bodyAPath: '' },
      { path: jointPath, jointType: 'Revolute', bodyBPath: framePath, bodyAPath: slidePath },
      { path: slidePath, jointType: 'Revolute', bodyBPath: framePath, bodyAPath: '' },
    ]) {
      const r = JSON.parse(await executeValue(viewer, 'mechanism.addJoint', args)) as Record<string, unknown>;
      expect(r.error, JSON.stringify(args)).toBe(refusalFor(w, w.slide));
    }
    expect(JSON.stringify(w.joint.userData.realvirtual)).toBe(before);
    expect(w.slide.userData.realvirtual).toEqual({ Drive: { Direction: 'LinearX' } });
  });

  it('review fix R3: addBody / addBodies with a placed path and fix on a placed node → refused, nothing written', async () => {
    const slidePath = w.registry.getPathForNode(w.slide)!;
    const framePath = w.registry.getPathForNode(w.own[0]!)!;
    const frameBefore = JSON.stringify(w.own[0]!.userData.realvirtual ?? null);
    const body = JSON.parse(await executeValue(viewer, 'mechanism.addBody', { path: slidePath })) as Record<string, unknown>;
    expect(body.error).toBe(refusalFor(w, w.slide));
    const bodies = JSON.parse(await executeValue(viewer, 'mechanism.addBodies', {
      pathsJson: JSON.stringify([framePath, slidePath]),
    })) as Record<string, unknown>;
    expect(bodies.error).toBe(refusalFor(w, w.slide));
    const fix = JSON.parse(await executeValue(viewer, 'mechanism.fix', { path: slidePath, code: 'any' })) as Record<string, unknown>;
    expect(fix.error).toBe(refusalFor(w, w.slide));
    expect(w.slide.userData.realvirtual).toEqual({ Drive: { Direction: 'LinearX' } });
    expect(JSON.stringify(w.own[0]!.userData.realvirtual ?? null), 'the own body of the batch is not written either').toBe(frameBefore);
  });
});

// ─── Editor arenas: placed content (chunks AND keep meshes) never enters ─────

describe('plan-774 F9 — the editor arenas collect no placed content', () => {
  let h: EditorDocumentHarness | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  /** Placed asset with a plain Body (→ chunk) and a Lamp (`bake:'keep'` → keep mesh). */
  function makeCellWithLamp(): Group {
    const root = group('Cell');
    const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
    body.name = 'Body';
    body.position.set(2, 0.25, 0);
    root.add(body);
    const lamp = withComponent(group('Beacon'), 'Lamp', {});
    setNodeId(lamp, 'nid-lamp');
    const bulb = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial({ color: 0xffcc00 }));
    bulb.name = 'Bulb';
    lamp.add(bulb);
    lamp.position.set(2, 1, 0);
    root.add(lamp);
    return root;
  }

  it('neither chunk nor keep meshes of a placement are arena-tracked; the keep mesh renders on its own layer and picks via the bake registry', async () => {
    const doc = group('Machine');
    const frame = new Mesh(new BoxGeometry(3, 0.2, 3), new MeshStandardMaterial({ color: 0x777777 }));
    frame.name = 'Frame';
    doc.add(frame);
    doc.add(referenceNode('Cell_1', 'nid-cell', dataUrlOf(await objectToGlb(makeCellWithLamp())), true, [3, 0, 0], 'cat:cell'));
    h = await openEditorDocumentBytes('machine.glb', await objectToGlb(doc), { mode: 'deferred' });
    const v = h.viewer;
    const cell = h.nodeById('nid-cell');
    const chunks: Mesh[] = [];
    const keep: Mesh[] = [];
    cell.traverse((n) => {
      if (!(n as Mesh).isMesh) return;
      if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) chunks.push(n as Mesh);
      else keep.push(n as Mesh);
    });
    expect(chunks.length, 'the Body baked into a chunk').toBeGreaterThan(0);
    expect(keep.length, 'the Lamp bulb stays a keep mesh').toBeGreaterThan(0);

    await v.whenBvhIdle();
    const manager = new EditorArenaManager({ scene: v.scene, materialThreshold: 1 });
    try {
      manager.build(h.root);
      expect(manager.stats().deferred).toBe(0);
      const ownFrame = h.root.getObjectByName('Frame') as Mesh;
      expect(manager.refOf(ownFrame) !== undefined || manager.isStandalone(ownFrame), 'own content is collected').toBe(true);
      for (const m of [...chunks, ...keep]) {
        expect(manager.refOf(m), `${m.name} not in an arena`).toBeUndefined();
        expect(manager.isStandalone(m), `${m.name} not standalone`).toBe(false);
      }
      // Rendered by the ordinary pass: the arena did not mask the keep mesh.
      for (const m of keep) expect(m.layers.mask, `${m.name} keeps its layer`).not.toBe(0);
      // Picked through the HMI path.
      h.root.updateMatrixWorld(true);
      const bulb = keep[0]!;
      const at = new Vector3().setFromMatrixPosition(bulb.matrixWorld);
      const hits = new Raycaster(new Vector3(at.x, at.y + 5, at.z), new Vector3(0, -1, 0)).intersectObject(cell, true);
      const keepHit = hits.find((x) => x.object === bulb);
      expect(keepHit, 'a ray hits the keep mesh').toBeDefined();
      const resolved = v.bakeRegistry.resolveHit(bulb, -1) as Object3D | null;
      expect(resolved, 'the bake registry owns the keep mesh').toBeTruthy();
      // The bulb itself or its Lamp node — a node of the placed instance either way.
      expect(resolved === bulb || identityIdOf(resolved!) === 'nid-lamp').toBe(true);
      let inside = false;
      for (let n: Object3D | null = resolved; n; n = n.parent) if (n === cell) inside = true;
      expect(inside).toBe(true);
    } finally {
      manager.dispose();
    }
  });
});
