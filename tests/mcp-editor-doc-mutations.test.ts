// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.8 — the MCP bridge's document surface, all 18 methods.
 *
 * The MCP editor tools are the largest EXTERNAL contract on `AssetDocument`:
 * agents call them, their names and result shapes are an API. Before this file
 * no test drove a single mutation through them — the existing "net" checked tool
 * names and UI feedback, which is a different question entirely (Test-Finding
 * F2). A facade change could therefore break every authoring tool in the bridge
 * and stay green.
 *
 * The inventory is the real one, taken with the §2.5 command:
 *
 *   grep -oE "\.doc\.[a-zA-Z]+\(" src/plugins/mcp-bridge/rv-mcp-editor-tools.ts \
 *     | sort -u | wc -l   →  18
 *
 * Every row below drives the REAL {@link McpEditorTools} against a real
 * `AssetDocument` over a real `NodeRegistry` and three `Scene`. What is pinned
 * per row: a MUTATION lands in the op log and is undoable, and a READ answers in
 * the new shape.
 *
 * ONE row is marked `viaDoc`: `importCad` is only reachable through the tool
 * after a project file has been read out of a live project backend, which is a
 * different subsystem's fixture. Its tool-side guard IS driven here (proving the
 * ctx wiring and that a refused import records nothing); the mutation contract
 * is then pinned on the document method the tool calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import {
  sceneDocumentBase,
  setActiveAssetContext,
} from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../src/core/ops/rv-unified-executors';

// ─── Fixture ────────────────────────────────────────────────────────────

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  tools: McpEditorTools;
  root: Group;
  boxPath: string;
  meshPath: string;
}

function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);

  const box = new Object3D();
  box.name = 'Box';
  root.add(box);

  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x336699 }));
  mesh.name = 'Panel';
  root.add(mesh);

  const registry = new NodeRegistry();
  const register = () =>
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  register();

  let activeMode = 'editor';
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return root; },
    modes: {
      get activeMode() { return activeMode; },
      has: () => true,
      setMode: (m: string) => { activeMode = m; },
      list: () => [{ id: 'planner' }, { id: 'hmi' }, { id: 'editor' }],
      subscribe: () => () => {},
    },
    selectionManager: {
      select() {}, selectPaths() {}, clear() {},
      getSnapshot: () => ({ selectedPaths: [] as string[] }),
    },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const doc = AssetDocument.newUntitled(viewer);
  setActiveAssetContext({ viewer, doc });
  const tools = new McpEditorTools(() => viewer);

  return {
    viewer, doc, tools, root,
    boxPath: NodeRegistry.computeNodePath(box),
    meshPath: NodeRegistry.computeNodePath(mesh),
  };
}

/** Parse a tool result and fail loudly on the uniform error shape. */
function ok(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed['error'], `tool returned an error: ${json}`).toBeUndefined();
  return parsed;
}

let env: Env;

beforeEach(async () => {
  await __clearDraftStoresForTests();
  env = makeEnv();
});

afterEach(() => {
  setActiveAssetContext(null);
  env.doc.dispose();
});

// ─── Mutations: every one lands in the log and comes back out ───────────

interface MutationRow {
  /** The `AssetDocument` method this row covers. */
  method: string;
  /**
   * Bring the document to the state the row's method needs — a component to
   * remove, a field to unset. Runs BEFORE the op count is captured, so the
   * uniform "undo takes the effect back" assertion stays meaningful for the
   * methods whose effect is a REMOVAL.
   */
  setup?: (e: Env) => Promise<void>;
  /** Drive the REAL tool. Returns nothing — assertions are uniform. */
  run: (e: Env) => Promise<void>;
  /** Ops the run is expected to add to the log (composites count as one). */
  ops?: number;
  /** What must be true after the run, and false again after undo. */
  effect: (e: Env) => boolean;
}

