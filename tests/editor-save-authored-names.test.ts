// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-765 — the write side of the naming contract: an editor save writes the
 * AUTHORED node names back, and a rename owns the authored-name stamp.
 *
 * GLTFLoader sanitizes and de-duplicates node names file-wide; the loader keeps
 * the authored name of a real dedup in `userData._rvOrigName` and aliases it
 * (plan-734), while every stored `ComponentReference` stays in the authored
 * spelling. Before plan-765 the export wrote the loader's `NL6501_1` names and
 * dropped the stamp, so the saved file could no longer resolve its own
 * references (Mauser: 46 → 2446 unresolved after one save).
 *
 * The fixture goes through real GLB bytes (GLTFExporter → `loadGLB`), because
 * the dedup this is about happens inside GLTFLoader — a hand-stamped tree would
 * not prove the loader and the export agree. Loads use `preserveHierarchy` like
 * the asset editor (no bake), so every node of the file is in the tree.
 */
import { executeValue } from './helpers/execute-value';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { Group, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { auditReferences, countWrittenReferences } from '../src/core/engine/rv-reference-audit';
import { exportAssetGlb, exportPrunePredicate, restoreAuthoredNames } from '../src/core/editor/rv-asset-glb-export';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  ambiguousReason, assetRelativePath, authoredAssetRelativePath, authoredPathIsAmbiguous, listReferenceCandidates,
} from '../src/core/hmi/rv-reference-field';
import {
  clearAllProblems, DEDUP_SUFFIX_HINT, getProblems, reportReferenceAudit, saveReferenceLossProblemId,
} from '../src/core/hmi/problems-store';
import { saveDocument } from '../src/core/editor/rv-save-document';
import { documentBase, setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';

// ─── save fixture (9.8 / 9.10) ────────────────────────────────────────────
// The save path with the REAL export (the save-routing suites mock it; the guard
// measures inside the export's clone callback, so it needs the real one). Only
// the project store (a fake writable backend, active only while a save test sets
// it) and the thumbnail renderer (no GPU here) are replaced.

const h = vi.hoisted(() => ({ backend: null as null | Record<string, unknown> }));

vi.mock('../src/core/project/project-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/project/project-store')>();
  return {
    ...actual,
    getProjectStore: () => (h.backend
      ? { getBackend: () => h.backend, getProject: () => ({ id: 'prj_765' }) }
      : actual.getProjectStore()),
  };
});
// plan-776: the save reaches the renderer only through the thumbnail writer —
// one shared stand-in for it (tests/helpers/mock-thumbnail-write.ts).
vi.mock('../src/core/thumbnails/rv-thumbnail-write', async () =>
  (await import('./helpers/mock-thumbnail-write')).mockThumbnailWriteModule());

const writes: Array<{ path: string; bytes: Uint8Array }> = [];
const fakeBackend = {
  kind: 'browser' as const,
  id: 'fake-765',
  writable: true,
  isActive: true,
  async writeDocument(r: string | { path: string }, bytes: Uint8Array) {
    writes.push({ path: typeof r === 'string' ? r : r.path, bytes });
    return { revision: `rev-${writes.length}` };
  },
  async readDocument() { return null; },
  async readDocumentUrl() { return null; },
  async listDocuments() { return []; },
};

// ─── helpers ──────────────────────────────────────────────────────────────

async function toGlb(src: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
}

/** Export the authored scene to GLB bytes and load them back the way the asset editor does. */
async function roundtrip(src: Scene): Promise<{ registry: NodeRegistry; scene: Scene; root: Object3D }> {
  return load(await toGlb(src));
}

async function load(data: ArrayBuffer): Promise<{ registry: NodeRegistry; scene: Scene; root: Object3D }> {
  const scene = new Scene();
  const result = await loadGLB('authored-names.glb', scene, { data, preserveHierarchy: true });
  return { registry: result.registry, scene, root: result.root };
}

interface GlbJson {
  nodes: Array<{ name?: string; children?: number[]; extras?: Record<string, unknown> }>;
  scenes: Array<{ name?: string; nodes?: number[]; extras?: Record<string, unknown> }>;
}

/** The JSON chunk of a binary GLB (12-byte header, then chunk length + type). */
function readGlbJson(buf: ArrayBuffer): GlbJson {
  const view = new DataView(buf);
  const len = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len))) as GlbJson;
}

/** The loaded model root (the glTF scene the loader added to `scene`). */
const assetRoot = (scene: Scene): Object3D => scene.children[0];

const origOrName = (n: Object3D): string => (n.userData._rvOrigName as string | undefined) ?? n.name;

const writtenNames = (json: GlbJson): string[] => json.nodes.map((n) => n.name ?? '');

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

const ref = (path: string, componentType = 'RuntimeUIWindow') => ({ type: 'ComponentReference', path, componentType });

