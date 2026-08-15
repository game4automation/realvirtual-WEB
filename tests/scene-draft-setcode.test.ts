// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-draft-setcode.test.ts — plan-210 phase 0.5 (the `setCode` op).
 *
 * The WebComponent script source is edited through the existing scene op log:
 *  - `setCode` materialises into `overlay.nodes[path].WebComponent.Code`
 *  - inverse restores the previous code (or unsets when there was none)
 *  - keystroke coalescing folds a typing run on the same node into ONE
 *    history entry while keeping the FIRST op's `prev`
 *  - undo/redo through the SceneStore behaves like every other op
 *  - autosave persist → reload round-trips the code (existing storage layer,
 *    no special mechanism)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  type SetCodeOp,
  WEB_COMPONENT_TYPE,
  WEB_COMPONENT_CODE_FIELD,
  freshOpId,
  materialise,
  inverseOp,
} from '../src/core/hmi/scene/rv-scene-edits';
import { canCoalesceRvOps, mergeRvOps, describeRvOp } from '../src/core/ops/rv-unified-ops';
import {
  type RvScene,
  type SceneBase,
  baseKeyOf,
  makeDraftScene,
} from '../src/core/hmi/scene/rv-scene-types';
import { writeScene, readScene } from '../src/core/hmi/scene/rv-scene-storage';
import { deadDraftKey, deadSlotExists } from './helpers/dead-draft-slots';
import { readSceneGlb } from '../src/core/storage/rv-scene-glb-store';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
// plan-716 Phase 3: a save writes a document file, so the round-trip case needs
// a project. Every other case here is about the op itself and is untouched.
import { documentsOf } from '../src/core/project/rv-project-documents';
import { resetProjectStore } from '../src/core/project/project-store';
import { installFakeDocumentProject } from './helpers/fake-document-project';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Helpers ────────────────────────────────────────────────────────────

const NODE = 'Line1/Turntable';

/** Wait for the debounced GLB autosave to land a body in `slot`. */
async function waitForDraftBody(slot: string, timeoutMs = 10000): Promise<Uint8Array | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await readSceneGlb(slot);
    if (body) return body;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function setCode(code: string, prev: string | undefined, ts = Date.now(), nodePath = NODE): SetCodeOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'setCode', nodePath, code, prev };
}

function codeInOverlay(ops: Parameters<typeof materialise>[0], nodePath = NODE): unknown {
  return materialise(ops).overlay.nodes[nodePath]?.[WEB_COMPONENT_TYPE]?.[WEB_COMPONENT_CODE_FIELD];
}