const MUTATIONS: MutationRow[] = [
  {
    method: 'addComponent',
    run: async (e) => { ok(await e.tools.webEditorAddComponent(e.boxPath, 'Drive', '')); },
    effect: (e) => 'Drive' in rvOf(e.viewer, e.boxPath),
  },
  {
    method: 'removeComponent',
    setup: async (e) => { ok(await e.tools.webEditorAddComponent(e.boxPath, 'Drive', '')); },
    run: async (e) => { ok(await e.tools.webEditorRemoveComponent(e.boxPath, 'Drive')); },
    effect: (e) => !('Drive' in rvOf(e.viewer, e.boxPath)),
  },
  {
    method: 'setField',
    setup: async (e) => { ok(await e.tools.webEditorAddComponent(e.boxPath, 'Drive', '')); },
    run: async (e) => { ok(await e.tools.webEditorSetField(e.boxPath, 'Drive', 'TargetSpeed', '777')); },
    effect: (e) => driveField(e, 'TargetSpeed') === 777,
  },
  {
    method: 'unsetField',
    setup: async (e) => {
      ok(await e.tools.webEditorAddComponent(e.boxPath, 'Drive', '{"TargetSpeed":123}'));
    },
    run: async (e) => {
      // No dedicated tool: the bridge reaches `unsetField` through the mechanism
      // jog path, which needs a live drive-drag driver. The document call that
      // path makes is exactly this one.
      e.doc.unsetField(e.boxPath, 'Drive', 'TargetSpeed', 123);
      await e.doc.whenIdle();
    },
    effect: (e) => driveField(e, 'TargetSpeed') === undefined,
  },
  {
    method: 'renameNode',
    run: async (e) => { ok(await e.tools.webEditorRename(e.boxPath, 'Crate')); },
    effect: (e) => !!e.root.children.find((c) => c.name === 'Crate'),
  },
  {
    method: 'transformNode',
    run: async (e) => { ok(await e.tools.webEditorTransform(e.boxPath, 1, 2, 3, NaN, NaN, NaN, NaN, NaN, NaN)); },
    effect: (e) => node(e, e.boxPath)?.position.x === 1,
  },
  {
    method: 'setNodeVisible',
    run: async (e) => { ok(await e.tools.webEditorSetVisible(e.boxPath, false)); },
    effect: (e) => node(e, e.boxPath)?.visible === false,
  },
  {
    method: 'deleteNodes',
    run: async (e) => { ok(await e.tools.webEditorDelete(e.boxPath)); },
    effect: (e) => !e.root.children.some((c) => c.name === 'Box'),
  },
  {
    method: 'createEmptyNode',
    run: async (e) => { ok(await e.tools.webEditorCreateEmpty('', 'Rig')); },
    effect: (e) => e.root.children.some((c) => c.name === 'Rig'),
  },
  {
    method: 'reparentNodes',
    run: async (e) => {
      ok(await e.tools.webEditorCreateEmpty('', 'Rig'));
      ok(await e.tools.webEditorReparent(e.boxPath, 'Asset/Rig'));
    },
    ops: 2,
    effect: (e) => !!node(e, 'Asset/Rig')?.children.some((c) => c.name === 'Box'),
  },
  {
    method: 'setMaterial + withTransaction',
    run: async (e) => {
      const res = ok(await e.tools.webEditorMaterialize(
        JSON.stringify([{ samplePath: e.meshPath, color: '#ff0000' }]),
      ));
      expect((res['applied'] as unknown[]).length).toBe(1);
    },
    // ONE op: the tool wraps every assignment in a single transaction, which is
    // the whole point of its "One web_editor_undo reverts all" promise.
    ops: 1,
    effect: (e) => materialHex(e, e.meshPath) === 0xff0000,
  },
];

describe('MCP editor tools — every mutation is recorded and undoable', () => {
  for (const row of MUTATIONS) {
    it(`${row.method}: lands in the op log and undo takes it back`, async () => {
      await row.setup?.(env);
      await env.doc.whenIdle();
      const before = env.doc.getSnapshot().opCount;
      const effectBefore = row.effect(env);
      await row.run(env);
      await env.doc.whenIdle();

      const after = env.doc.getSnapshot();
      expect(after.opCount - before).toBe(row.ops ?? 1);
      expect(after.dirty).toBe(true);
      expect(after.canUndo).toBe(true);
      // The run CHANGED something — whichever direction the effect runs in.
      expect(row.effect(env)).toBe(!effectBefore);

      // Undo through the REAL tool, all the way back.
      const undone = ok(await env.tools.webEditorUndo(row.ops ?? 1));
      expect(undone['undone']).toBe(row.ops ?? 1);
      await env.doc.whenIdle();
      expect(env.doc.getSnapshot().opCount).toBe(before);
      expect(row.effect(env)).toBe(effectBefore);
    });
  }
});

// ─── undo / redo / whenIdle / getSnapshot ───────────────────────────────