/**
 * Cell                                            (glTF scene → model root)
 *  ├─ Gripper_rv2 / NL6:501   RuntimeMetadata.window → "Gripper_rv2/NL6:501"
 *  ├─ Gripper_rv3 / NL6:501   RuntimeMetadata.window → "Gripper_rv3/NL6:501"
 *  │      (sanitized + deduplicated: loads as `NL6501_1`, stamped `NL6:501`)
 *  ├─ Pusher                  (claims the clean name)
 *  ├─ Sep
 *  │   ├─ Pin, Pin            true sibling duplicates (second loads as `Pin_1`)
 *  │   └─ Pusher / MC01.03Q01B  (parent loads as `Pusher_1`, stamped `Pusher`)
 *  └─ Cylinder                RefHolder.Out → "Sep/Pusher/MC01.03Q01B"
 *
 * `Gripper_rv2` / `_rv3` are Unity's AmbiguousReferenceNameFixer suffixes — part
 * of the authored name, never mistaken for a Three.js `_N`.
 */
function buildDedupFixture(): Scene {
  const scene = new Scene();
  scene.name = 'Cell';
  for (const g of ['Gripper_rv2', 'Gripper_rv3']) {
    child(child(scene, g), 'NL6:501', { RuntimeMetadata: { window: ref(`${g}/NL6:501`) } });
  }
  child(scene, 'Pusher');
  const sep = child(scene, 'Sep');
  child(sep, 'Pin');
  child(sep, 'Pin');
  child(child(sep, 'Pusher'), 'MC01.03Q01B');
  child(scene, 'Cylinder', { RefHolder: { Out: ref('Sep/Pusher/MC01.03Q01B', '') } });
  return scene;
}

function findNode(root: Object3D, pred: (n: Object3D) => boolean): Object3D {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && pred(n)) found = n; });
  if (!found) throw new Error('node not found');
  return found;
}

/** A renderer-free asset-editor viewer over a LOADED tree (pattern of `spike-610-ref-fixture.ts`). */
function editorViewer(scene: Scene, root: Object3D, registry: NodeRegistry): RVViewer {
  return {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return root; },
    drives: [],
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    getPlugin: () => undefined,
    instancePickIndex: undefined,
    buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
}

/** Every `renameNode` primitive of the log (composites flattened). */
function renameOps(ops: readonly unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (op: Record<string, unknown>): void => {
    if (op.kind === 'renameNode') out.push(op);
    if (op.kind === 'composite') for (const c of op.ops as Array<Record<string, unknown>>) visit(c);
  };
  for (const op of JSON.parse(JSON.stringify(ops)) as Array<Record<string, unknown>>) visit(op);
  return out;
}

const windowPath = (node: Object3D): string =>
  ((node.userData.realvirtual as Record<string, Record<string, { path: string }>>).RuntimeMetadata.window).path;

// ─── 9.1 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.1 — round trip keeps names and references', () => {
  it('writes authored names and keeps every reference resolvable after reload', async () => {
    const { scene: s1, registry: r1 } = await roundtrip(buildDedupFixture());
    const root = assetRoot(s1);

    // The loader really deduplicated: the premise of everything below.
    const stamped: string[] = [];
    root.traverse((n) => { if (typeof n.userData._rvOrigName === 'string') stamped.push(`${n.name}<-${origOrName(n)}`); });
    expect(stamped).toEqual(expect.arrayContaining(['NL6501_1<-NL6:501', 'Pin_1<-Pin', 'Pusher_1<-Pusher']));
    expect(auditReferences(r1).counts.unresolved).toBe(0);

    const glb = await exportAssetGlb(root, 'Cell');
    const json = readGlbJson(glb);
    expect(json.nodes.filter((n) => /_\d+$/.test(n.name ?? ''))).toHaveLength(0);
    expect(writtenNames(json).filter((n) => n === 'NL6:501')).toHaveLength(2);
    expect(writtenNames(json).filter((n) => n === 'Pin')).toHaveLength(2);
    expect(writtenNames(json).filter((n) => n === 'Pusher')).toHaveLength(2);
    expect(writtenNames(json)).toEqual(expect.arrayContaining(['Gripper_rv2', 'Gripper_rv3', 'MC01.03Q01B']));

    // The export is read-only on the live tree: names and stamps unchanged.
    expect(stamped).toEqual(((): string[] => {
      const again: string[] = [];
      root.traverse((n) => { if (typeof n.userData._rvOrigName === 'string') again.push(`${n.name}<-${origOrName(n)}`); });
      return again;
    })());

    // The guard's own counter agrees: same counts in authored spelling before and after.
    const before = countWrittenReferences(root, origOrName, exportPrunePredicate);
    expect(before).toEqual({ references: 3, unresolved: 0, byField: {}, ambiguousPaths: 1 }); // `Sep/Pin`
    const { registry: r2, scene: s2 } = await load(glb);
    // plan-769 Phase 3a: the reloaded file stores ADDRESSES — none of them lives in the
    // name space this guard measures (same names, no path left to lose).
    expect(countWrittenReferences(assetRoot(s2), origOrName, exportPrunePredicate))
      .toEqual({ ...before, references: 0 });
    const audit = auditReferences(r2);
    expect(audit.counts.references).toBe(3);
    expect(audit.counts.unresolved).toBe(0);
    const first = r2.getNode('Cell/Gripper_rv2/NL6:501');
    const second = r2.getNode('Cell/Gripper_rv3/NL6:501');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(second!.parent!.name).toBe('Gripper_rv3');
    // …and the stored self-reference of the second node lands on IT.
    const hit = r2.resolveWithStage({ path: 'Gripper_rv3/NL6:501' }, '', second);
    expect(hit?.node).toBe(second);
  });

  it('without the stamps (the pre-plan-765 export) the same file loses references', async () => {
    // Control: proves the fixture exercises the bug the restore fixes.
    const { scene } = await roundtrip(buildDedupFixture());
    const root = assetRoot(scene);
    root.traverse((n) => { delete n.userData._rvOrigName; });
    const glb = await exportAssetGlb(root, 'Cell');
    expect(writtenNames(readGlbJson(glb))).toContain('NL6501_1');
    const { registry } = await load(glb);
    // The second gripper's self-reference no longer lands on its own node: it is
    // either lost or "rescued" by name onto the TWIN under Gripper_rv2.
    const own = findNode(registry.getNode('Cell/Gripper_rv3')!, (n) => n.name.startsWith('NL6'));
    const hit = registry.resolveWithStage({ path: 'Gripper_rv3/NL6:501' }, '', own);
    expect(hit?.node).not.toBe(own);
  });

  it('exportPrunePredicate is false for every authored node of the fixture', async () => {
    const { scene } = await roundtrip(buildDedupFixture());
    const root = assetRoot(scene);
    const dropped: string[] = [];
    root.traverse((n) => { if (n !== root && exportPrunePredicate(n)) dropped.push(n.name); });
    expect(dropped).toEqual([]);
  });
});

