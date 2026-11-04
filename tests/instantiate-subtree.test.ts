// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.7 — `instantiateSubtree` (F10, D9 — Unity Ctrl+D).
 *
 *  - `fresh`: A, B (B → A) and a reference to OUTSIDE the copy → the copy has new ids,
 *    B' → A', the outside reference unchanged, the source untouched.
 *  - `share`: the ids are shared (an instance of the same file).
 *  - the id map is deterministic: replaying an instantiation with the map an earlier
 *    one returned gives the same ids; through the editor op (`cloneNode`) the ids
 *    survive undo → redo and a REPLAY of the recorded op on a fresh load.
 *
 * The realistic half goes through real GLB bytes (GLTFExporter → `loadGLB` with
 * `preserveHierarchy`, like the asset editor), so the references are FILE references
 * with a decode identity, written in the AUTHORED names while the loader renamed a
 * node (`Pusher` → `Pusher_1`) — the copy's reference must follow in that spelling.
 */
import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { identityIdOf, seededNodeIdOf } from '../src/core/engine/rv-decode-identity';
import { getNodeId, setNodeId } from '../src/core/engine/rv-node-id';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { instantiateSubtree, reidentifySubtree } from '../src/core/engine/rv-subtree-instantiate';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ref = (path: string, componentType = '') => ({ type: 'ComponentReference', path, componentType });

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

function byName(root: Object3D, name: string): Object3D {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  if (!hit) throw new Error(`no node "${name}"`);
  return hit;
}

function idsOf(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => { const id = identityIdOf(n); if (id) out.push(id); });
  return out;
}

const outPath = (n: Object3D, field = 'Out'): string =>
  ((n.userData.realvirtual as Record<string, Record<string, { path: string }>>).RefHolder[field]).path;

// ─── Unit: the helper on a hand-built tree ────────────────────────────────

/**
 *  Asset
 *   ├─ S            (the copied subtree)
 *   │   ├─ A        id-a (authored NodeId)
 *   │   └─ B        id-b, RefHolder.Out → "S/A" (inside), RefHolder.Far → "Outside"
 *   └─ Outside      id-out
 */