describe('MCP editor tools — undo, redo, whenIdle, getSnapshot', () => {
  it('undo and redo report the document core back in the new shape', async () => {
    ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));

    const undone = ok(await env.tools.webEditorUndo(1));
    expect(undone).toMatchObject({ undone: 1, canUndo: false, canRedo: true });

    const redone = ok(await env.tools.webEditorRedo(1));
    expect(redone).toMatchObject({ redone: 1, canUndo: true, canRedo: false });
    expect('Drive' in rvOf(env.viewer, env.boxPath)).toBe(true);
  });

  it('undo stops at the floor instead of over-reporting', async () => {
    const undone = ok(await env.tools.webEditorUndo(5));
    expect(undone).toMatchObject({ undone: 0, canUndo: false });
  });

  it('whenIdle is awaited before a tool answers — the result never describes pending work', async () => {
    // `webEditorSetField` awaits `doc.whenIdle()` before serialising its result.
    // If that await were dropped, the value below would still be the old one at
    // the moment the caller reads the JSON.
    ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));
    const res = ok(await env.tools.webEditorSetField(env.boxPath, 'Drive', 'TargetSpeed', '55'));
    expect(res['value']).toBe(55);
    expect(driveField(env, 'TargetSpeed')).toBe(55);
    expect(env.doc.getSnapshot().busy).toBe(false);
  });

  it('getSnapshot: project info reports dirty and opCount off the document core', async () => {
    const clean = ok(await env.tools.webEditorProjectInfo());
    expect(clean).toMatchObject({ assetName: 'Untitled', dirty: false, opCount: 0 });

    ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));
    const dirty = ok(await env.tools.webEditorProjectInfo());
    expect(dirty).toMatchObject({ dirty: true, opCount: 1 });
  });
});

// ─── plan-711 §9.8 — the agent at a BOUND document ──────────────────────

describe('MCP editor tools at a bound (shared) document', () => {
  /**
   * The editor projection of a document the scene still owns.
   *
   * Built the way the binder builds it — `adopt` — because that is the whole
   * question here: an MCP mutation must reach the SHARED log rather than a
   * second one, or an agent's work would vanish at the mode switch while every
   * tool answer said it had landed.
   */
  function bindShared() {
    const shared = new RvDocument({
      id: 'scene_doc', name: 'Line 7', mode: 'scene',
      executor: new RvUnifiedExecutor(env.viewer, 'scene'),
    });
    const bound = new AssetDocument(env.viewer, {
      id: 'asset_bound', name: 'Line 7',
      base: sceneDocumentBase('scene_7', 'Line 7'),
      adopt: shared,
    });
    setActiveAssetContext({ viewer: env.viewer, doc: bound });
    return { shared, bound };
  }

  it('a mutation lands in the SHARED log and is still there after the way back', async () => {
    const { shared, bound } = bindShared();
    try {
      ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));

      // The op is in the document the scene is holding — one log, not two.
      expect(shared.opCount).toBe(1);
      expect(shared.ops[0].kind).toBe('addComponent');
      expect(shared.dirty).toBe(true);
      // And nothing was recorded anywhere else: the facade has no log of its own.
      expect(bound.document).toBe(shared);

      // The way back: the projection returns to the scene, the log does not move.
      shared.setProjection('scene');
      expect(shared.opCount).toBe(1);
      expect(shared.dirty).toBe(true);
      expect('Drive' in rvOf(env.viewer, env.boxPath)).toBe(true);

      // …and the scene can take it back, which is what "one undo stack" means:
      // the agent's op is an ordinary entry of the scene's own history.
      await shared.undo();
      expect('Drive' in rvOf(env.viewer, env.boxPath)).toBe(false);
      expect(shared.opCount).toBe(0);
    } finally {
      bound.dispose();
      shared.dispose();
    }
  });

  it('the agent’s undo tool moves the SAME stack the scene reads', async () => {
    const { shared, bound } = bindShared();
    try {
      ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));
      ok(await env.tools.webEditorSetField(env.boxPath, 'Drive', 'TargetSpeed', '55'));
      expect(shared.opCount).toBe(2);

      const undone = ok(await env.tools.webEditorUndo(1));
      expect(undone).toMatchObject({ undone: 1 });
      expect(shared.opCount).toBe(1);
      expect(shared.canRedo()).toBe(true);
    } finally {
      bound.dispose();
      shared.dispose();
    }
  });

  it('project info reports the shared document’s state, not an empty one', async () => {
    const { shared, bound } = bindShared();
    try {
      // Work done from the SCENE side before the binding is what the agent must
      // see: same instance, so the same op count and the same dirty flag.
      await shared.applyOp({
        id: 'op_scene_pre', ts: 1, schemaV: 1, kind: 'setField',
        nodePath: env.boxPath, componentType: 'Drive', fieldName: 'TargetSpeed',
        value: 5, prev: 0,
      } as never);
      const info = ok(await env.tools.webEditorProjectInfo());
      expect(info).toMatchObject({ dirty: true, opCount: 1 });
    } finally {
      bound.dispose();
      shared.dispose();
    }
  });
});