// ─── 9.2 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.2 — a pure sanitization is not a stamp', () => {
  it('loads restored in place, carries no stamp and exports unchanged', async () => {
    const src = new Scene();
    src.name = 'Cell';
    child(src, 'MC04.01I00W');
    const { scene } = await roundtrip(src);
    const root = assetRoot(scene);
    const node = findNode(root, (n) => n.name === 'MC04.01I00W');
    expect(node.userData._rvOrigName).toBeUndefined();

    const names: string[] = [];
    root.traverse((n) => names.push(n.name));
    restoreAuthoredNames(root);
    const after: string[] = [];
    root.traverse((n) => after.push(n.name));
    expect(after).toEqual(names);

    expect(writtenNames(readGlbJson(await exportAssetGlb(root, 'Cell')))).toContain('MC04.01I00W');
  });

  it('restoreAuthoredNames ignores empty stamps and synthetic nodes', () => {
    const root = new Object3D();
    const a = child(root, 'A_1');
    a.userData._rvOrigName = 'A';
    const empty = child(root, 'B_1');
    empty.userData._rvOrigName = '';
    const synthetic = child(root, 'P_1');
    synthetic.userData._rvOrigName = 'P';
    synthetic.userData._rvSynthetic = true;
    restoreAuthoredNames(root);
    expect([a.name, empty.name, synthetic.name]).toEqual(['A', 'B_1', 'P_1']);
  });
});

