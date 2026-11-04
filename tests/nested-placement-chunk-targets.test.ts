// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 fix — highlight and bounds of a placement whose asset consists only
 * of nested placements.
 *
 * Live case: `mhm` (planner placement, 0 own chunks) → `fufu` (nested, 0 own
 * chunks) → `empty`, `empty_1`, `empty_2` (nested, they own the chunks). The
 * registry's ONE walk (`_visitChunkTargets`) returned only the chunks of the
 * node's own instance, so selecting / hovering `mhm` drew nothing and its
 * bounds were the 0.1 m fallback. Now every live instance nested below a node
 * contributes all of its chunks:
 *
 *  - a references-only placement root answers with the chunks of every nested
 *    instance (two levels deep), all whole; its bounds cover them;
 *  - a node inside the outer asset with references below it gets them too;
 *  - an asset with own geometry AND a reference answers with both;
 *  - a released nested instance drops out; an instance registered BEFORE its
 *    outer one is adopted;
 *  - a node outside every placement (a layout group) reaches the placements
 *    below it; with nothing below it stays `null`;
 *  - the highlight manager draws them: chunk outline (planner), chunk-overlay
 *    proxies (HMI), native outline + overlay pairs for a root outside every
 *    placement.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene } from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  BakeRegistry, type ChunkHighlightSource, type ChunkHighlightTarget, type PlacementInstance,
} from '../src/core/engine/rv-bake-registry';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { MODE_HIGHLIGHT_PROFILES } from '../src/core/engine/rv-highlight-profiles';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { PlacementInstancer } from '../src/core/engine/rv-placement-instancer';
import { bakeAndPlace, bakeTree, group, uberMesh, withComponent } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

/** The leaf `empty`: static body + a Drive with its own mover chunk. */
function makeLeaf(): Group {
  const root = group('Empty');
  root.add(uberMesh(uber, 'body'));
  const drive = withComponent(group('Drive-A'), 'Drive');
  drive.add(uberMesh(uber, 'arm', [0, 0, 2]));
  root.add(drive);
  return root;
}

function ref(name: string, x: number): Group {
  const node = group(name);
  node.position.set(x, 0, 0);
  setAssetReference(node, { assetId: `cat:${name}`, path: `blob:rv-test/${name}.glb` });
  return node;
}

/** `fufu`: Mount / three references — no geometry of its own. */
function makeFufu(): Group {
  const root = group('Fufu');
  const mount = group('Mount');
  mount.add(ref('empty', 0), ref('empty_1', 4), ref('empty_2', 8));
  root.add(mount);
  return root;
}

/** `mhm`: one reference to `fufu` — no geometry of its own. */
function makeMhm(): Group {
  const root = group('Mhm');
  root.add(ref('fufu_1', 0));
  return root;
}

/** Own geometry AND a reference under a static intermediate node. */
function makeMixed(): Group {
  const root = group('Mixed');
  root.add(uberMesh(uber, 'frame', [-3, 0, 0]));
  const bay = group('Bay');
  bay.add(ref('leaf_1', 3));
  root.add(bay);
  return root;
}

function byName(root: Object3D, name: string): Object3D {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  if (!found) throw new Error(`no node ${name}`);
  return found;
}

/** Records what each OutlinePass channel was handed. */
function fakeOutlineManager() {
  const channels = { selection: [] as Object3D[], hover: [] as Object3D[], flash: [] as Object3D[] };
  return {
    channels,
    available: true,
    hoverPass: null,
    setStyle() {}, setHoverStyle() {}, setFlashStyle() {},
    setOutlined(o: readonly Object3D[]) { channels.selection = [...o]; },
    setHoverOutlined(o: readonly Object3D[]) { channels.hover = [...o]; },
    setFlashOutlined(o: readonly Object3D[]) { channels.flash = [...o]; },
    clearHover() { channels.hover = []; },
    clearFlash() { channels.flash = []; },
    clear() { channels.selection = []; },
  };
}