// ─── markSaved ──────────────────────────────────────────────────────────

describe('MCP editor tools — markSaved', () => {
  it('closing with ifDirty=discard re-bases the document and clears its draft', async () => {
    ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));
    expect(env.doc.dirty).toBe(true);

    const res = ok(await env.tools.webEditorClose('discard', ''));
    expect(res['closed']).toBe(true);
    // `markSaved` is what makes this true: the log is re-based, so the editor's
    // own deactivate path does not re-flush a draft for work the agent dropped.
    expect(env.doc.dirty).toBe(false);
  });

  it('refuses to close a dirty document without a policy — and changes nothing', async () => {
    ok(await env.tools.webEditorAddComponent(env.boxPath, 'Drive', ''));
    const res = JSON.parse(await env.tools.webEditorClose('', '')) as Record<string, unknown>;
    expect(res['error']).toContain('Unsaved changes');
    expect(env.doc.dirty).toBe(true);
    expect(env.doc.getSnapshot().opCount).toBe(1);
  });
});

// ─── importCad (viaDoc — see the file header) ───────────────────────────

describe('MCP editor tools — importCad', () => {
  it('the tool refuses without a CAD provider, and records nothing', async () => {
    const raw = await env.tools.webEditorImportCad('library/imports/x.step', '');
    const res = JSON.parse(raw) as Record<string, unknown>;
    expect(String(res['error'])).toMatch(/CAD provider|project/i);
    expect(env.doc.getSnapshot().opCount).toBe(0);
    expect(env.doc.dirty).toBe(false);
  });

  it('the document call the tool makes records ONE undoable op', async () => {
    const cadRoot = new Group();
    cadRoot.name = 'Gearbox';
    const rootPath = await env.doc.importCad({
      glb: new ArrayBuffer(0),
      cadlink: {
        File: 'gearbox.step', Sha256: 'h-test', Quality: 'standard',
        ImportScaleFactor: 0.001, ZIsUpVector: true,
      },
    }, { root: cadRoot });
    await env.doc.whenIdle();

    expect(rootPath).toContain('gearbox');   // named after the CAD file
    expect(env.doc.getSnapshot().opCount).toBe(1);
    expect(env.doc.getSnapshot().canUndo).toBe(true);
    expect(env.doc.ops[0].kind).toBe('importCad');

    ok(await env.tools.webEditorUndo(1));
    await env.doc.whenIdle();
    expect(env.doc.getSnapshot().opCount).toBe(0);
  });
});

// ─── The base-swap gate (plan-710 §2.4) ─────────────────────────────────

describe('the asset canApply gate', () => {
  it('drops ops queued while the base is being swapped — not applied, not recorded', async () => {
    env.doc.beginBaseSwap();
    expect(env.doc.isBaseSwapping).toBe(true);

    // Through the REAL tool, exactly as an agent would issue it mid-re-import.
    await env.tools.webEditorRename(env.boxPath, 'Crate');
    await env.doc.whenIdle();

    expect(env.doc.getSnapshot().opCount).toBe(0);
    expect(env.doc.dirty).toBe(false);
    expect(node(env, env.boxPath)?.name).toBe('Box');

    env.doc.endBaseSwap();
    ok(await env.tools.webEditorRename(env.boxPath, 'Crate'));
    await env.doc.whenIdle();
    expect(env.doc.getSnapshot().opCount).toBe(1);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────

function node(e: Env, path: string): Object3D | null {
  return e.viewer.registry?.getNode(path) ?? null;
}

function rvOf(viewer: RVViewer, path: string): Record<string, unknown> {
  const n = viewer.registry?.getNode(path);
  return (n?.userData?.realvirtual as Record<string, unknown> | undefined) ?? {};
}

function driveField(e: Env, field: string): unknown {
  const drive = rvOf(e.viewer, e.boxPath)['Drive'] as Record<string, unknown> | undefined;
  return drive?.[field];
}

function materialHex(e: Env, path: string): number | null {
  const mesh = node(e, path) as Mesh | null;
  const mat = mesh?.material as MeshStandardMaterial | undefined;
  return mat?.color ? mat.color.getHex() : null;
}