// ─── 9.3 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.3 — a rename owns the stamp', () => {
  it('rename clears the stamp, undo restores it, redo clears it again; the save follows the user', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const node = registry.getNode('Cell/Gripper_rv3/NL6501_1')!;
    expect(node.userData._rvOrigName).toBe('NL6:501');

    await doc.renameNodeAwaited('Cell/Gripper_rv3/NL6501_1', 'Clamp');
    expect(node.name).toBe('Clamp');
    expect(node.userData._rvOrigName).toBeUndefined();
    const [op] = renameOps(doc.ops);
    expect(op).toMatchObject({ kind: 'renameNode', nodePath: 'Cell/Gripper_rv3/NL6501_1', name: 'Clamp', prevName: 'NL6501_1', prevOrigName: 'NL6:501' });
    let names = writtenNames(readGlbJson(await exportAssetGlb(root, 'Cell')));
    expect(names).toContain('Clamp');
    expect(names.filter((n) => n === 'NL6:501')).toHaveLength(1);

    await doc.undo();
    expect(node.name).toBe('NL6501_1');
    expect(node.userData._rvOrigName).toBe('NL6:501');
    names = writtenNames(readGlbJson(await exportAssetGlb(root, 'Cell')));
    expect(names).not.toContain('Clamp');
    expect(names.filter((n) => n === 'NL6:501')).toHaveLength(2);

    await doc.redo();
    expect(node.name).toBe('Clamp');
    expect(node.userData._rvOrigName).toBeUndefined();
    doc.dispose();
  });

  it('a rename of a node WITHOUT a stamp records no prevOrigName key', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    await doc.renameNodeAwaited('Cell/Pusher', 'Ram');
    const [op] = renameOps(doc.ops);
    expect(op).toMatchObject({ kind: 'renameNode', name: 'Ram', prevName: 'Pusher' });
    expect('prevOrigName' in op).toBe(false);
    await doc.undo();
    expect(registry.getNode('Cell/Pusher')!.userData._rvOrigName).toBeUndefined();
    doc.dispose();
  });

  for (const via of ['reparentNodes', 'reparentNodesBatch'] as const) {
    it(`the auto-rename of a move (${via}) carries prevOrigName and its undo restores the stamp`, async () => {
      const { scene, registry, root } = await roundtrip(buildDedupFixture());
      // A same-named child under the target forces the collision auto-rename.
      const target = registry.getNode('Cell/Gripper_rv2')!;
      const blocker = child(target, 'NL6501_1');
      registry.registerNode('Cell/Gripper_rv2/NL6501_1', blocker);
      const node = registry.getNode('Cell/Gripper_rv3/NL6501_1')!;
      const doc = scratchAssetDocument(editorViewer(scene, root, registry));

      await doc[via](['Cell/Gripper_rv3/NL6501_1'], 'Cell/Gripper_rv2');
      expect(node.parent).toBe(target);
      expect(node.name).not.toBe('NL6501_1');
      expect(node.userData._rvOrigName).toBeUndefined();
      const [op] = renameOps(doc.ops);
      expect(op).toMatchObject({ prevName: 'NL6501_1', prevOrigName: 'NL6:501' });

      await doc.undo();
      expect(node.parent!.name).toBe('Gripper_rv3');
      expect(node.name).toBe('NL6501_1');
      expect(node.userData._rvOrigName).toBe('NL6:501');
      doc.dispose();
    });
  }
});

// ─── 9.4 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.4 — a rename rewrites references stored in authored names (F2b)', () => {
  it('renaming the parent of a stamped node rewrites its authored self-reference in one undo step', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const leaf = registry.getNode('Cell/Gripper_rv3/NL6501_1')!;

    const result = await doc.renameNodeAwaited('Cell/Gripper_rv3', 'GripperB');
    expect(result.referencesRewritten).toBe(1);
    expect(windowPath(leaf)).toBe('GripperB/NL6:501');
    expect(doc.ops).toHaveLength(1);

    const { registry: r2 } = await load(await exportAssetGlb(root, 'Cell'));
    expect(auditReferences(r2).counts.unresolved).toBe(0);
    const reloaded = r2.getNode('Cell/GripperB/NL6:501');
    expect(reloaded).not.toBeNull();
    expect(r2.resolveWithStage({ path: 'GripperB/NL6:501' }, '', reloaded)?.node).toBe(reloaded);

    await doc.undo();
    expect(windowPath(leaf)).toBe('Gripper_rv3/NL6:501');
    doc.dispose();
  });

  it('renaming the stamped leaf itself rewrites its authored self-reference', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const leaf = registry.getNode('Cell/Gripper_rv3/NL6501_1')!;

    await doc.renameNodeAwaited('Cell/Gripper_rv3/NL6501_1', 'Clamp');
    expect(windowPath(leaf)).toBe('Gripper_rv3/Clamp');
    // The untouched twin keeps its reference.
    expect(windowPath(registry.getNode('Cell/Gripper_rv2/NL6:501')!)).toBe('Gripper_rv2/NL6:501');

    const { registry: r2 } = await load(await exportAssetGlb(root, 'Cell'));
    expect(auditReferences(r2).counts.unresolved).toBe(0);
    doc.dispose();
  });

  it('renaming a STAMPED ancestor rewrites a reference that passes through its authored name', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const cylinder = registry.getNode('Cell/Cylinder')!;
    const outOf = () => ((cylinder.userData.realvirtual as Record<string, Record<string, { path: string }>>).RefHolder.Out).path;
    expect(registry.getNode('Cell/Sep/Pusher_1')!.userData._rvOrigName).toBe('Pusher');

    await doc.renameNodeAwaited('Cell/Sep/Pusher_1', 'Ram');
    expect(outOf()).toBe('Sep/Ram/MC01.03Q01B');
    // The real `Pusher` beside it is a different node and keeps its name.
    expect(registry.getNode('Cell/Pusher')).not.toBeNull();

    const { registry: r2 } = await load(await exportAssetGlb(root, 'Cell'));
    expect(auditReferences(r2).counts.unresolved).toBe(0);

    await doc.undo();
    expect(outOf()).toBe('Sep/Pusher/MC01.03Q01B');
    doc.dispose();
  });
});

