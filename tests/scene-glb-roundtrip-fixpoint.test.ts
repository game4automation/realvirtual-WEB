// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Scene GLB round-trip fixpoint (plan-752 F4, §9.6).
 *
 * The document save path used to grow. `GLTFLoader` always returns a `Group`
 * for the file's scene, and `GLTFExporter` turns only `scene.children` into
 * nodes — so handing the loaded root back to the exporter made it a NODE under
 * a freshly invented `AuxScene`, one level deeper every save. Documents that
 * had been opened and saved a few times carried `AuxScene/AuxScene_1/...`
 * above their real content, and every stored path grew with them.
 *
 * `sceneMirroringLoad` makes the save the exact inverse of the load: the root's
 * name becomes the scene name, the root's children become the file's nodes.
 * This file pins the three things that has to be true.
 *
 * Deliberately exercises the mechanism against a real `GLTFExporter` /
 * `GLTFLoader` pair (the pattern of `rv-asset-glb-export.test.ts:217-265`)
 * rather than driving `bakeSceneGlb`, which needs a workspace, an op log and a
 * base file to say anything at all about a level count.
 */
import { describe, it, expect } from 'vitest';
import {
  Group,
  Mesh,
  Object3D,
  BoxGeometry,
  MeshStandardMaterial,
  Euler,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';

// ─── helpers ────────────────────────────────────────────────────────────

/** One save of a loaded document root, exactly as the bake path does it. */
async function save(root: Object3D): Promise<ArrayBuffer> {
  return objectToGlb(sceneMirroringLoad(root));
}

/** One load, exactly as the bake path does it (`gltf.scene` is the root). */
async function load(bytes: ArrayBuffer): Promise<Object3D> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  return gltf.scene;
}

async function roundTrip(root: Object3D): Promise<Object3D> {
  return load(await save(root));
}

/** Depth of the deepest branch, root = 1. */
function depth(node: Object3D): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(depth));
}

/** Every descendant name, sorted — shape without ordering noise. */
function names(node: Object3D): string[] {
  const out: string[] = [];
  node.traverse((n) => { if (n !== node) out.push(n.name); });
  return out.sort();
}

/**
 * Resolve a stored path ROOT-EXCLUSIVE, the way `findByScenePath`
 * (`rv-scene-glb-bake.ts:1009`) resolves the paths an edit recorded. The whole
 * claim of F4 is that this keeps working across a save, so the test has to ask
 * the same question the same way.
 */
function resolvePath(root: Object3D, path: string): Object3D | null {
  let node: Object3D = root;
  for (const segment of path.split('/').filter(Boolean)) {
    const next: Object3D | undefined = node.children.find((c) => c.name === segment);
    if (!next) return null;
    node = next;
  }
  return node;
}

/** The path of `node` relative to (and excluding) `root`. */
function pathOf(root: Object3D, node: Object3D): string {
  const segments: string[] = [];
  let cur: Object3D | null = node;
  while (cur && cur !== root) {
    segments.unshift(cur.name);
    cur = cur.parent;
  }
  return segments.join('/');
}

function box(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  mesh.name = name;
  return mesh;
}

/** A document root as `GLTFLoader` hands it over: a named, identity Group. */
function buildDocument(name = 'Doc'): Group {
  const root = new Group();
  root.name = name;

  const conveyor = new Group();
  conveyor.name = 'Conveyor';
  conveyor.add(box('Belt'));
  const drive = new Group();
  drive.name = 'Drive';
  drive.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 100 } };
  drive.add(box('Roll'));
  conveyor.add(drive);
  root.add(conveyor);

  const robot = new Group();
  robot.name = 'Robot';
  robot.add(box('Base'));
  root.add(robot);

  return root;
}

// ─── 1. fresh document ──────────────────────────────────────────────────

describe('scene GLB round trip is a fixpoint (plan-752 F4)', () => {
  it('adds no level and loses no child across repeated save/load cycles', async () => {
    let root: Object3D = buildDocument();
    const originalNames = names(root);
    const originalDepth = depth(root);

    for (let i = 0; i < 4; i++) {
      root = await roundTrip(root);

      // The root's NAME becomes the scene name, so the loaded root is the
      // document again — not an `AuxScene` with the document inside it.
      expect(root.name).toBe('Doc');
      expect(root.children.map((c) => c.name).sort()).toEqual(['Conveyor', 'Robot']);
      // The two halves of F4: no level added, no child lost.
      expect(depth(root)).toBe(originalDepth);
      expect(names(root)).toEqual(originalNames);
      expect(names(root).some((n) => /^AuxScene/i.test(n))).toBe(false);
    }
  });

  it('keeps every stored child path resolvable, unchanged, across a save', async () => {
    const before = buildDocument();
    const drivePath = pathOf(before, resolvePath(before, 'Conveyor/Drive')!);
    expect(drivePath).toBe('Conveyor/Drive');

    const after = await roundTrip(before);

    // The exact string an edit recorded before the save still resolves after
    // it — that is what "child paths are untouched" has to mean.
    const drive = resolvePath(after, drivePath);
    expect(drive).not.toBeNull();
    expect((drive!.userData.realvirtual as { Drive?: unknown } | undefined)?.Drive).toBeDefined();
  });

  it('carries the root userData out as the file-level scene extras', async () => {
    // `assignExtrasToUserData` flattens `scenes[i].extras` onto the loaded
    // Group on the way in; the inverse is to put them back on the scene. If
    // they sank onto a node instead, every file-level setting would be lost.
    const root = buildDocument();
    root.userData.rv_document = { schema: 2 };

    const after = await roundTrip(root);

    expect((after.userData as { rv_document?: { schema?: number } }).rv_document?.schema).toBe(2);
  });
});

