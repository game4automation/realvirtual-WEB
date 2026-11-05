// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.2 — what a document thumbnail shows (#11, P8).
 *
 * There is one kind of document (plan-716) and one capture for every save. A
 * placed reference IS file content: the PlacementInstancer materialises it as
 * `_rvBakeChunk` meshes (and keep meshes) UNDER the reference node inside the
 * model root, so the capture keeps them — the GLB export drops chunks, the
 * picture must not (the 2026-11-02 bug: an asset of placed references
 * rendered only its one own part). Pinned: the content rule (helpers, guides,
 * MUs, arenas and `rv.Hidden` nodes out; view-hidden nodes in; placements in),
 * world transforms, the framing over the complete content, the arena capture
 * mode, the live scene left untouched, and real pixels of the placement.
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  DirectionalLight,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Scene,
  WebGLRenderer,
} from 'three';
import {
  captureDocument,
  documentContentRoots,
  isThumbnailExcludedNode,
} from '../src/core/thumbnails/thumbnail-content';
import { renderThumbnailImage, type ThumbnailViewer } from '../src/core/thumbnails/rv-thumbnail-write';
import { setSceneArenaSink } from '../src/core/engine/rv-arena-sink';

const GREEN = 0x20c040;
const RED = 0xff0000;
const BLUE = 0x0000ff;

function box(name: string, x = 0, color = GREEN): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color }));
  m.name = name;
  m.position.x = x;
  return m;
}

/**
 * A placement as `BakeRegistry.instantiate` builds it: the reference node keeps
 * its transform, a chunk `Mesh` hangs under it with an identity local matrix
 * (positions baked into the owner frame, `matrixAutoUpdate = false`), a keep
 * mesh is an ordinary clone under a logic node.
 */
function makePlacement(x: number): { ref: Group; chunk: Mesh; keep: Mesh } {
  const ref = new Group();
  ref.name = 'Gantry';
  ref.position.set(x, 0, 0);
  ref.userData.realvirtual = { AssetReference: { path: 'library/Gantry.glb' } };
  ref.userData._layoutNestedId = 'p1';
  const geometry = new BoxGeometry(2, 1, 1);
  geometry.translate(0, 1, 0);                              // baked into the owner frame
  const chunk = new Mesh(geometry, new MeshBasicMaterial({ color: RED }));
  chunk.name = 'Gantry|chunk0';
  chunk.matrixAutoUpdate = false;
  chunk.userData._rvBakeChunk = true;
  const logic = new Group();
  logic.name = 'Slide';
  const keep = box('Lamp', 0, GREEN);                     // red pixels come from the CHUNK alone
  keep.position.y = 2;
  logic.add(keep);
  ref.add(chunk, logic);
  return { ref, chunk, keep };
}

interface Fixture {
  scene: Scene;
  model: Group;
  layoutRoot: Group;
  nodes: Record<string, Object3D>;
}

function makeScene(): Fixture {
  const scene = new Scene();
  scene.add(new DirectionalLight(0xffffff, 1));
  const ground = box('Ground', 0, BLUE);
  ground.userData._rvGroundPlane = true;
  scene.add(ground);                                       // not document content

  const model = new Group();
  model.name = 'Model';
  model.position.z = 3;                                    // the clone takes the WORLD transform
  const part = box('Part', 0);
  const tempHidden = box('TempHidden', 2);
  tempHidden.visible = false;                              // hidden in the VIEW only
  const docHidden = box('DocHidden', -2, BLUE);
  docHidden.visible = false;
  docHidden.userData.realvirtual = { Hidden: true };       // hidden in the DOCUMENT
  const bvh = box('__raycastBVH_helper', 4, BLUE);
  bvh.userData._rvRaycastBVH = true;                       // helpers are recognised by MARKER
  const mu = box('MU_1', 6, BLUE);
  mu.userData._muSelectable = true;
  const gizmo = box('gizmo', 7, BLUE);
  gizmo.userData._rvGizmo = true;
  const arena = box('arena', -6, BLUE);
  arena.userData._rvBatchedRender = true;                  // its sources are captured instead
  const { ref, chunk, keep } = makePlacement(10);
  model.add(part, tempHidden, docHidden, bvh, mu, gizmo, arena, ref);
  scene.add(model);

  const layoutRoot = new Group();
  layoutRoot.name = '_layoutRoot';
  layoutRoot.userData._isLayoutRoot = true;
  const floor = box('Floor', 0, BLUE);
  floor.userData._layoutFloor = true;
  const floorGizmo = new Group();
  floorGizmo.name = '_floorGizmo';
  floorGizmo.add(box('handle', 0, BLUE));
  const guide = box('_layoutSnapGuide', 0, BLUE);
  const grid = new GridHelper(10, 10);
  const placed = box('Placed', -8);                        // a placement while no model was loaded
  layoutRoot.add(floor, floorGizmo, guide, grid, placed);
  scene.add(layoutRoot);
  scene.updateMatrixWorld(true);

  return {
    scene, model, layoutRoot,
    nodes: {
      ground, part, tempHidden, docHidden, bvh, mu, gizmo, arena, ref, chunk, keep,
      floor, floorGizmo, guide, grid, placed,
    },
  };
}