// ─── 9.5 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.5 — stamped root', () => {
  it('writes the authored root name, still lifts the root extras, and keeps the same-named child', async () => {
    const src = new Scene();
    src.name = 'Cell';
    src.userData.realvirtual = { RuntimeMetadata: { annotation: 'root' } };
    const inner = child(src, 'Cell');
    child(inner, 'Part');
    const { scene } = await roundtrip(src);
    const root = assetRoot(scene);

    // One of the two `Cell`s was deduplicated by the loader.
    const cells: Object3D[] = [];
    root.traverse((n) => { if (origOrName(n) === 'Cell') cells.push(n); });
    expect(cells).toHaveLength(2);
    expect(cells.some((n) => n.userData._rvOrigName === 'Cell')).toBe(true);

    const json = readGlbJson(await exportAssetGlb(root));
    expect(json.scenes[0].name).toBe('Cell');
    expect((json.scenes[0].extras as Record<string, unknown> | undefined)?.realvirtual).toBeDefined();
    // The restored child name is content, not a wrapper: it is still written.
    expect(writtenNames(json)).toContain('Cell');
    expect(writtenNames(json)).toContain('Part');
    expect(json.nodes.filter((n) => /_\d+$/.test(n.name ?? ''))).toHaveLength(0);
  });
});

// ─── 9.6 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.6 — one writer spells authored names', () => {
  it('authoredAssetRelativePath spells the stamp, assetRelativePath keeps the loader name', async () => {
    const { registry, root } = await roundtrip(buildDedupFixture());
    const leaf = registry.getNode('Cell/Gripper_rv3/NL6501_1')!;
    expect(authoredAssetRelativePath(leaf, root)).toBe('Gripper_rv3/NL6:501');
    expect(assetRelativePath(leaf, root)).toBe('Gripper_rv3/NL6501_1');
    const deep = registry.getNode('Cell/Sep/Pusher_1/MC01.03Q01B')!;
    expect(authoredAssetRelativePath(deep, root)).toBe('Sep/Pusher/MC01.03Q01B');
    expect(authoredAssetRelativePath(root, root)).toBeNull();
    expect(authoredAssetRelativePath(new Object3D(), root)).toBeNull();
  });

  it('listReferenceCandidates offers authored paths, one per node, with no ambiguous key', async () => {
    const { registry, root } = await roundtrip(buildDedupFixture());
    const list = listReferenceCandidates(
      (cb) => registry.forEachNode(cb), { kind: 'component', componentType: 'RuntimeMetadata' }, root,
    );
    expect(list).toEqual([
      { path: 'Gripper_rv2/NL6:501', componentType: 'RuntimeMetadata', label: 'NL6:501' },
      { path: 'Gripper_rv3/NL6:501', componentType: 'RuntimeMetadata', label: 'NL6:501' },
    ]);
    for (const c of list) expect('ambiguous' in c || 'nodeCount' in c).toBe(false);
  });

  it('a reference setField is re-spelled when it pins one node, else written as given', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const cylinder = registry.getNode('Cell/Cylinder')!;
    const field = (): { path: string } | undefined =>
      (cylinder.userData.realvirtual as Record<string, Record<string, { path: string }> | undefined>).LogicStep_WaitForSensor?.Sensor;
    // plan-769 Phase 3b: a reference that pins one node is stored as its ADDRESS; the
    // ones that do not (ambiguous, missing) stay as given — the path the author sent.
    const stored = () => field()?.path ?? (field() as { address?: string } | undefined)?.address;
    const prev = () => (field() ? JSON.parse(JSON.stringify(field())) : undefined);
    const addressOf = (p: string) => `#${identityIdOf(registry.getNode(p)!)}`;

    // Current-name spelling of a deduplicated node → that node's address.
    await doc.setFieldAwaited('Cell/Cylinder', 'LogicStep_WaitForSensor', 'Sensor', ref('Gripper_rv3/NL6501_1', ''), prev());
    expect(stored()).toBe(addressOf('Cell/Gripper_rv3/NL6501_1'));
    // The op keeps what the author sent; replay re-spells deterministically.
    const last = JSON.parse(JSON.stringify(doc.ops.at(-1))) as { value: { path: string } };
    expect(last.value.path).toBe('Gripper_rv3/NL6501_1');

    // Its authored path `Sep/Pin` names two siblings — no PATH could pin it, but the
    // current name does, exactly: stored as THAT node's address (an id is never ambiguous).
    await doc.setFieldAwaited('Cell/Cylinder', 'LogicStep_WaitForSensor', 'Sensor', ref('Sep/Pin_1', ''), prev());
    expect(stored()).toBe(addressOf('Cell/Sep/Pin_1'));

    // Resolves to no node → as given (the reference audit reports it).
    await doc.setFieldAwaited('Cell/Cylinder', 'LogicStep_WaitForSensor', 'Sensor', ref('Nowhere/Missing', ''), prev());
    expect(stored()).toBe('Nowhere/Missing');

    // A field that is not reference-typed in the schema is not RE-SPELLED — but a
    // ComponentReference anywhere is a reference: it is stored as the address it pins.
    await doc.setFieldAwaited('Cell/Cylinder', 'RefHolder', 'Out', ref('Gripper_rv3/NL6501_1', ''), undefined);
    expect(((cylinder.userData.realvirtual as Record<string, Record<string, { address?: string }>>).RefHolder.Out).address)
      .toBe(addressOf('Cell/Gripper_rv3/NL6501_1'));
    doc.dispose();
  });
});

