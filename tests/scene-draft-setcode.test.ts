// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-draft-setcode.test.ts — plan-210 phase 0.5 (`setCode` EditOp).
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
  canCoalesce,
  mergeOps,
  inverseOp,
  describeOp,
} from '../src/core/hmi/scene/rv-scene-edits';
import {
  type RvScene,
  type SceneBase,
  newSceneId,
  makeDraftScene,
} from '../src/core/hmi/scene/rv-scene-types';
import { writeScene, readDraft, readScene } from '../src/core/hmi/scene/rv-scene-storage';

// ─── Helpers ────────────────────────────────────────────────────────────

const NODE = 'Line1/Turntable';

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
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    availableModels: [{ url: '/models/Demo.glb', label: 'Demo' }],
    currentScene: null,
    currentModelUrl: null,
    registry: null,
    markRenderDirty: vi.fn(),
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

  it('describeOp yields a code-aware label', () => {
    expect(describeOp(setCode('x', undefined))).toBe('Edit script on Turntable');
  });
});

// ─── Coalescing ─────────────────────────────────────────────────────────

describe('setCode — keystroke coalescing', () => {
  it('same node within the window coalesces, keeping the FIRST prev', () => {
    const a = setCode('f', undefined, 1000);
    const b = setCode('fu', 'f', 1100);
    expect(canCoalesce(a, b)).toBe(true);
    const merged = mergeOps(a, b);
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
    expect(canCoalesce(a, b)).toBe(false);
  });

  it('outside the coalesce window does not coalesce', () => {
    const a = setCode('f', undefined, 1000);
    const b = setCode('fu', 'f', 5000);
    expect(canCoalesce(a, b)).toBe(false);
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
  it('autosaved draft survives a store reload with the code intact', async () => {
    vi.useFakeTimers();
    try {
      await store.openBuiltin('/models/Demo.glb', 'Demo');
      await store.applyOp(setCode('function setup(self) { return {}; }', undefined));
      vi.runAllTimers();   // flush the debounced draft autosave

      const draft = readDraft(builtin);
      expect(draft).not.toBeNull();
      expect(codeInOverlay(draft!.edits.ops)).toBe('function setup(self) { return {}; }');
    } finally {
      vi.useRealTimers();
    }

    // Fresh store (≙ browser reload): openBuiltin resumes the per-base draft.
    const store2 = new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
    await store2.openBuiltin('/models/Demo.glb', 'Demo');
    const snap = store2.getSnapshot();
    expect(snap.dirty).toBe(true);
    expect(codeInOverlay(snap.draft!.edits.ops)).toBe('function setup(self) { return {}; }');
  });

  it('save() persists the setCode op; readScene round-trips the code', async () => {
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    await store.applyOp(setCode('let a = 1;', undefined));
    await store.save();

    const id = store.getSnapshot().saved!.id;
    const persisted = readScene(id)!;
    expect(codeInOverlay(persisted.edits.ops)).toBe('let a = 1;');

    // Full open cycle on a fresh store.
    const store2 = new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
    await store2.openScene(id);
    expect(store2.getSnapshot().dirty).toBe(false);
    expect(codeInOverlay(store2.getSnapshot().draft!.edits.ops)).toBe('let a = 1;');
  });

  it('seeded saved scene with a setCode op loads and materialises', async () => {
    const op = setCode('x', undefined);
    const seeded = writeScene({
      ...makeDraftScene(builtin, 'Scripted'),
      id: newSceneId(),
      edits: { ops: [op], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });
    await store.openScene(seeded.id);
    expect(store.getSnapshot().dirty).toBe(false);
    expect(codeInOverlay(store.getSnapshot().draft!.edits.ops)).toBe('x');
  });
});