function namesOf(root: Object3D): Set<string> {
  const out = new Set<string>();
  root.traverse((o) => out.add(o.name));
  return out;
}

function snapshot(scene: Scene): Map<Object3D, { visible: boolean; parent: Object3D | null; ud: string }> {
  const out = new Map<Object3D, { visible: boolean; parent: Object3D | null; ud: string }>();
  scene.traverse((o) => out.set(o, { visible: o.visible, parent: o.parent, ud: JSON.stringify(o.userData) }));
  return out;
}

describe('captureDocument — one content rule for every document', () => {
  it('keeps own parts AND materialised placements; drops helpers, guides, MUs, arenas and rv.Hidden', () => {
    const f = makeScene();
    const capture = captureDocument(documentContentRoots({ scene: f.scene, currentModelRoot: f.model }));
    try {
      const names = namesOf(capture.root);
      for (const kept of ['Part', 'TempHidden', 'Gantry', 'Gantry|chunk0', 'Slide', 'Lamp', 'Placed']) {
        expect(names.has(kept), kept).toBe(true);
      }
      for (const out of ['Ground', 'DocHidden', '__raycastBVH_helper', 'MU_1', 'gizmo', 'arena',
        'Floor', '_floorGizmo', 'handle', '_layoutSnapGuide']) {
        expect(names.has(out), out).toBe(false);
      }
      let helpers = 0;
      capture.root.traverse((o) => { if (/Helper$/.test(o.type)) helpers++; });
      expect(helpers).toBe(0);
      // The view-hidden node is shown in the picture.
      capture.root.traverse((o) => { if (o.name === 'TempHidden') expect(o.visible).toBe(true); });
    } finally {
      capture.dispose();
    }
  });

  it('frames the COMPLETE content: the placement and the layout root at their world positions', () => {
    const f = makeScene();
    const capture = captureDocument(documentContentRoots({ scene: f.scene, currentModelRoot: f.model }));
    try {
      // Placed (layout root) at x = -8 … the gantry chunk at x = 10 ± 1.
      expect(capture.bounds.min.x).toBeCloseTo(-8.5, 3);
      expect(capture.bounds.max.x).toBeCloseTo(11, 3);
      // The model root sits at z = 3 in the world; the layout root at z = 0.
      expect(capture.bounds.max.z).toBeCloseTo(3.5, 3);
      expect(capture.bounds.min.z).toBeCloseTo(-0.5, 3);
      // The chunk's baked +1 m in y under the reference node survives the clone.
      expect(capture.bounds.max.y).toBeCloseTo(2.5, 3);
    } finally {
      capture.dispose();
    }
  });

  it('clones in arena capture mode: a masked source is drawn, the arena is not, the masks come back', () => {
    const scene = new Scene();
    const model = new Group();
    const source = box('Source', 0);
    source.layers.mask = 0;                                // drawn through an editor arena
    model.add(source);
    scene.add(model);
    scene.updateMatrixWorld(true);
    const calls: string[] = [];
    setSceneArenaSink(scene, {
      bumpVisibility() {},
      enterCapture() { calls.push('enter'); source.layers.mask = 1; },
      leaveCapture() { calls.push('leave'); source.layers.mask = 0; },
    });
    try {
      const capture = captureDocument([model]);
      expect(calls).toEqual(['enter', 'leave']);
      expect(source.layers.mask).toBe(0);
      expect(capture.bounds.isEmpty()).toBe(false);
      capture.dispose();
    } finally {
      setSceneArenaSink(scene, null);
    }
  });

  it('changes nothing in the live scene and frees no shared geometry or material', () => {
    const f = makeScene();
    const before = snapshot(f.scene);
    let freed = 0;
    for (const m of [f.nodes.part, f.nodes.chunk, f.nodes.keep] as Mesh[]) {
      m.geometry.addEventListener('dispose', () => freed++);
      (m.material as MeshBasicMaterial).addEventListener('dispose', () => freed++);
    }
    const capture = captureDocument(documentContentRoots({ scene: f.scene, currentModelRoot: f.model }));
    capture.dispose();
    expect(freed).toBe(0);
    const after = snapshot(f.scene);
    expect(after.size).toBe(before.size);
    for (const [node, s] of before) expect(after.get(node), node.name).toEqual(s);
  });

  it('the predicate: a bake chunk is content, an arena and an MU are not', () => {
    const chunk = box('chunk');
    chunk.userData._rvBakeChunk = true;
    const arena = box('arena');
    arena.userData._rvBatchedRender = true;
    const mu = box('mu');
    mu.userData._muSelectable = true;
    expect(isThumbnailExcludedNode(chunk)).toBe(false);
    expect(isThumbnailExcludedNode(arena)).toBe(true);
    expect(isThumbnailExcludedNode(mu)).toBe(true);
  });
});