describe('plan-765 9.6 — undo of a re-spelled setField', () => {
  it('writes the previous value verbatim, never re-spelled', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const cylinder = registry.getNode('Cell/Cylinder')!;
    // An old file's reference in the loader's `_N` spelling, as the document carries it.
    const old = ref('Gripper_rv3/NL6501_1', '');
    (cylinder.userData.realvirtual as Record<string, unknown>).LogicStep_WaitForSensor = { Sensor: old };
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const stored = () => {
      const v = (cylinder.userData.realvirtual as Record<string, Record<string, { path?: string; address?: string }>>).LogicStep_WaitForSensor.Sensor;
      return v.path ?? v.address;
    };
    // plan-769 Phase 3b: the new value is stored as its target's address.
    const twin = `#${identityIdOf(registry.getNode('Cell/Gripper_rv2/NL6:501')!)}`;

    await doc.setFieldAwaited('Cell/Cylinder', 'LogicStep_WaitForSensor', 'Sensor', ref('Gripper_rv2/NL6:501', ''), { ...old });
    expect(stored()).toBe(twin);
    await doc.undo();
    expect(stored()).toBe('Gripper_rv3/NL6501_1');
    await doc.redo();
    expect(stored()).toBe(twin);
    doc.dispose();
  });
});

// ─── 9.7 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.7 — a sibling duplicate is refused', () => {
  it('Sep/Pin appears once, ambiguous, with the node count', async () => {
    const { registry, root } = await roundtrip(buildDedupFixture());
    const pins = [registry.getNode('Cell/Sep/Pin')!, registry.getNode('Cell/Sep/Pin_1')!];
    expect(pins[1].userData._rvOrigName).toBe('Pin');
    for (const p of pins) p.userData.realvirtual = { Sensor: {} };
    const target = { kind: 'component', componentType: 'Sensor' } as const;
    expect(listReferenceCandidates((cb) => registry.forEachNode(cb), target, root)).toEqual([
      { path: 'Sep/Pin', componentType: 'Sensor', label: 'Pin', ambiguous: true, nodeCount: 2 },
    ]);
    expect(authoredPathIsAmbiguous(pins[0], root)).toBe(true);

    // A twin WITHOUT the component still makes the path unaddressable.
    delete pins[1].userData.realvirtual;
    expect(listReferenceCandidates((cb) => registry.forEachNode(cb), target, root)).toEqual([
      { path: 'Sep/Pin', componentType: 'Sensor', label: 'Pin', ambiguous: true, nodeCount: 2 },
    ]);
    expect(ambiguousReason({ path: 'Sep/Pin', nodeCount: 2 }))
      .toBe('Sep/Pin: 2 siblings share this name — not addressable by path; rename one in the source');
  });
});

// ─── 9.8 ──────────────────────────────────────────────────────────────────

/**
 * A save context over a REAL tree: the document is the stub shape of
 * `document-save-in-place.test.ts` (dirty, unbound, a `document` base with a
 * path), the viewer hands out the tree — so `saveDocument` runs its real
 * asset branch with the real `exportAssetGlb`.
 */
function saveContext(root: Object3D, documentId: string) {
  const base = documentBase(documentId, 'Cell', `models/${documentId}.glb`);
  const doc = {
    name: 'Cell',
    base,
    dirty: true,
    renameDocument(n: string) { this.name = n; },
    whenIdle: async () => {},
    lockOwner: null,
    tryLock: () => ({ kind: 'save', token: Symbol('stub'), generation: 1 }),
    unlock: () => {},
    markSaved: async () => {},
    get isBound() { return false; },
    document: { opCount: 0, runExclusive: <T,>(work: () => Promise<T>) => work(), markSaved: () => {} },
  };
  const viewer = {
    currentModelRoot: root, renderer: {}, scene: {}, emit: () => {}, getPlugin: () => undefined,
  };
  return { viewer: viewer as never, doc: doc as never };
}

type SavedWithRefs = { kind: 'saved'; references?: { before: number; after: number; byField: Record<string, number> } };

const lossProblems = () => getProblems().filter((p) => p.code === 'save-reference-loss');

const bufferOf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