// ─── 2. legacy AuxScene chain ───────────────────────────────────────────

describe('a document that already grew a wrapper chain', () => {
  /**
   * What the old exporter left behind: one phantom level per save, above the
   * real content.
   */
  function buildGrownDocument(): Group {
    const content = buildDocument();
    const inner = new Group();
    inner.name = 'AuxScene_1';
    inner.add(content);
    const outer = new Group();
    outer.name = 'AuxScene';
    outer.add(inner);
    return outer;
  }

  it('stops growing — and is deliberately NOT healed', async () => {
    // The contract, precisely. Save-as-the-inverse-of-load makes an existing
    // chain a FIXPOINT: it never gets deeper again. It does not get shallower
    // either, and that is a decision, not an oversight — healing it means
    // `collapseWrapperChain`, which plan-752 R7 / Alternative 4 rejects
    // because it descends the WHOLE chain in one step and would invalidate
    // every path stored against the current tree at once. A legacy chain is
    // inert: it costs one `Object3D` per level and nothing else.
    //
    // (Plan §2.7 reads "loses exactly one phantom level per save". That was
    // measured against the OLD save, which ADDED one; against the tree as it
    // is loaded, the level count is simply preserved. Nothing can shed a
    // level without collapsing, and collapsing is out of scope.)
    const grown = buildGrownDocument();
    const grownDepth = depth(grown); // AuxScene > AuxScene_1 > Doc > Conveyor > Drive > Roll
    expect(grownDepth).toBe(6);

    let root: Object3D = grown;
    for (let i = 0; i < 3; i++) {
      root = await roundTrip(root);
      expect(depth(root)).toBe(grownDepth);
      expect(root.name).toBe('AuxScene');
      expect(root.children.map((c) => c.name)).toEqual(['AuxScene_1']);
    }
    // Every leaf is still there and still reachable by its stored path.
    expect(resolvePath(root, 'AuxScene_1/Doc/Conveyor/Drive/Roll')).not.toBeNull();
  });

  it('keeps the path stored against the CURRENT tree resolvable after the save', async () => {
    // The subtle half. A path recorded in this session was computed against
    // the tree as it is loaded NOW, root-exclusive. The save must not shift
    // it — shedding a level changes what the path would have been a save
    // earlier, and nothing else.
    const grown = buildGrownDocument();
    const storedPath = pathOf(grown, resolvePath(grown, 'AuxScene_1/Doc/Conveyor/Drive')!);
    expect(storedPath).toBe('AuxScene_1/Doc/Conveyor/Drive');

    const after = await roundTrip(grown);

    expect(resolvePath(after, storedPath)).not.toBeNull();
  });
});

// ─── 3. root with a real transform ──────────────────────────────────────

describe('a root that carries a real transform', () => {
  it('stays a node, and its transform survives', async () => {
    // A glTF scene cannot carry a transform. Flattening one away would move
    // the whole document, so this level has to be kept — the documented
    // exception to "the root becomes the scene".
    const root = buildDocument();
    root.position.set(10, 20, 30);
    root.rotation.copy(new Euler(0, Math.PI / 2, 0));
    root.updateMatrix();

    const after = await roundTrip(root);

    const kept = after.children.find((c) => c.name === 'Doc');
    expect(kept).toBeDefined();
    expect(kept!.position.toArray()).toEqual([10, 20, 30]);
    expect(kept!.children.map((c) => c.name).sort()).toEqual(['Conveyor', 'Robot']);
  });

  it('re-stabilises after that one save', async () => {
    // Round 2 loads an identity wrapper above the transformed node, so from
    // there on the ordinary fixpoint holds and nothing grows any further.
    const root = buildDocument();
    root.position.set(10, 0, 0);
    root.updateMatrix();

    const once = await roundTrip(root);
    const twice = await roundTrip(once);
    const thrice = await roundTrip(twice);

    expect(depth(twice)).toBe(depth(thrice));
    expect(names(twice)).toEqual(names(thrice));
  });

  it('does not re-parent the live tree it was handed', async () => {
    // `exportSceneGlb({ embedReferences: true })` passes the LIVE model root.
    // `Object3D.add()` would detach the running scene's content into a
    // throwaway Scene; `sceneMirroringLoad` borrows instead.
    const root = buildDocument();
    const conveyor = root.children.find((c) => c.name === 'Conveyor')!;

    const scene = sceneMirroringLoad(root);

    expect(scene.children).toContain(conveyor);
    expect(conveyor.parent).toBe(root);
    expect(root.children.map((c) => c.name).sort()).toEqual(['Conveyor', 'Robot']);
  });

  it('does not recompute the matrix of a node with matrixAutoUpdate off', async () => {
    // The planner and every frozen drive subtree write `matrix` directly and
    // leave `matrixAutoUpdate` false. `updateMatrix()` would rebuild it from
    // the now-stale position/quaternion/scale and silently move the document.
    const root = buildDocument();
    root.matrixAutoUpdate = false;
    root.matrix.makeTranslation(5, 6, 7); // position/quaternion left at identity

    const scene = sceneMirroringLoad(root);

    expect(root.matrix.elements[12]).toBe(5);
    expect(root.matrix.elements[14]).toBe(7);
    // Non-identity → the root is kept as a node rather than flattened away.
    expect(scene.children).toEqual([root]);
  });
});