// Fake viewer — matches the surface scene-store + executors touch
// (same pattern as rv-scene-undo-redo.test.ts).
interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  registry: null;
  markRenderDirty: () => void;
  /** `openDocument` records the active mode with the session pointer. */
  modes: { has: (id: string) => boolean; setMode: (id: string) => void; activeMode: string | null };
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    availableModels: [{ url: '/models/Demo.glb', label: 'Demo' }],
    currentScene: null,
    currentModelUrl: null,
    registry: null,
    markRenderDirty: vi.fn(),
    modes: { has: () => false, setMode: () => {}, activeMode: null },
    loadScene: vi.fn(async (s: RvScene) => {
      v.currentScene = s;
      v.currentModelUrl = s.base.kind === 'builtin' ? s.base.url : 'empty:';
    }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

const builtin: SceneBase = { kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' };

let viewer: FakeViewer;
let store: SceneStore;

beforeEach(() => {
  localStorage.clear();
  viewer = makeViewer();
  store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
});

// ─── Materialise ────────────────────────────────────────────────────────

describe('setCode — materialise', () => {
  it('writes overlay.nodes[path].WebComponent.Code (plan-210 §7 shape)', () => {
    const ops = [setCode('function setup(self) {}', undefined)];
    expect(codeInOverlay(ops)).toBe('function setup(self) {}');
  });

  it('last write wins for the same node', () => {
    const ops = [
      setCode('v1', undefined, 1000),
      setCode('v2', 'v1', 5000),   // outside coalesce window — two ops
    ];
    expect(codeInOverlay(ops)).toBe('v2');
  });

  it('setCode + unsetField(WebComponent.Code) removes the override entirely', () => {
    const ops = [
      setCode('v1', undefined, 1000),
      {
        id: freshOpId(), ts: 5000, schemaV: 1 as const,
        kind: 'unsetField' as const,
        nodePath: NODE, componentType: WEB_COMPONENT_TYPE, fieldName: WEB_COMPONENT_CODE_FIELD,
        prev: 'v1',
      },
    ];
    const m = materialise(ops);
    expect(m.overlay.nodes[NODE]).toBeUndefined();
  });

  it('other WebComponent fields stay editable via generic setField alongside setCode', () => {
    const ops = [
      setCode('v1', undefined, 1000),
      {
        id: freshOpId(), ts: 5000, schemaV: 1 as const,
        kind: 'setField' as const,
        nodePath: NODE, componentType: WEB_COMPONENT_TYPE, fieldName: 'DesSafe',
        value: true, prev: undefined,
      },
    ];
    const comp = materialise(ops).overlay.nodes[NODE][WEB_COMPONENT_TYPE];
    expect(comp[WEB_COMPONENT_CODE_FIELD]).toBe('v1');
    expect(comp['DesSafe']).toBe(true);
  });
});

// ─── Inverse ────────────────────────────────────────────────────────────

describe('setCode — inverseOp', () => {
  it('inverse restores the previous code', () => {
    const inv = inverseOp(setCode('v2', 'v1'));
    expect(inv.kind).toBe('setCode');
    if (inv.kind === 'setCode') {
      expect(inv.code).toBe('v1');
      expect(inv.prev).toBe('v2');
    }
  });

  it('inverse of a first-ever setCode unsets WebComponent.Code', () => {
    const inv = inverseOp(setCode('v1', undefined));
    expect(inv.kind).toBe('unsetField');
    if (inv.kind === 'unsetField') {
      expect(inv.componentType).toBe(WEB_COMPONENT_TYPE);
      expect(inv.fieldName).toBe(WEB_COMPONENT_CODE_FIELD);
      expect(inv.prev).toBe('v1');
    }
  });

  it('describeRvOp yields a code-aware label', () => {
    expect(describeRvOp(setCode('x', undefined))).toBe('Edit script on Turntable');
  });
});

// ─── Coalescing ─────────────────────────────────────────────────────────

describe('setCode — keystroke coalescing', () => {
  it('same node within the window coalesces, keeping the FIRST prev', () => {
    const a = setCode('f', undefined, 1000);
    const b = setCode('fu', 'f', 1100);
    expect(canCoalesceRvOps(a, b)).toBe(true);
    const merged = mergeRvOps(a, b);
    expect(merged.kind).toBe('setCode');
    if (merged.kind === 'setCode') {
      expect(merged.code).toBe('fu');
      expect(merged.prev).toBeUndefined();   // first op's prev survives
      expect(merged.id).toBe(a.id);
    }
  });

  it('different nodes do not coalesce', () => {
    const a = setCode('f', undefined, 1000);
    const b = setCode('g', undefined, 1100, 'Line1/Other');
    expect(canCoalesceRvOps(a, b)).toBe(false);
  });

  it('outside the coalesce window does not coalesce', () => {
    const a = setCode('f', undefined, 1000);
    const b = setCode('fu', 'f', 5000);
    expect(canCoalesceRvOps(a, b)).toBe(false);
  });
});

// ─── SceneStore integration: undo/redo + coalescing ─────────────────────

describe('setCode — SceneStore undo/redo', () => {
  it('a typing run is ONE undo step; undo reverts to before the run', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setCode('f', undefined, 1000));
    await store.applyOp(setCode('fu', 'f', 1100));
    await store.applyOp(setCode('fun', 'fu', 1200));

    const snap = store.getSnapshot();
    expect(snap.draft?.edits.ops).toHaveLength(1);   // coalesced
    expect(store.describeUndo()).toContain('Edit script on Turntable');

    await store.undo();
    expect(store.canUndo()).toBe(false);
    expect(store.canRedo()).toBe(true);
    expect(codeInOverlay(store.getSnapshot().draft!.edits.ops)).toBeUndefined();

    await store.redo();
    expect(codeInOverlay(store.getSnapshot().draft!.edits.ops)).toBe('fun');
  });

  it('setCode on two different nodes stays two undo steps', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setCode('a', undefined, 1000, 'NodeA'));
    await store.applyOp(setCode('b', undefined, 1100, 'NodeB'));
    expect(store.getSnapshot().draft?.edits.ops).toHaveLength(2);
    await store.undo();
    expect(store.canUndo()).toBe(true);
  });
});