describe('plan-765 9.8 — the save guard reports the delta, clears it, never blocks', () => {
  beforeEach(() => { clearAllProblems(); writes.length = 0; h.backend = fakeBackend; });
  afterEach(() => { h.backend = null; clearAllProblems(); });

  it('a save that writes loader names reports the loss; the next clean save clears it', async () => {
    const { scene } = await roundtrip(buildDedupFixture());
    const root = assetRoot(scene);
    // The pre-plan-765 export, reproduced without patching a module: a node
    // flagged synthetic keeps its stamp but `restoreAuthoredNames` skips it, so
    // the file gets the loader's `NL6501_1` / `Pusher_1` while the live tree —
    // and every reference — still speaks the authored names. (Deleting the
    // stamps, the plan's first idea, cannot show a delta: both counts are taken
    // at save time, so the live side would lose the authored names as well.)
    const stamped: Object3D[] = [];
    root.traverse((n) => { if (typeof n.userData._rvOrigName === 'string') stamped.push(n); });
    expect(stamped.length).toBeGreaterThanOrEqual(3);
    for (const n of stamped) n.userData._rvSynthetic = true;

    const { viewer, doc } = saveContext(root, 'doc_cell_765');
    const lossy = await saveDocument(viewer, doc) as SavedWithRefs;
    expect(lossy.kind).toBe('saved');
    expect(writes.map((w) => w.path)).toEqual(['models/doc_cell_765.glb']); // never blocked
    expect(writtenNames(readGlbJson(bufferOf(writes[0].bytes)))).toContain('NL6501_1');
    expect(lossy.references).toBeDefined();
    const { before, after, byField } = lossy.references!;
    expect(before).toBe(0);
    expect(after - before).toBeGreaterThan(0);
    expect(byField).toEqual({ 'RuntimeMetadata.window': 1, 'RefHolder.Out': 1 });
    const [problem] = lossProblems();
    expect(problem).toMatchObject({
      id: saveReferenceLossProblemId('doc_cell_765'),
      severity: 'warning',
      title: `Save left ${after - before} reference(s) unresolved`,
    });
    expect(problem.detail).toContain('RuntimeMetadata.window 1');

    // The same document, untouched: delta 0, and the previous entry is gone.
    for (const n of stamped) delete n.userData._rvSynthetic;
    const clean = await saveDocument(viewer, doc) as SavedWithRefs;
    expect(clean.kind).toBe('saved');
    expect(clean.references).toEqual({ before: 0, after: 0, byField: {} });
    expect(lossProblems()).toEqual([]);
    expect(writes).toHaveLength(2);
  });

  it('a composed reference child is pruned on BOTH sides — delta 0', async () => {
    // Pattern of asset-export-keeps-references.test.ts: the composed content
    // under a reference node is session-only and never written.
    const root = new Group();
    root.name = 'Cell';
    // Into the composed content: unresolved in the file AND in the pruned live view.
    child(root, 'Frame', { RefHolder: { Out: ref('GripperRef/GripperContent/Finger', '') } });
    const referenceNode = child(root, 'GripperRef');
    setAssetReference(referenceNode, { assetId: 'gripper-asset-id', path: 'library/gripper.glb', sha256: 'deadbeef' });
    const content = child(referenceNode, 'GripperContent');
    // A reference INSIDE the composed content: not file content, counted by neither side.
    child(content, 'Finger', { RuntimeMetadata: { window: ref('Nowhere/AtAll') } });

    const { viewer, doc } = saveContext(root, 'doc_composed_765');
    const result = await saveDocument(viewer, doc) as SavedWithRefs;
    expect(result.kind).toBe('saved');
    expect(result.references).toEqual({ before: 1, after: 1, byField: {} });
    expect(lossProblems()).toEqual([]);
    expect(writtenNames(readGlbJson(bufferOf(writes[0].bytes)))).not.toContain('Finger');
  });
});

// ─── 9.9 ──────────────────────────────────────────────────────────────────

describe('plan-765 9.9 — the dedup hint on files saved by an old editor', () => {
  beforeEach(() => { clearAllProblems(); });
  afterEach(() => { clearAllProblems(); });

  it('an unresolved reference with a `<written>_N` node carries the hint', async () => {
    // What the pre-plan-765 editor wrote: loader names in the file, authored names in the references.
    const src = new Scene();
    src.name = 'Cell';
    for (const [g, leaf] of [['Gripper_rv2', 'NL6501'], ['Gripper_rv3', 'NL6501_1']] as const) {
      child(child(src, g), leaf, { RuntimeMetadata: { window: ref(`${g}/NL6:501`) } });
    }
    child(src, 'Box_1', { RuntimeMetadata: { window: ref('Box') } });
    const { registry } = await roundtrip(src);
    const audit = auditReferences(registry);
    reportReferenceAudit(audit.findings);

    const lost = audit.findings.filter((f) => f.kind === 'unresolved');
    const byPath = new Map(lost.map((f) => [f.writtenPath, f]));
    expect(byPath.get('Gripper_rv3/NL6:501')?.dedupSuffixExists).toBe(true);
    expect(byPath.get('Box')?.dedupSuffixExists).toBe(true);
    const unresolved = getProblems().filter((p) => p.code === 'reference-unresolved');
    expect(unresolved.length).toBe(lost.length);
    // plan-769 Phase 1b: `Gripper_rv2/NL6:501` matched the file's `NL6501` only through
    // the SANITIZED stage — a guess, so it was `rescued`; as a reference the file carries
    // it is unresolved now (visible), and it has no `_N` twin, so no hint.
    expect(byPath.get('Gripper_rv2/NL6:501')?.dedupSuffixExists).toBeUndefined();
    const hinted = unresolved.filter((p) => !p.detail?.includes('Gripper_rv2/NL6:501"'));
    expect(hinted.length).toBe(2);
    for (const p of hinted) expect(p.detail).toContain('saved by an editor before plan-765');
    expect(hinted[0].detail).toContain(DEDUP_SUFFIX_HINT);
  });

  it('a plain unresolved reference carries no hint', async () => {
    const src = new Scene();
    src.name = 'Cell';
    child(src, 'Holder', { RuntimeMetadata: { window: ref('Missing') } });
    const { registry } = await roundtrip(src);
    const audit = auditReferences(registry);
    expect(audit.findings).toHaveLength(1);
    expect('dedupSuffixExists' in audit.findings[0]).toBe(false);
    reportReferenceAudit(audit.findings);
    const [p] = getProblems().filter((e) => e.code === 'reference-unresolved');
    expect(p.detail).not.toContain('plan-765');
  });

  it('`_N` names WITHOUT references yield no problem and no hint', async () => {
    const src = new Scene();
    src.name = 'Cell';
    child(src, 'NL6501');
    child(src, 'NL6501_1');
    child(child(src, 'Sep'), 'Pin_2');
    const { registry } = await roundtrip(src);
    const audit = auditReferences(registry);
    expect(audit.findings).toEqual([]);
    reportReferenceAudit(audit.findings);
    expect(getProblems()).toEqual([]);
  });
});

