// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.8 — every op keeps the identity invariants (F5, F10, F11; Phase 2).
 *
 * Parametrised over ALL cases of the asset executor's forward switch
 * (`AssetExecutorContext._forward`, read from the source — a new case without an
 * entry here FAILS) and of the scene executor's forward switch, plus the planner's
 * place / duplicate / paste. Per case:
 *
 *  - after the op, after undo and after redo: no identity twice in the live tree,
 *    and the id index equals the traversal (`auditIdIndex`, 9.21);
 *  - undo restores exactly the identities before the op, redo exactly those after
 *    it (the trash brings the same objects back; a fresh apply reads the op's id map);
 *  - per kind: a created node has a NEW runtime UUIDv4, rename / reparent keep the
 *    id, delete makes a reference by address to it orphan (missing) and undo heals
 *    it, separate / merge keep the replaced node's id on its replacement.
 *
 * Save → Undo → Redo → Save writes identical ids and addresses (Phase 3a: the editor
 * export through the reference writer).
 *
 * Fixture: real GLB bytes through `loadGLB` with `preserveHierarchy` (the asset
 * editor's load), so the nodes carry decode identities.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { assetOpHeader, type CADLinkExtras } from '../src/core/editor/rv-asset-ops';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { applyForward as sceneForward, applyInverse as sceneInverse } from '../src/core/hmi/scene/rv-scene-executors';
import { planCopiedOverrides } from '../src/plugins/layout-planner/scene-mutations';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { visitReferences } from '../src/core/engine/rv-node-path-rewrite.mjs';
import { identities, loadOpIdentityFixture, tri } from './helpers/op-identity-fixture';
import { setupPlanner, internals, flush, TINY_PNG } from './_layout-planner-async-harness';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';
import assetExecutorsSource from '../src/core/editor/rv-asset-executors.ts?raw';
import sceneExecutorsSource from '../src/core/hmi/scene/rv-scene-executors.ts?raw';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLEAN = { unindexed: [], stale: [], wrong: [] };

/** The `case '<kind>'` labels of the switch inside `fnHead … ` (up to the next method). */
function switchCases(source: string, fnHead: string): string[] {
  const at = source.indexOf(fnHead);
  if (at < 0) throw new Error(`"${fnHead}" not found`);
  // The function (or its switch) closes with a brace at indentation ≤ 2.
  const rest = source.slice(at);
  const close = /\r?\n {0,2}\}\r?\n/.exec(rest);
  const body = close ? rest.slice(0, close.index) : rest;
  return [...body.matchAll(/case '(\w+)'/g)].map((m) => m[1]!);
}

// ─── fixture (tests/helpers/op-identity-fixture.ts) ───────────────────────

const loadFixture = loadOpIdentityFixture;

type FileJson = {
  scene?: number;
  scenes?: Array<{ nodes?: number[]; extras?: { realvirtual?: Record<string, unknown> } }>;
  nodes?: Array<{ name?: string; children?: number[]; extras?: { realvirtual?: Record<string, unknown> } }>;
};

/**
 * What a written file says about identity (plan-769 9.8 Save→Undo→Redo→Save): every
 * node's name path → NodeId, every stored reference position → its stored value.
 */
function fileFacts(json: FileJson): { ids: Array<[string, unknown]>; refs: Array<[string, unknown]> } {
  const ids: Array<[string, unknown]> = [];
  const refs: Array<[string, unknown]> = [];
  const s = json.scenes![json.scene ?? 0]!;
  ids.push(['', s.extras?.realvirtual?.NodeId]);
  const visit = (i: number, prefix: string): void => {
    const n = json.nodes![i]!;
    const p = prefix ? `${prefix}/${n.name ?? ''}` : (n.name ?? '');
    ids.push([p, n.extras?.realvirtual?.NodeId]);
    visitReferences(n.extras?.realvirtual, (r) => {
      if (r.kind !== 'name') refs.push([`${p}:${r.componentKey}.${r.field}`, r.value]);
    });
    for (const c of n.children ?? []) visit(c, p);
  };
  for (const r of s.nodes ?? []) visit(r, '');
  return { ids, refs };
}

function expectHealthy(registry: NodeRegistry, root: Object3D): void {
  const ids = [...identities(root).values()];
  expect(ids.length - new Set(ids).size, 'an identity appears twice in the live tree').toBe(0);
  expect(registry.auditIdIndex()).toEqual(CLEAN);
}

function expectSame(a: Map<Object3D, string>, b: Map<Object3D, string>): void {
  expect([...a.entries()].map(([n, id]) => [n.uuid, id]).sort())
    .toEqual([...b.entries()].map(([n, id]) => [n.uuid, id]).sort());
}

function at(registry: NodeRegistry, path: string): Object3D {
  const n = registry.getNode(path);
  if (!n) throw new Error(`no node at "${path}"`);
  return n;
}

const MATERIAL = { name: 'Red', color: '#ff0000', metalness: 0, roughness: 0.5, opacity: 1, transparent: false };

interface Ctx { registry: NodeRegistry; root: Object3D; doc: AssetDocument }

/** One asset-executor case: run the op (through the document), then case-specific checks. */
interface AssetCase {
  run(ctx: Ctx): Promise<void | ((ctx: Ctx) => void)>;
}

async function cadGlb(): Promise<ArrayBuffer> {
  const part = new Group();
  part.name = 'Part';
  const body = new Mesh(tri(2), new MeshStandardMaterial());
  body.name = 'Body';
  part.add(body);
  return objectToGlb(part);
}
const CADLINK: CADLinkExtras = { File: 'part.step', Sha256: 'sha-769-part', Quality: 'source', ImportScaleFactor: 0.001, ZIsUpVector: false };

const ASSET_CASES: Record<string, AssetCase> = {
  importCad: {
    async run({ doc, registry }) {
      const glb = await cadGlb();
      // One undo step for both (the generic undo/redo check below).
      let a = '';
      let b = '';
      await doc.withTransaction('Import twice', async () => {
        a = await doc.importCad({ glb, cadlink: { ...CADLINK } } as never);
        b = await doc.importCad({ glb, cadlink: { ...CADLINK } } as never);
      });
      expect(a).not.toBe(b);
      return () => {
        if (!registry.getNode(a)) return; // undone
        // The same file imported twice: two subtrees, no id shared (fresh, keyed by the seed).
        const ia = [...identities(at(registry, a)).values()];
        const ib = [...identities(at(registry, b)).values()];
        expect(ia.length).toBeGreaterThan(0);
        expect(ia.some((id) => ib.includes(id))).toBe(false);
        for (const id of [...ia, ...ib]) expect(id).toMatch(UUID_V4);
      };
    },
  },
  transformNode: {
    async run({ doc, registry }) {
      const n = at(registry, 'Cell/Cylinder');
      const id = identityIdOf(n);
      const prev = { position: n.position.toArray(), quaternion: n.quaternion.toArray(), scale: n.scale.toArray() } as never;
      doc.transformNode('Cell/Cylinder', { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, prev);
      await doc.whenIdle();
      return () => expect(identityIdOf(n)).toBe(id);
    },
  },
  renameNode: {
    async run({ doc, registry }) {
      const n = at(registry, 'Cell/Cylinder');
      const id = identityIdOf(n)!;
      const address = registry.getAddressForNode(n);
      await doc.renameNodeAwaited('Cell/Cylinder', 'Roller');
      return ({ registry: r }) => {
        if (r.getNode('Cell/Roller')) {
          expect(identityIdOf(r.getNode('Cell/Roller')!)).toBe(id);
          expect(r.getAddressForNode(n)).toBe(address);
          const res = r.resolveRef(at(r, 'Cell/Sep/Holder'), { address: `#${id}` });
          expect(res.status === 'resolved' && res.node).toBe(n);
        }
      };
    },
  },
  deleteNode: {
    async run({ doc, registry }) {
      const n = at(registry, 'Cell/Cylinder');
      const id = identityIdOf(n)!;
      const holder = at(registry, 'Cell/Sep/Holder');
      expect(registry.resolveRef(holder, { address: `#${id}` }).status).toBe('resolved');
      doc.deleteNode('Cell/Cylinder');
      await doc.whenIdle();
      return ({ registry: r }) => {
        const res = r.resolveRef(holder, { address: `#${id}` });
        if (r.getNode('Cell/Cylinder')) {
          expect(res.status === 'resolved' && res.node).toBe(n); // undone / redone back
        } else {
          expect(res).toMatchObject({ status: 'unresolved', reason: 'missing' }); // orphan, visible
        }
      };
    },
  },
  setNodeVisible: {
    async run({ doc }) { doc.setNodeVisible('Cell/Cylinder', false); await doc.whenIdle(); },
  },
  createNode: {
    async run({ doc, registry }) {
      const path = await doc.createEmptyNode(null, 'Empty');
      const n = at(registry, path);
      const id = identityIdOf(n)!;
      expect(id).toMatch(UUID_V4);
      expect(registry.getAddressForNode(n)).toBe(`#${id}`);
      return ({ registry: r }) => {
        const live = r.getNode(path);
        if (live) expect(identityIdOf(live)).toBe(id);
      };
    },
  },
  reparentNode: {
    async run({ doc, registry }) {
      const n = at(registry, 'Cell/Cylinder');
      const id = identityIdOf(n);
      const address = registry.getAddressForNode(n);
      await doc.reparentNodes(['Cell/Cylinder'], 'Cell/Sep');
      expect(registry.getNode('Cell/Sep/Cylinder')).toBe(n);
      return () => { expect(identityIdOf(n)).toBe(id); expect(registry.getAddressForNode(n)).toBe(address); };
    },
  },
  addComponent: {
    async run({ doc }) { doc.addComponent('Cell/Cylinder', 'Sensor', { Length: 100 }); await doc.whenIdle(); },
  },
  removeComponent: {
    async run({ doc }) { doc.removeComponent('Cell/Sep/Holder', 'RefHolder'); await doc.whenIdle(); },
  },
  setField: {
    async run({ doc }) { doc.setField('Cell/Cylinder', 'Sensor', 'Length', 5, undefined); await doc.whenIdle(); },
  },
  unsetField: {
    async run({ doc, registry }) {
      const prev = (at(registry, 'Cell/Sep/Holder').userData.realvirtual as Record<string, Record<string, unknown>>).RefHolder.Out;
      doc.unsetField('Cell/Sep/Holder', 'RefHolder', 'Out', prev);
      await doc.whenIdle();
    },
  },
  setMaterial: {
    async run({ doc }) { doc.setMaterial(['Cell/Islands'], MATERIAL); await doc.whenIdle(); },
  },
  separateMesh: {
    async run({ doc, registry }) {
      const source = at(registry, 'Cell/Islands');
      const id = identityIdOf(source)!;
      const names = await doc.separateMesh('Cell/Islands', 'islands');
      expect(names).toHaveLength(2);
      const group = at(registry, 'Cell/Islands');
      expect(group).not.toBe(source);
      expect(identityIdOf(group)).toBe(id); // the replacement keeps the node's identity
      const parts = names.map((name) => at(registry, `Cell/Islands/${name}`));
      const partIds = parts.map((p) => identityIdOf(p)!);
      for (const pid of partIds) expect(pid).toMatch(UUID_V4);
      return ({ registry: r }) => {
        const live = r.getNode('Cell/Islands')!;
        expect(identityIdOf(live)).toBe(id);
        if (live === group) expect(names.map((name) => identityIdOf(at(r, `Cell/Islands/${name}`)))).toEqual(partIds);
      };
    },
  },
  mergeMesh: {
    async run({ doc, registry }) {
      const asm = at(registry, 'Cell/Asm');
      const id = identityIdOf(asm)!;
      const plan = await doc.mergeMesh('Cell/Asm');
      expect(plan).not.toBeNull();
      const merged = at(registry, 'Cell/Asm');
      expect(merged).not.toBe(asm);
      expect(identityIdOf(merged)).toBe(id); // the root output replaces the root
      const outputs = merged.children.filter((c) => (c as Mesh).isMesh);
      for (const o of outputs) expect(identityIdOf(o)).toMatch(UUID_V4);
      return ({ registry: r }) => expect(identityIdOf(r.getNode('Cell/Asm')!)).toBe(id);
    },
  },
  replaceNodeGeometry: {
    async run({ doc, registry }) {
      const mesh = at(registry, 'Cell/Asm/M1') as Mesh;
      const id = identityIdOf(mesh);
      const header = assetOpHeader();
      doc.executor.provideGeometryPayload(header.id, tri(9));
      await doc.applyOp({
        ...header, kind: 'replaceNodeGeometry', nodePath: 'Cell/Asm/M1',
        sha256: 'sha-new', quality: 'source', converter: 'browser', prevSha256: 'sha-old',
      } as never);
      return () => expect(identityIdOf(mesh)).toBe(id); // no node is created: the id stays
    },
  },
  cloneNode: {
    async run({ doc, registry }) {
      const path = await doc.cloneNode('Cell/Sep');
      const copy = at(registry, path);
      const srcIds = new Set(identities(at(registry, 'Cell/Sep')).values());
      expect([...identities(copy).values()].some((id) => srcIds.has(id))).toBe(false);
      const op = doc.ops[doc.ops.length - 1] as unknown as { kind: string; idMap?: Record<string, string> };
      expect(op.kind).toBe('cloneNode');
      expect(Object.keys(op.idMap ?? {})).toHaveLength(identities(copy).size);
    },
  },
};

describe('plan-769 9.8 — op identity invariants (asset lineage)', () => {
  const cases = switchCases(assetExecutorsSource, 'private async _forward(op: RvAssetPrimitiveOp)');

  it('the case table covers EVERY case of the executor switch (a new case needs an entry)', () => {
    expect(cases.length).toBeGreaterThan(10);
    expect(Object.keys(ASSET_CASES).sort()).toEqual([...cases].sort());
  });

  for (const kind of cases) {
    it(`${kind}: no duplicate id, index == traversal, undo/redo symmetric`, async () => {
      const entry = ASSET_CASES[kind];
      expect(entry, `no 9.8 entry for executor case "${kind}"`).toBeTruthy();
      const ctx = await loadFixture();
      const { registry, root, doc } = ctx;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expectHealthy(registry, root);
      const before = identities(root);
      const check = await entry!.run(ctx);
      await doc.whenIdle();
      expectHealthy(registry, root);
      check?.(ctx);
      const after = identities(root);

      await doc.undo();
      expectHealthy(registry, root);
      expectSame(identities(root), before);
      check?.(ctx);

      await doc.redo();
      expectHealthy(registry, root);
      expectSame(identities(root), after);
      check?.(ctx);
      doc.dispose();
    });
  }

  it('[Phase 3a] Save → Undo → Redo → Save writes identical ids and addresses', async () => {
    const ctx = await loadFixture();
    const { registry, root, doc } = ctx;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const copyPath = await doc.cloneNode('Cell/Sep');
    await doc.createEmptyNode(null, 'Empty');
    await doc.renameNodeAwaited('Cell/Cylinder', 'Roller');
    await doc.whenIdle();
    const save = async () => fileFacts(readGlbJson(await exportAssetGlb(root, 'Cell', undefined, undefined, { registry })) as FileJson);
    const first = await save();
    // Every node an id, no path in a reference position (F8 save side).
    expect(first.ids.every(([, id]) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(first.refs.filter(([, v]) => typeof v === 'string' || (v as { path?: unknown }).path !== undefined)).toEqual([]);
    // The copy's reference follows the copy (D9), by address.
    const copyName = copyPath.split('/').pop()!;
    const copyMc = first.ids.find(([p]) => p === `${copyName}/Pusher/MC`)![1];
    const copyRef = first.refs.find(([p]) => p.startsWith(`${copyName}/Holder:`))![1] as { address?: string };
    expect(copyRef.address).toBe(`#${copyMc}`);

    for (let i = 0; i < 3; i++) await doc.undo();
    for (let i = 0; i < 3; i++) await doc.redo();
    expectHealthy(registry, root);
    expect(await save()).toEqual(first);
    doc.dispose();
  });
});

// ─── scene lineage ────────────────────────────────────────────────────────

/** Scene executor cases that create or delete NO node — named, with the reason. */
const SCENE_NO_NODE: Record<string, string> = {
  setField: 'writes extras of an existing node',
  unsetField: 'writes extras of an existing node',
  transformPlacement: 'moves a placement root',
  transformNode: 'moves an existing node',
  setCamera: 'camera start pose, no node',
  setCode: 'WebComponent code field of an existing node',
  addConnection: 'connection registry, no node',
  removeConnection: 'connection registry, no node',
  setConnectionType: 'connection registry, no node',
  removeConnectionType: 'connection registry, no node',
  addPlacement: 'planner placement — the planner section below',
  removePlacement: 'planner placement — the planner section below',
};
const SCENE_NODE_CASES = ['addNode', 'removeNode'];

describe('plan-769 9.8 — op identity invariants (scene lineage)', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  it('the table covers EVERY case of the scene executor switch', () => {
    const cases = switchCases(sceneExecutorsSource, 'async function applyPrimitiveForward(');
    expect([...Object.keys(SCENE_NO_NODE), ...SCENE_NODE_CASES].sort()).toEqual([...cases].sort());
  });

  it('addNode / removeNode: a new id from the op, undo/redo/re-create keep it, index == traversal', async () => {
    h = await createTestViewer('webgl');
    const base = new Group();
    base.name = 'Plant';
    const holder = new Object3D();
    holder.name = 'Holder';
    base.add(holder);
    const box = new Mesh(tri(0), new MeshStandardMaterial());
    box.name = 'Box';
    base.add(box);
    await h.viewer.loadModel('scene-769.glb', { data: await objectToGlb(base) });
    const reg = h.viewer.registry!;
    const ctx = { viewer: h.viewer };
    expect(reg.auditIdIndex()).toEqual(CLEAN);
    const rootPath = reg.getPathForNode(h.viewer.currentModelRoot!)!;
    const nodePath = `${rootPath}/Waypoint`;
    const spec = { parentPath: rootPath, name: 'Waypoint', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {} };
    const add = { id: 'op-add', ts: 0, schemaV: 1, kind: 'addNode', nodePath, spec } as Record<string, unknown>;
    await sceneForward(add as never, ctx);
    const created = reg.getNode(nodePath)!;
    const id = identityIdOf(created)!;
    expect(id).toMatch(UUID_V4);
    expect((add.idMap as Record<string, string>).node).toBe(id); // written back onto the op
    expect(reg.auditIdIndex()).toEqual(CLEAN);
    await sceneInverse(add as never, ctx);
    expect(reg.getNode(nodePath)).toBeNull();
    expect(reg.auditIdIndex()).toEqual(CLEAN);
    await sceneForward(add as never, ctx); // redo / replay: the id from the payload
    expect(identityIdOf(reg.getNode(nodePath)!)).toBe(id);
    // removeNode records the identity it removes; its undo re-creates THAT node.
    const remove = { id: 'op-rm', ts: 0, schemaV: 1, kind: 'removeNode', nodePath, spec } as Record<string, unknown>;
    await sceneForward(remove as never, ctx);
    expect(reg.getNode(nodePath)).toBeNull();
    expect((remove.idMap as Record<string, string>).node).toBe(id);
    await sceneInverse(remove as never, ctx);
    expect(identityIdOf(reg.getNode(nodePath)!)).toBe(id);
    expect(reg.auditIdIndex()).toEqual(CLEAN);
  });
});

// ─── planner place / duplicate / paste ────────────────────────────────────

const BELT: LibraryCatalogEntry = {
  id: 'cat:769-belt', name: 'Belt', category: 'conveyor',
  glbUrl: 'https://rv-test.invalid/plan769-belt.glb', thumbnailUrl: TINY_PNG, footprintMm: [1200, 400],
};

describe('plan-769 9.8 — planner place / duplicate / paste', () => {
  afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem('rv-layout-autosave'); });

  it('a placement\'s identity is its record id: new for a duplicate and a paste, kept by a re-place from the record', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0])]), { status: 200 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { plugin, viewer } = setupPlanner();
    plugin.store.addCatalogDirect('test://plan769', { version: '1.0', name: 'plan769', entries: [BELT] });
    await internals(plugin)._catalogsLoaded;
    await flush();
    const v = viewer as unknown as { currentModel: Object3D; registry: NodeRegistry };
    setNodeId(v.currentModel, 'nid-layout');
    v.registry.registerDocument(v.currentModel, '');

    const a = await plugin.placeComponent(BELT, [0, 0, 0]);
    plugin.store.selectComponent(a);
    const b = (await plugin.duplicateSelected())!;
    plugin.copySelected();
    const [c] = await plugin.pasteClipboard();
    await flush();
    const roots = [a, b, c!].map((id) => internals(plugin)._objectMap.get(id)!);
    // Identity = record id, all distinct, each the occurrence of its own content.
    expect(roots.map((r) => identityIdOf(r))).toEqual([a, b, c]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(v.registry.getRegisteredOccurrences().sort()).toEqual(['', a, b, c].sort());
    for (const [i, r] of roots.entries()) expect(v.registry.getAddressForNode(r)).toBe(`#${[a, b, c][i]}`);
    expect(v.registry.auditIdIndex()).toEqual(CLEAN);

    // Undo of a removal re-places FROM THE RECORD (`removePlacementInverse`): same identity.
    const record = plugin.store.getSnapshot().placed.find((p) => p.id === b)!;
    plugin.removePlacementById(b);
    expect(v.registry.getRegisteredOccurrences()).not.toContain(b);
    expect(v.registry.auditIdIndex()).toEqual(CLEAN);
    await plugin.placeFromRecord({ ...record });
    await flush();
    const back = internals(plugin)._objectMap.get(b)!;
    expect(identityIdOf(back)).toBe(b);
    expect(v.registry.auditIdIndex()).toEqual(CLEAN);
  });

  it('a copy inherits the source\'s overrides; a reference into the source placement follows the copy', () => {
    const copyRoot = new Group();
    const sensor = new Object3D();
    sensor.name = 'Sensor';
    sensor.userData.realvirtual = { Sensor: { Length: 10 } };
    copyRoot.add(sensor);
    const nodes: Record<string, Object3D> = { 'Layout/Belt_1': copyRoot, 'Layout/Belt_1/Sensor': sensor };
    const edits = planCopiedOverrides({
      'Layout/Belt/Sensor': {
        Sensor: { Length: 42, Target: { type: 'ComponentReference', path: 'Layout/Belt/Motor', componentType: 'Drive' } as never },
        Lamp: { Signal: { type: 'ComponentReference', path: 'Layout/Other/Out', componentType: '' } as never, Gone: null as never },
      },
      'Layout/Other/X': { Sensor: { Length: 1 } },
      'Layout/Belt/Missing': { Sensor: { Length: 3 } },
    }, 'Layout/Belt', 'Layout/Belt_1', (p) => nodes[p] ?? null);
    expect(edits).toEqual([
      { kind: 'setField', nodePath: 'Layout/Belt_1/Sensor', componentType: 'Sensor', fieldName: 'Length', value: 42, prev: 10 },
      {
        kind: 'setField', nodePath: 'Layout/Belt_1/Sensor', componentType: 'Sensor', fieldName: 'Target',
        value: { type: 'ComponentReference', path: 'Layout/Belt_1/Motor', componentType: 'Drive' }, prev: undefined,
      },
      {
        kind: 'setField', nodePath: 'Layout/Belt_1/Sensor', componentType: 'Lamp', fieldName: 'Signal',
        value: { type: 'ComponentReference', path: 'Layout/Other/Out', componentType: '' }, prev: undefined,
      },
    ]);
  });
});