/** Count pixels of a colour family in a decoded thumbnail. */
async function countPixels(bytes: Uint8Array): Promise<{ red: number; green: number; blue: number }> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/webp' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  let red = 0, green = 0, blue = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200) continue;
    // Hue families with a margin: the studio look lifts the colours (no tone
    // mapping, sRGB output), so absolute thresholds would be brittle.
    if (r > g + 60 && r > b + 60) red++;
    else if (g > r + 60 && g > b + 40) green++;
    else if (b > r + 60 && b > g + 60) blue++;
  }
  return { red, green, blue };
}

describe('renderThumbnailImage — every document through the one studio render', () => {
  it('draws the own part AND the placement, and none of the helpers; the live scene is unchanged', async () => {
    const f = makeScene();
    const before = snapshot(f.scene);
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true });
    try {
      const image = await renderThumbnailImage({ renderer, scene: f.scene, currentModelRoot: f.model });
      expect(image).not.toBeNull();
      const px = await countPixels(image!.bytes);
      expect(px.green).toBeGreaterThan(20);                // the own part
      expect(px.red).toBeGreaterThan(20);                  // the placement's bake chunk
      expect(px.blue).toBe(0);                             // MU, BVH, gizmo, arena, floor, ground
      const after = snapshot(f.scene);
      for (const [node, s] of before) expect(after.get(node), node.name).toEqual(s);
    } finally {
      renderer.dispose();
    }
  });

  it('waits for the scene to be complete: a placement materialised before the join is in the picture', async () => {
    const scene = new Scene();
    const model = new Group();
    model.add(box('Part', 0));
    scene.add(model);
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true });
    const viewer: ThumbnailViewer = {
      renderer, scene, currentModelRoot: model,
      // The instancer finishes the placement, then the join resolves.
      whenSceneReady: async () => { model.add(makePlacement(3).ref); },
    };
    try {
      const image = await renderThumbnailImage(viewer);
      expect(image).not.toBeNull();
      expect((await countPixels(image!.bytes)).red).toBeGreaterThan(20);
    } finally {
      renderer.dispose();
    }
  });

  it('answers null for an empty document (#10)', async () => {
    const scene = new Scene();
    const root = new Group();
    scene.add(root);
    const renderer = new WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true });
    try {
      expect(await renderThumbnailImage({ renderer, scene, currentModelRoot: root })).toBeNull();
    } finally {
      renderer.dispose();
    }
  });
});