// ─── 9.10 ─────────────────────────────────────────────────────────────────

/** The editor viewer of 9.3, plus what the MCP command layer reads (pattern of mcp-editor-doc-mutations). */
function mcpViewer(scene: Scene, root: Object3D, registry: NodeRegistry): RVViewer {
  const v = editorViewer(scene, root, registry) as unknown as Record<string, unknown>;
  let activeMode = 'editor';
  v.modes = {
    get activeMode() { return activeMode; },
    has: () => true,
    setMode: (m: string) => { activeMode = m; },
    list: () => [{ id: 'planner' }, { id: 'hmi' }, { id: 'editor' }],
    subscribe: () => () => {},
  };
  v.selectionManager = {
    select() {}, selectPaths() {}, clear() {},
    getSnapshot: () => ({ selectedPaths: [] as string[] }),
  };
  v.renderer = {};
  return v as unknown as RVViewer;
}

describe('plan-765 9.10 — MCP surface', () => {
  beforeEach(() => { clearAllProblems(); writes.length = 0; h.backend = fakeBackend; });
  afterEach(() => { h.backend = null; setActiveAssetContext(null); clearAllProblems(); });

  it('web_editor_set_field stores the authored spelling; web_editor_save reports references', async () => {
    const { scene, registry, root } = await roundtrip(buildDedupFixture());
    const cylinder = registry.getNode('Cell/Cylinder')!;
    // The tool sets a field of an EXISTING component (it refuses an absent one).
    (cylinder.userData.realvirtual as Record<string, unknown>).LogicStep_WaitForSensor = { Sensor: ref('Pusher', '') };
    const viewer = mcpViewer(scene, root, registry);
    const doc = scratchAssetDocument(viewer, 'Cell');
    setActiveAssetContext({ viewer, doc });
    const tools = new McpEditorTools(() => viewer);

    // ONE edit on the field (consecutive setFields on one field merge into one undo entry).
    const set = JSON.parse(await executeValue(viewer, 'editor.setField', { path: 'Cell/Cylinder', componentType: 'LogicStep_WaitForSensor', fieldName: 'Sensor', valueJson: JSON.stringify(ref('Gripper_rv3/NL6501_1', '')) })) as Record<string, unknown>;
    // The private command's read-back (setFieldImpl) accepts the re-spelled
    // reference (same node, deterministic stage) and reports the written spelling.
    expect(set.error, JSON.stringify(set)).toBeUndefined();
    expect(set.ok).toBe(true);
    expect((set.value as { path: string }).path).toBe('Gripper_rv3/NL6501_1');
    // plan-769 Phase 3b: stored as the pinned node's ADDRESS.
    const pinned = `#${identityIdOf(registry.getNode('Cell/Gripper_rv3/NL6501_1')!)}`;
    expect((set.storedAs as { address: string }).address).toBe(pinned);
    const stored = (cylinder.userData.realvirtual as Record<string, Record<string, { address?: string }>>)
      .LogicStep_WaitForSensor.Sensor.address;
    expect(stored).toBe(pinned);

    const saved = JSON.parse(await tools.webEditorSave('')) as Record<string, unknown>;
    expect(saved.error, JSON.stringify(saved)).toBeUndefined();
    expect(saved.saved).toBe(true);
    expect(saved.references).toEqual({ before: 0, after: 0, byField: {} });
    expect(writes).toHaveLength(1);
    doc.dispose();
  });
});