// ─── Persist → reload round-trip (autosave rides the existing pipeline) ──

describe('setCode — persistence round-trip', () => {
  it('autosaves the code INTO the draft GLB body, not into an op log', async () => {
    // Since plan-397 phase 6 the debounced autosave bakes a GLB instead of
    // writing the op array. The code therefore survives as node extras in the
    // file — which is the whole point: a scene is now a file, and a reader
    // that never saw the op log can still find the script.
    const { objectToGlb } = await import('../src/core/import/rv-import-object');
    const { Group } = await import('three');
    const group = new Group();
    group.name = 'Demo';
    const demoGlb = await objectToGlb(group);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('.glb')) return new Response(demoGlb.slice(0), { status: 200 });
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const viewer2 = makeViewer() as unknown as { registry: unknown };
      viewer2.registry = {
        getNode: () => null,
        getComponentsAt: () => [],
        getGltfNodeNames: () => [],
        getGltfLocation: () => ({ sourceKey: '', index: 0 }),
        getPathForNode: () => null,
      };
      const store2 = new SceneStore(viewer2 as unknown as ConstructorParameters<typeof SceneStore>[0]);
      await store2.openBuiltin('/models/Demo.glb', 'Demo');
      await store2.applyOp(setCode('function setup(self) { return {}; }', undefined));

      // Poll rather than sleep past the debounce: firing the timer only STARTS
      // the write, which then bakes, hashes and puts into OPFS. A fixed delay
      // tuned on an idle machine is the test that passes alone and fails in the
      // full suite — which is exactly what it did.
      const body = await waitForDraftBody(`draft/${baseKeyOf(builtin)}`);
      expect(body).not.toBeNull();
      const json = JSON.stringify(parseGlbChunks(body!).json);
      expect(json).toContain('function setup(self)');

      // The op log is deliberately NOT persisted any more — the slot that used
      // to hold it stays empty.
      expect(deadSlotExists(deadDraftKey(builtin))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('save() persists the setCode op into the document file', async () => {
    // PORTED (plan-716 Phase 3, §9.0 "portieren — setCode-Mechanik unverändert").
    // The MECHANIC under test is untouched: a `setCode` op survives a save and
    // is readable again afterwards. What changed is WHERE it survives. It used
    // to be carried in the catalogue row's op array (`readScene(id).edits.ops`),
    // which is the row path this phase deletes; it is baked into the document's
    // GLB now, and a fresh store reads it back by opening the document.
    const { objectToGlb } = await import('../src/core/import/rv-import-object');
    const { Group } = await import('three');
    const group = new Group();
    group.name = 'Demo';
    const demoGlb = await objectToGlb(group);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('.glb')) return new Response(demoGlb.slice(0), { status: 200 });
      return realFetch(input, init);
    }) as typeof fetch;

    const project = installFakeDocumentProject();
    try {
      const bakeViewer = makeViewer() as unknown as { registry: unknown };
      bakeViewer.registry = {
        getNode: () => null,
        getComponentsAt: () => [],
        getGltfNodeNames: () => [],
        getGltfLocation: () => ({ sourceKey: '', index: 0 }),
        getPathForNode: () => null,
      };
      store = new SceneStore(bakeViewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      await store.applyOp(setCode('let a = 1;', undefined));
      await store.save();

      const id = store.getSnapshot().saved!.id;
      const row = documentsOf(project.project()).find(d => d.id === id)!;
      expect(row).toBeDefined();
      // The bake is the real one here, so the code is IN the bytes.
      const written = project.files.get(row.path)!;
      expect(JSON.stringify(parseGlbChunks(written).json)).toContain('let a = 1;');

      // Full open cycle on a fresh store, through the one open verb.
      const store2 = new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
      await store2.openDocument(id);
      expect(store2.getSnapshot().dirty).toBe(false);
      store2.dispose();
    } finally {
      project.restore();
      resetProjectStore();
      globalThis.fetch = realFetch;
    }
  });

  it('seeded saved scene with a setCode op loads and materialises', async () => {
    const op = setCode('x', undefined);
    const seeded = writeScene({
      ...makeDraftScene(builtin, 'Scripted'),
      id: legacySceneId(),
      edits: { ops: [op], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(seeded.id);
    expect(store.getSnapshot().dirty).toBe(false);
    expect(codeInOverlay(store.getSnapshot().draft!.edits.ops)).toBe('x');
  });
});