describe('nested placement chunk targets (plan-774)', () => {
  let leafBaked: BakedAsset;
  let fufuBaked: BakedAsset;
  let mhmBaked: BakedAsset;
  let mixedBaked: BakedAsset;
  beforeAll(async () => {
    leafBaked = await bakeTree(makeLeaf(), { uber, assetId: 'empty' });
    fufuBaked = await bakeTree(makeFufu(), { uber, assetId: 'fufu' });
    mhmBaked = await bakeTree(makeMhm(), { uber, assetId: 'mhm' });
    mixedBaked = await bakeTree(makeMixed(), { uber, assetId: 'mixed' });
  });

  /** layout / mhm → fufu_1 (fufu) → empty, empty_1, empty_2 (leaf) — what the instancer builds. */
  function setup() {
    const scene = new Scene();
    const registry = new BakeRegistry();
    const layout = group('Layout');
    scene.add(layout);
    const root = group('mhm');
    root.position.set(10, 0, 0);
    layout.add(root);
    const mhm = registry.instantiate(mhmBaked, root);
    const fufuRoot = byName(root, 'fufu_1');
    const fufu = registry.instantiate(fufuBaked, fufuRoot);
    const mount = byName(fufuRoot, 'Mount');
    const leaves = ['empty', 'empty_1', 'empty_2'].map((n) => registry.instantiate(leafBaked, byName(mount, n)));
    scene.updateMatrixWorld(true);
    const leafChunks = leaves.flatMap((l) => l.chunks);
    return { scene, registry, layout, root, mhm, fufu, fufuRoot, mount, leaves, leafChunks };
  }

  function meshesOf(registry: BakeRegistry, node: Object3D): Set<Mesh> | null {
    const t = registry.chunkTargetsOf(node);
    return t ? new Set(t.map((x) => x.mesh)) : null;
  }

  it('the fixture matches the live case: outer assets own no chunk, the leaves do', () => {
    const { mhm, fufu, leaves } = setup();
    expect(mhm.chunks).toHaveLength(0);
    expect(fufu.chunks).toHaveLength(0);
    for (const l of leaves) expect(l.chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('a references-only placement root answers with every nested instance chunk, two levels deep, all whole', () => {
    const { registry, root, leafChunks } = setup();
    const targets = registry.chunkTargetsOf(root)!;
    expect(targets).not.toBeNull();
    expect(new Set(targets.map((t) => t.mesh))).toEqual(new Set(leafChunks));
    expect(targets).toHaveLength(leafChunks.length); // no duplicates
    expect(targets.every((t) => t.range === null)).toBe(true);
  });

  it('the nested root and a node inside the outer asset above the references get them too', () => {
    const { registry, fufuRoot, mount, leaves, leafChunks } = setup();
    expect(meshesOf(registry, fufuRoot)).toEqual(new Set(leafChunks));
    expect(meshesOf(registry, mount)).toEqual(new Set(leafChunks));
    // A leaf root still answers with ITS chunks only.
    expect(meshesOf(registry, leaves[1].root)).toEqual(new Set(leaves[1].chunks));
  });

  it('chunkBoundsOf covers the nested chunks (no fallback cube)', () => {
    const { registry, root, leafChunks } = setup();
    const box = new Box3();
    expect(registry.chunkBoundsOf(root, box)).toBe(true);
    const expected = new Box3();
    for (const m of leafChunks) {
      m.geometry.computeBoundingBox();
      expected.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
    }
    expect(box.min.distanceTo(expected.min)).toBeLessThan(1e-6);
    expect(box.max.distanceTo(expected.max)).toBeLessThan(1e-6);
    // Three leaves 4 m apart, placed at x = 10: far more than the 0.1 m cube.
    expect(box.max.x - box.min.x).toBeGreaterThan(8);
  });

  it('an asset with own geometry AND a reference answers with both', () => {
    const scene = new Scene();
    const registry = new BakeRegistry();
    const root = group('mixed');
    scene.add(root);
    const mixed = registry.instantiate(mixedBaked, root);
    const bay = byName(root, 'Bay');
    const leaf = registry.instantiate(leafBaked, byName(bay, 'leaf_1'));
    expect(mixed.chunks.length).toBeGreaterThan(0);
    expect(meshesOf(registry, root)).toEqual(new Set([...mixed.chunks, ...leaf.chunks]));
    // `Bay` owns no triangles of its own — just the leaf below it.
    expect(meshesOf(registry, bay)).toEqual(new Set(leaf.chunks));
  });

  it('a released nested instance drops out; releasing the subtree leaves nothing', () => {
    const { registry, root, leaves } = setup();
    registry.release(leaves[0]);
    const remaining = new Set([...leaves[1].chunks, ...leaves[2].chunks]);
    expect(meshesOf(registry, root)).toEqual(remaining);
    registry.releaseSubtree(root);
    expect(registry.chunkTargetsOf(root)).toBeNull();
    expect(registry.instances.size).toBe(0);
  });

  it('a lone release of the middle instance keeps its nested ones reachable from above', () => {
    const { registry, layout, fufu, leafChunks } = setup();
    // `release(fufu)` detaches fufu's clone (and the leaf roots with it) —
    // the leaves become top level; nothing may throw or report stale chunks.
    registry.release(fufu);
    expect(registry.chunkTargetsOf(fufu.root)).toBeNull();
    const fromLayout = meshesOf(registry, layout);
    for (const m of leafChunks) expect(fromLayout?.has(m) ?? false).toBe(false);
  });

  it('an instance registered BEFORE its enclosing one is adopted', () => {
    const scene = new Scene();
    const registry = new BakeRegistry();
    const outerRoot = group('outer');
    const pre = group('pre');
    outerRoot.add(pre);
    scene.add(outerRoot);
    const early = registry.instantiate(leafBaked, pre);
    const outer: PlacementInstance = registry.instantiate(mixedBaked, outerRoot);
    expect(meshesOf(registry, outerRoot)).toEqual(new Set([...outer.chunks, ...early.chunks]));
  });

  it('a node outside every placement reaches the placements below it, else stays null', () => {
    const { scene, registry, layout, leafChunks } = setup();
    expect(meshesOf(registry, layout)).toEqual(new Set(leafChunks));
    const lonely = group('Lonely');
    lonely.add(group('child'));
    scene.add(lonely);
    expect(registry.chunkTargetsOf(lonely)).toBeNull();
    expect(registry.chunkBoundsOf(lonely, new Box3())).toBe(false);
  });

  describe('re-linking after a move (F1)', () => {
    it('a placement materialised DETACHED and attached under an instance root is reached after relinkSubtree', () => {
      const scene = new Scene();
      const registry = new BakeRegistry();
      const outerRoot = group('outer');
      scene.add(outerRoot);
      const outer = registry.instantiate(mixedBaked, outerRoot);
      // A live drop: materialised before it has a parent (scene-mutations).
      const dropRoot = group('drop');
      const drop = registry.instantiate(leafBaked, dropRoot);
      outerRoot.add(dropRoot);
      registry.relinkSubtree(dropRoot);
      expect(meshesOf(registry, outerRoot)).toEqual(new Set([...outer.chunks, ...drop.chunks]));
    });

    it('…under the main-model identity instance (instantiateTemplate)', async () => {
      const scene = new Scene();
      const registry = new BakeRegistry();
      const main = await bakeAndPlace(makeLeaf(), registry, { uber, assetId: 'main' });
      scene.add(main.template);
      const dropRoot = group('drop');
      const drop = registry.instantiate(mixedBaked, dropRoot);
      main.template.add(dropRoot);
      registry.relinkSubtree(dropRoot);
      expect(meshesOf(registry, main.template)).toEqual(new Set([...main.instance.chunks, ...drop.chunks]));
    });

    it('a node holding several placements relinks every one of them, and their nesting stays', () => {
      const s = setup();
      const host = group('host');
      s.scene.add(host);
      const outerRoot = group('outer');
      host.add(outerRoot);
      const outer = s.registry.instantiate(mixedBaked, outerRoot);
      // Move the whole `mhm` placement (with its nested fufu → leaves) under the outer.
      byName(outerRoot, 'Bay').attach(s.root);
      s.registry.relinkSubtree(s.root);
      expect(meshesOf(s.registry, outerRoot)).toEqual(new Set([...outer.chunks, ...s.leafChunks]));
      expect(meshesOf(s.registry, s.root)).toEqual(new Set(s.leafChunks));
      // …and back out: the layout reaches them again, the outer does not.
      s.layout.attach(s.root);
      s.registry.relinkSubtree(s.layout);
      expect(meshesOf(s.registry, outerRoot)).toEqual(new Set(outer.chunks));
      expect(meshesOf(s.registry, s.layout)).toEqual(new Set(s.leafChunks));
    });

    it('a placement reparented OUT of an instance drops out of it', () => {
      const { scene, registry, root, fufuRoot, leaves, leafChunks } = setup();
      scene.attach(leaves[0].root);
      registry.relinkSubtree(leaves[0].root);
      const rest = new Set(leafChunks.filter((m) => !leaves[0].chunks.includes(m)));
      expect(meshesOf(registry, root)).toEqual(rest);
      expect(meshesOf(registry, fufuRoot)).toEqual(rest);
      expect(meshesOf(registry, leaves[0].root)).toEqual(new Set(leaves[0].chunks));
    });

    it('relinkSubtree on a node without placements is a no-op', () => {
      const { registry, root, leafChunks } = setup();
      const lonely = group('lonely');
      registry.relinkSubtree(lonely);
      expect(meshesOf(registry, root)).toEqual(new Set(leafChunks));
    });
  });

  describe('registration order (F2)', () => {
    /** outer (mixed) / Bay / mid / leafRoot — with `mid` registered LAST. */
    function outerLeafMiddle() {
      const scene = new Scene();
      const registry = new BakeRegistry();
      const outerRoot = group('outer');
      scene.add(outerRoot);
      const outer = registry.instantiate(mixedBaked, outerRoot);
      const mid = group('mid');
      const leafRoot = group('leafRoot');
      mid.add(leafRoot);
      byName(outerRoot, 'Bay').add(mid);
      const leaf = registry.instantiate(leafBaked, leafRoot);
      const middle = registry.instantiate(leafBaked, mid);
      return { scene, registry, outerRoot, outer, mid, leaf, middle };
    }

    it('outer → leaf → middle: the middle adopts the leaf from the outer', () => {
      const { registry, outerRoot, outer, mid, leaf, middle } = outerLeafMiddle();
      expect(meshesOf(registry, mid)).toEqual(new Set([...middle.chunks, ...leaf.chunks]));
      const all = registry.chunkTargetsOf(outerRoot)!;
      expect(new Set(all.map((t) => t.mesh))).toEqual(new Set([...outer.chunks, ...middle.chunks, ...leaf.chunks]));
      expect(all).toHaveLength(outer.chunks.length + middle.chunks.length + leaf.chunks.length); // no duplicates
    });

    it('a lone release of the middle hands the leaf back to its nearest enclosing instance', () => {
      const { registry, outerRoot, outer, leaf, middle } = outerLeafMiddle();
      registry.release(middle);
      expect(meshesOf(registry, outerRoot)).toEqual(new Set([...outer.chunks, ...leaf.chunks]));
    });

    it('only the NEAREST instances are adopted (a deeper one stays with its own enclosing)', () => {
      const scene = new Scene();
      const registry = new BakeRegistry();
      const a = group('a');
      const b = group('b');
      const c = group('c');
      a.add(b);
      b.add(c);
      scene.add(a);
      const cInst = registry.instantiate(leafBaked, c);
      const bInst = registry.instantiate(leafBaked, b); // adopts c
      const aInst = registry.instantiate(leafBaked, a); // adopts b only
      expect(meshesOf(registry, b)).toEqual(new Set([...bInst.chunks, ...cInst.chunks]));
      const all = registry.chunkTargetsOf(a)!;
      expect(all).toHaveLength(aInst.chunks.length + bInst.chunks.length + cInst.chunks.length);
      registry.release(bInst);
      // c goes back to a, not to the top level.
      expect(meshesOf(registry, a)).toEqual(new Set([...aInst.chunks, ...cInst.chunks]));
    });
  });

  describe('teardown leaves no nesting behind (F7)', () => {
    const topLevelOf = (registry: BakeRegistry): Set<unknown> =>
      (registry as unknown as { _topLevel: Set<unknown> })._topLevel;

    it('releaseAll empties the top-level set', () => {
      const { registry } = setup();
      registry.releaseAll();
      expect(registry.stats().instances).toBe(0);
      expect(topLevelOf(registry).size).toBe(0);
    });

    it('clearDocument({ documentRoots }) releases every nested instance and empties the top-level set', () => {
      const { registry, layout } = setup();
      // A second, top-level drop beside the document.
      const drop = group('drop');
      registry.instantiate(leafBaked, drop);
      layout.add(drop);
      registry.relinkSubtree(drop);
      const instancer = new PlacementInstancer({ bakeRegistry: () => registry });
      instancer.clearDocument({ documentRoots: [layout] });
      expect(registry.stats().instances).toBe(0);
      expect(topLevelOf(registry).size).toBe(0);
    });
  });

  describe('highlight manager', () => {
    function withHighlighter(profile: 'planner' | 'hmi') {
      const s = setup();
      const om = fakeOutlineManager();
      const hm = new RVHighlightManager(s.scene);
      hm.setOutlineManager(om as never);
      hm.setChunkSource(s.registry);
      hm.setProfile(MODE_HIGHLIGHT_PROFILES[profile]);
      return { ...s, om, hm };
    }
    const pairsOf = (hm: RVHighlightManager, channel: 'hoverPairs' | 'selectionPairs'): unknown[] =>
      (hm as unknown as Record<string, unknown[]>)[channel];

    it('planner: selecting and hovering the references-only root outline every nested chunk', () => {
      const { hm, om, root, fufuRoot, leafChunks } = withHighlighter('planner');
      hm.highlightSelection([root]);
      expect(new Set(om.channels.selection)).toEqual(new Set(leafChunks));
      expect(hm.isSelectionActive).toBe(true);
      hm.highlight(fufuRoot);
      expect(new Set(om.channels.hover)).toEqual(new Set(leafChunks));
    });

    it('hmi: the references-only root gets one chunk-overlay proxy per nested chunk', () => {
      const { hm, root, leafChunks } = withHighlighter('hmi');
      hm.highlight(root);
      expect(hm.activeChunkProxies).toHaveLength(leafChunks.length);
      hm.clear();
      hm.highlightSelection([root]);
      expect(hm.activeChunkProxies).toHaveLength(leafChunks.length);
      expect(hm.isSelectionActive).toBe(true);
    });

    it('a root outside every placement: native outline (planner), proxies + pairs for its own meshes (hmi)', () => {
      const planner = withHighlighter('planner');
      planner.hm.highlight(planner.layout);
      // The OutlinePass walks the subtree — the nested chunk meshes included.
      expect(planner.om.channels.hover).toEqual([planner.layout]);

      const hmi = withHighlighter('hmi');
      const plain = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
      plain.name = 'plain';
      hmi.layout.add(plain);
      hmi.scene.updateMatrixWorld(true);
      hmi.hm.highlight(hmi.layout);
      expect(hmi.hm.activeChunkProxies).toHaveLength(hmi.leafChunks.length);
      expect(pairsOf(hmi.hm, 'hoverPairs')).toHaveLength(1);
      hmi.hm.clear();
      hmi.hm.highlightSelection([hmi.layout]);
      expect(hmi.hm.activeChunkProxies).toHaveLength(hmi.leafChunks.length);
      expect(pairsOf(hmi.hm, 'selectionPairs')).toHaveLength(1);
    });

    const lastStrategyOf = (hm: RVHighlightManager): string =>
      (hm as unknown as { _lastStrategy: string })._lastStrategy;

    it('F3: one chunkTargetsOf per root and highlight', () => {
      const { hm, registry, root, leaves } = withHighlighter('hmi');
      const spy = vi.spyOn(registry, 'chunkTargetsOf');
      hm.highlight(root);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      hm.highlightSelection([root, leaves[0].root]);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockClear();
      hm.highlightMultiple([root, leaves[1].root]);
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it('F4: a single-asset root with 300 chunk targets still gets 300 proxies — no bbox (as origin/main)', () => {
      const scene = new Scene();
      const assetRoot = group('BigAsset');
      scene.add(assetRoot);
      const targets: ChunkHighlightTarget[] = [];
      for (let i = 0; i < 300; i++) {
        const chunk = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
        chunk.position.set(i, 0, 0);
        assetRoot.add(chunk);
        targets.push({ mesh: chunk, range: null });
      }
      scene.updateMatrixWorld(true);
      const source: ChunkHighlightSource = {
        chunkTargetsOf: (n) => (n === assetRoot ? targets : null),
        placementOf: (n) => (n === assetRoot ? assetRoot : null),
        onRelease: () => () => {},
      };
      const hm = new RVHighlightManager(scene);
      hm.setOutlineManager(fakeOutlineManager() as never);
      hm.setChunkSource(source);
      hm.setProfile(MODE_HIGHLIGHT_PROFILES.hmi);
      expect(hm.maxHoverMeshes).toBe(200);
      expect(hm.maxHoverChunks).toBe(2048);
      hm.highlight(assetRoot);
      expect(hm.activeChunkProxies).toHaveLength(300);
      expect(lastStrategyOf(hm)).toBe('chunk-overlay');
      expect(pairsOf(hm, 'hoverPairs')).toHaveLength(0);
      hm.highlightMultiple([assetRoot]);
      expect(hm.activeChunkProxies).toHaveLength(300);
      expect(lastStrategyOf(hm)).toBe('chunk-overlay');
      hm.clear();
      hm.highlightSelection([assetRoot]);
      expect(hm.activeChunkProxies).toHaveLength(300);
      expect(pairsOf(hm, 'selectionPairs')).toHaveLength(0);
      hm.clearSelection();
      hm.setAuxEmphasis('ghost', [assetRoot]);
      expect(hm.activeChunkProxies).toHaveLength(300);
      hm.setAuxEmphasis('ghost', null);
      // A profile can override the chunk budget like the mesh budget.
      hm.setProfile({ ...MODE_HIGHLIGHT_PROFILES.hmi, maxHoverChunks: 299 });
      expect(hm.maxHoverChunks).toBe(299);
      hm.highlight(assetRoot);
      expect(hm.activeChunkProxies).toHaveLength(0);
      expect(lastStrategyOf(hm)).toBe('bbox');
    });

    it('F4: the mesh budget does not cap chunk proxies, only the pairs beside them', () => {
      const { hm, root, leafChunks, layout, scene } = withHighlighter('hmi');
      hm.maxHoverMeshes = 1;
      hm.highlight(root);
      expect(hm.activeChunkProxies).toHaveLength(leafChunks.length);
      expect(lastStrategyOf(hm)).toBe('chunk-overlay');
      // A root outside every placement with more own meshes than the mesh budget boxes.
      for (const n of ['p1', 'p2']) {
        const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
        m.name = n;
        layout.add(m);
      }
      scene.updateMatrixWorld(true);
      hm.highlight(layout);
      expect(hm.activeChunkProxies).toHaveLength(0);
      expect(lastStrategyOf(hm)).toBe('bbox');
      // Multi-hover: the outside root's pairs overflow the mesh budget and box
      // it; the placement root without pairs keeps its proxies.
      hm.highlightMultiple([layout, root]);
      expect(hm.activeChunkProxies).toHaveLength(leafChunks.length);
      expect(lastStrategyOf(hm)).toBe('bbox');
      expect(pairsOf(hm, 'hoverPairs')).toHaveLength(1); // the layout's box
    });

    it('F4: an outer root with more chunks than the chunk budget falls back to the bbox — no proxies', () => {
      const { hm, root, leaves, leafChunks } = withHighlighter('hmi');
      hm.maxHoverChunks = leafChunks.length - 1;
      hm.highlight(root);
      expect(hm.activeChunkProxies).toHaveLength(0);
      expect(lastStrategyOf(hm)).toBe('bbox');
      expect(pairsOf(hm, 'hoverPairs')).toHaveLength(1); // the box
      hm.clear();
      hm.highlightSelection([root]);
      expect(hm.activeChunkProxies).toHaveLength(0);
      expect(pairsOf(hm, 'selectionPairs')).toHaveLength(1);
      expect(hm.isSelectionActive).toBe(true);
      hm.clearSelection();
      hm.setAuxEmphasis('ghost', [root]);
      expect(hm.activeChunkProxies).toHaveLength(0);
      hm.setAuxEmphasis('ghost', null);
      // Each leaf fits on its own; together they exceed the summed multi-hover chunk budget.
      hm.maxHoverChunks = leaves[0].chunks.length + 1;
      hm.highlight(leaves[0].root);
      expect(hm.activeChunkProxies).toHaveLength(leaves[0].chunks.length);
      hm.highlightMultiple(leaves.map((l) => l.root));
      expect(hm.activeChunkProxies).toHaveLength(0);
      expect(lastStrategyOf(hm)).toBe('bbox');
      expect(pairsOf(hm, 'hoverPairs')).toHaveLength(leaves.length);
    });

    it('F4: the outline profile keeps the chunk outline above the budget', () => {
      const { hm, om, root, leafChunks } = withHighlighter('planner');
      hm.maxHoverMeshes = 1;
      hm.maxHoverChunks = 1;
      hm.highlight(root);
      expect(new Set(om.channels.hover)).toEqual(new Set(leafChunks));
    });

    it('a released nested instance takes its proxies along', () => {
      const { hm, root, registry, leaves, leafChunks } = withHighlighter('hmi');
      hm.highlightSelection([root]);
      expect(hm.activeChunkProxies).toHaveLength(leafChunks.length);
      registry.release(leaves[2]);
      expect(hm.activeChunkProxies.length).toBe(leafChunks.length - leaves[2].chunks.length);
    });
  });
});