function handTree(): { registry: NodeRegistry; model: Group; s: Object3D; a: Object3D; b: Object3D; outside: Object3D } {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const s = child(model, 'S');
  const a = child(s, 'A');
  const b = child(s, 'B', { RefHolder: { Out: ref('S/A'), Far: ref('Outside') } });
  const outside = child(model, 'Outside');
  (model.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'id-asset';
  (s.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'id-s';
  setNodeId(a, 'id-a');
  (b.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'id-b';
  (outside.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'id-out';
  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  registry.registerDocument(model, '');
  return { registry, model, s, a, b, outside };
}

/** Resolve a copied reference the way the legacy reader does (relative to the referrer's scope). */
function legacyTarget(registry: NodeRegistry, referrer: Object3D, path: string): Object3D | null {
  return registry.resolveWithStage({ path }, '', referrer)?.node ?? null;
}

describe('plan-769 9.7 — instantiateSubtree', () => {
  it('fresh: new ids, B\' → A\', the outside reference unchanged, the source untouched', () => {
    const { registry, model, s, a, b, outside } = handTree();
    const sourceBefore = JSON.stringify(b.userData);
    const result = instantiateSubtree(s, {
      ids: 'fresh',
      attach: (copy) => { copy.name = 'S_1'; model.add(copy); },
      resolveTarget: (src, r) => legacyTarget(registry, src, r.path),
      register: (copy) => {
        copy.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
        registry.registerSubtreeIds(copy);
      },
    });
    const copy = result.root;
    const a2 = result.pairs.get(a)!;
    const b2 = result.pairs.get(b)!;

    // Ids: every copied node has a NEW runtime UUIDv4; no authored NodeId is copied.
    const copied = idsOf(copy);
    expect(copied).toHaveLength(3);
    for (const id of copied) expect(id).toMatch(UUID_V4);
    expect(copied.some((id) => ['id-s', 'id-a', 'id-b'].includes(id))).toBe(false);
    expect(new Set(copied).size).toBe(3);
    expect(getNodeId(a2)).toBeNull();
    expect(seededNodeIdOf(a2)).toBe(identityIdOf(a2));
    expect(result.idMap).toEqual({ 'id-s': identityIdOf(copy), 'id-a': identityIdOf(a2), 'id-b': identityIdOf(b2) });

    // References: inside follows the copy, outside stays.
    expect(outPath(b2)).toBe('S_1/A');
    expect(legacyTarget(registry, b2, outPath(b2))).toBe(a2);
    expect(outPath(b2, 'Far')).toBe('Outside');
    expect(legacyTarget(registry, b2, outPath(b2, 'Far'))).toBe(outside);
    expect(result.referencesFollowed).toBe(1);

    // The source is untouched (its ids, its extras, its target).
    expect(JSON.stringify(b.userData)).toBe(sourceBefore);
    expect(getNodeId(a)).toBe('id-a');
    expect(legacyTarget(registry, b, outPath(b))).toBe(a);

    // The index holds both, distinct, and equals the traversal (9.21).
    expect(registry.getAddressForNode(a)).toBe('#id-a');
    expect(registry.getAddressForNode(a2)).toBe(`#${identityIdOf(a2)}`);
    expect(registry.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });
  });

  it('share: the copy keeps the source ids and its references as written', () => {
    const { s, a, b } = handTree();
    const result = instantiateSubtree(s, { ids: 'share' });
    expect(identityIdOf(result.pairs.get(a)!)).toBe('id-a');
    expect(identityIdOf(result.pairs.get(b)!)).toBe('id-b');
    expect(identityIdOf(result.root)).toBe('id-s');
    expect(result.idMap).toEqual({ 'id-s': 'id-s', 'id-a': 'id-a', 'id-b': 'id-b' });
    expect(outPath(result.pairs.get(b)!)).toBe('S/A');
    expect(result.referencesFollowed).toBe(0);
  });

  it('the id map is deterministic: a replay with the recorded map gives the same ids', () => {
    const { s } = handTree();
    const first = instantiateSubtree(s, { ids: 'fresh' });
    const replay = instantiateSubtree(s, { ids: 'fresh', idMap: first.idMap });
    expect(idsOf(replay.root)).toEqual(idsOf(first.root));
    expect(replay.idMap).toEqual(first.idMap);
    // A partial map (a CADLink re-import's matches) is completed, the given entries kept.
    const partial = instantiateSubtree(s, { ids: 'fresh', idMap: { 'id-a': 'kept-a' } });
    expect(partial.idMap['id-a']).toBe('kept-a');
    expect(Object.keys(partial.idMap).sort()).toEqual(['id-a', 'id-b', 'id-s']);
    // In place (an imported CAD tree): keyed by the decode seed, `@<index>` without one.
    const tree = new Group();
    const leaf = child(tree, 'Leaf');
    (leaf.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'seed-leaf';
    const map = reidentifySubtree(tree);
    expect(Object.keys(map).sort()).toEqual(['@0', 'seed-leaf']);
    const again = new Group();
    const leaf2 = child(again, 'Leaf');
    (leaf2.userData as Record<string, unknown>)[RV_SEEDED_NODE_ID_KEY] = 'seed-leaf';
    reidentifySubtree(again, map);
    expect(identityIdOf(leaf2)).toBe(identityIdOf(leaf));
  });
});

// ─── Integration: the editor op on a decoded file ─────────────────────────

/**
 *  Cell                       (glTF scene → model root)
 *   ├─ Pusher                 claims the clean name
 *   ├─ Sep                    ← cloned
 *   │   ├─ Pusher / MC        parent loads as `Pusher_1` (authored `Pusher`)
 *   │   └─ Holder             RefHolder.Out → "Sep/Pusher/MC" (inside, authored spelling)
 *   │                         RefHolder.Far → "Cylinder" (outside)
 *   └─ Cylinder
 */
async function loadFixture(): Promise<{ viewer: RVViewer; registry: NodeRegistry; root: Object3D; scene: Scene }> {
  const src = new Scene();
  src.name = 'Cell';
  child(src, 'Pusher');
  const sep = child(src, 'Sep');
  child(child(sep, 'Pusher'), 'MC');
  child(sep, 'Holder', { RefHolder: { Out: ref('Sep/Pusher/MC'), Far: ref('Cylinder') } });
  child(src, 'Cylinder');
  const data = (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
  const scene = new Scene();
  const result = await loadGLB('instantiate-769.glb', scene, { data, preserveHierarchy: true });
  const root = result.root;
  const registry = result.registry;
  const viewer = {
    scene, registry, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    drives: [],
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined, instancePickIndex: undefined, buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  return { viewer, registry, root, scene };
}

/** What a stored-reference reader gets for `node`'s RefHolder field. */
function readerTarget(registry: NodeRegistry, node: Object3D, field: string): { node: Object3D | null; via: string } {
  const value = (node.userData.realvirtual as Record<string, Record<string, unknown>>).RefHolder[field] as { path: string };
  const r = registry.readStoredRef(node, value);
  if (r.status === 'resolved') return { node: r.node, via: 'file' };
  if (r.status === 'legacy') {
    const hit = registry.resolveWithStage({ path: r.path }, '', node);
    return { node: hit?.node ?? null, via: hit?.stage ?? 'miss' };
  }
  return { node: null, via: r.status };
}

describe('plan-769 9.7 — cloneNode on a decoded file (D9)', () => {
  it('the copy\'s internal reference follows the copy in the authored spelling; the outside one keeps the file verdict', async () => {
    const { viewer, registry, root } = await loadFixture();
    const doc = scratchAssetDocument(viewer);
    const sep = registry.getNode('Cell/Sep')!;
    const mc = byName(sep, 'MC');
    const holder = byName(sep, 'Holder');
    const cylinder = registry.getNode('Cell/Cylinder')!;
    expect(byName(sep, 'MC').parent!.name).toBe('Pusher_1'); // the loader renamed it
    expect(readerTarget(registry, holder, 'Out')).toEqual({ node: mc, via: 'file' });

    const copyPath = await doc.cloneNode('Cell/Sep');
    expect(copyPath).toBe('Cell/Sep_1');
    const copy = registry.getNode(copyPath)!;
    const mc2 = byName(copy, 'MC');
    const holder2 = byName(copy, 'Holder');
    expect(outPath(holder2)).toBe('Sep_1/Pusher/MC');
    const inside = readerTarget(registry, holder2, 'Out');
    expect(inside.node).toBe(mc2);
    expect(['exact', 'alias']).toContain(inside.via); // never a guessing stage
    expect(readerTarget(registry, holder2, 'Far')).toEqual({ node: cylinder, via: 'file' });
    // The source still reads its own target.
    expect(readerTarget(registry, holder, 'Out')).toEqual({ node: mc, via: 'file' });

    // Ids: all new, all indexed, none shared with the source.
    const srcIds = new Set(idsOf(sep));
    expect(idsOf(copy).some((id) => srcIds.has(id))).toBe(false);
    expect(registry.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });

    // Undo → redo: the SAME objects with the SAME ids come back.
    const before = idsOf(copy);
    await doc.undo();
    expect(registry.getNode(copyPath)).toBeNull();
    expect(registry.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });
    await doc.redo();
    expect(registry.getNode(copyPath)).toBe(copy);
    expect(idsOf(copy)).toEqual(before);
    expect(registry.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });

    // Replay: the recorded op (its payload carries the id map) applied on a FRESH
    // load of the same bytes gives the same ids.
    const recorded = JSON.parse(JSON.stringify(doc.document.ops)) as Array<Record<string, unknown>>;
    const cloneOp = recorded.find((o) => o.kind === 'cloneNode')!;
    expect(cloneOp.idMap).toBeTruthy();
    const fresh = await loadFixture();
    const doc2 = scratchAssetDocument(fresh.viewer);
    await doc2.applyOp(cloneOp as never);
    const replayed = fresh.registry.getNode(copyPath)!;
    expect(idsOf(replayed)).toEqual(before);
    expect(outPath(byName(replayed, 'Holder'))).toBe('Sep_1/Pusher/MC');
    doc.dispose();
    doc2.dispose();
    void root;
  });
});
