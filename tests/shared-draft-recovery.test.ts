// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-711 §9.5 — ONE draft, ONE recovery truth for the shared document (F5).
 *
 * A shared document is written twice on purpose: the op log into the frame
 * keyspace, and the scene's baked bytes into its body slot so the scene view
 * survives a reload without replaying anything. Two records, one document — so
 * the promise is not "there is only one writer", it is:
 *
 *  - both writers address the SAME slot, derived from the document's IDENTITY
 *    rather than from either side's instance id (`sharedDocumentFrame`);
 *  - exactly one rule decides what the leftovers mean, everywhere
 *    (`decideDocumentRecovery`): the op record leads, the bytes are a cache of
 *    a PREFIX of it, and the stamp is what makes "prefix" checkable;
 *  - the transition moment — an old bytes slot beside a record from a build
 *    that already knows about frames — has a deterministic answer rather than a
 *    race;
 *  - the UNGLEICH-Fall keeps its two independent writers, untouched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __clearDraftStoresForTests,
  draftKeyOf,
  loadDocumentDraft,
  rootFrame,
  saveDocumentDraft,
  sharedDocumentFrame,
  toDocumentDraft,
  type RvDocumentDraft,
  type RvDraftBytesCache,
} from '../src/core/ops/rv-document-drafts';
import {
  decideDocumentRecovery,
  describeDocumentRecovery,
} from '../src/core/ops/rv-document-recovery';
import { chooseEditorDraft, chooseRecoveryRoot } from '../src/core/editor/rv-editor-draft-recovery';
import {
  libraryDocumentBase,
  projectDocumentBase,
  sceneDocumentBase,
} from '../src/core/editor/active-asset-store';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../src/core/ops/rv-unified-executors';
import type { RvOp, RvPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Fixtures ───────────────────────────────────────────────────────────

let opSeq = 0;
const head = () => ({ id: `op_rec_${++opSeq}`, ts: 20_000, schemaV: 1 as const });

const setField = (value: number): RvPrimitiveOp => ({
  ...head(), kind: 'setField',
  nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 0,
});

/** A SCENE-only kind: it materialises in the scene projection and nowhere else. */
const addPlacement = (id: string): RvPrimitiveOp => ({
  ...head(), kind: 'addPlacement',
  placement: {
    id, assetId: 'lib/belt', name: 'Belt',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  },
} as unknown as RvPrimitiveOp);

/** An ASSET-only kind: authored in the editor, unprojectable into the scene. */
const deleteNode = (nodePath = 'Asset/Frame'): RvPrimitiveOp => ({
  ...head(), kind: 'deleteNode', nodePath,
} as unknown as RvPrimitiveOp);

const SCENE_BASE = sceneDocumentBase('scene_7', 'Line 7');

function record(ops: RvOp[], bytesCache?: RvDraftBytesCache): RvDocumentDraft {
  return toDocumentDraft({
    frame: sharedDocumentFrame(SCENE_BASE)!,
    shell: { id: 'asset_live', name: 'Line 7', base: SCENE_BASE, createdAt: 1 },
    ops,
    savedAt: 5_000,
    ...(bytesCache ? { bytesCache } : {}),
  });
}

const BYTES = { slot: 'draft/scene_7', revision: 'rev-a' };

beforeEach(async () => {
  await __clearDraftStoresForTests();
});

// ─── The slot: one key, derived from the identity ───────────────────────

describe('der ROOT-FrameKey des geteilten Dokuments', () => {
  it('is derived from the document identity, not from an instance id', () => {
    const frame = sharedDocumentFrame(SCENE_BASE);
    // plan-716 Phase 4: the key says `doc:` now. Phase 3 had already made the
    // id a documentId while the prefix still read `scene:` — consistent, and
    // wrong about what the id was. `scene:` survives as a permanent READ path
    // (see document-alias.test.ts), never as a spelling anything writes.
    expect(frame).toEqual({ projectId: null, rootDocumentId: 'doc:scene_7', occurrence: '' });
    // The point of deriving it: a second session, a second facade, a different
    // instance id — and the same slot, which is what makes it recoverable by a
    // side that never saw the instance.
    expect(draftKeyOf(frame!)).toBe(draftKeyOf(sharedDocumentFrame(
      sceneDocumentBase('scene_7', 'renamed since'),
    )!));
    // …and never the same slot as another scene's.
    expect(draftKeyOf(frame!)).not.toBe(draftKeyOf(sharedDocumentFrame(
      sceneDocumentBase('scene_8', 'Line 8'),
    )!));
  });

  it('is null for every kind that cannot be bound — the asset lineage is unchanged', () => {
    expect(sharedDocumentFrame(null)).toBeNull();
    expect(sharedDocumentFrame({ kind: 'empty' })).toBeNull();
    expect(sharedDocumentFrame(projectDocumentBase('library/a.glb', 'a')))
      .toBeNull();
    expect(sharedDocumentFrame({ kind: 'sceneGlbSlot', slot: 'draft/x', label: 'X' })).toBeNull();
  });

  it('an AssetDocument bound to a scene writes that slot, not its own', async () => {
    const viewer = {
      scene: {}, registry: null, signalStore: null, transportManager: null,
      currentModelRoot: null,
      markRenderDirty() {}, markShadowsDirty() {},
      emit() {}, on() { return () => {}; },
      rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    } as unknown as RVViewer;
    const shared = new RvDocument({
      id: 'scene_doc', name: 'Line 7', mode: 'scene',
      executor: new RvUnifiedExecutor(viewer, 'scene'),
    });
    const bound = new AssetDocument(viewer, {
      id: 'asset_' + Date.now().toString(36), name: 'Line 7',
      base: SCENE_BASE, adopt: shared,
    });

    expect(bound.draftFrame).toEqual(sharedDocumentFrame(SCENE_BASE));
    // The instance id is NOT the key any more — that is the whole change.
    expect(bound.draftFrame.rootDocumentId).not.toBe(bound.id);

    // And the stamp the scene supplies travels into the written record.
    bound.setDraftBytesCache(() => ({ ...BYTES, floor: 2 }));
    await shared.applyOp(setField(400));
    await bound.flushDraft();

    const stored = await loadDocumentDraft(bound.draftFrame);
    expect(stored?.ops).toHaveLength(1);
    expect(stored?.bytesCache).toEqual({ ...BYTES, floor: 2 });

    bound.dispose();
    shared.dispose();
  });
});

// ─── The rule: ops lead, bytes are a cache ──────────────────────────────

describe('Recovery entscheidet EINE Wahrheit', () => {
  it('nothing left behind is nothing to decide', () => {
    expect(decideDocumentRecovery({ frame: null, bytes: null, projection: 'scene' }))
      .toMatchObject({ truth: 'none', tail: [], unreinstated: 0 });
  });

  it('bytes alone are the truth — no record, nothing to lead with', () => {
    expect(decideDocumentRecovery({ frame: null, bytes: BYTES, projection: 'scene' }))
      .toMatchObject({ truth: 'bytes', unreinstated: 0 });
  });

  it('an EMPTY record does not outrank the bytes', () => {
    // A record whose log is empty says "this document is at its baseline"; the
    // bytes say what the baseline looks like. Letting the record win here would
    // blank a scene that has perfectly good bytes.
    const decision = decideDocumentRecovery({
      frame: record([], { ...BYTES, floor: 0 }), bytes: BYTES, projection: 'scene',
    });
    expect(decision.truth).toBe('bytes');
  });

  it('a STAMPED, matching cache is used as the base and only the tail replays', () => {
    const ops = [setField(1), setField(2), setField(3)];
    const decision = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 2 }), bytes: BYTES, projection: 'scene',
    });
    expect(decision.truth).toBe('ops');
    expect(decision.cache).toBe('valid');
    // The bytes already hold ops 1 and 2 — replaying them would double them.
    expect(decision.tail).toEqual([ops[2]]);
    expect(decision.unreinstated).toBe(0);
  });

  it('the tail is FILTERED by projection, and what it drops is reported', () => {
    // The editor half of a bound session: authored ops that the scene tree
    // cannot take (Spike e3 — they would edit the wrong tree, not be skipped).
    const ops = [setField(1), deleteNode(), setField(2)];
    const decision = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 1 }), bytes: BYTES, projection: 'scene',
    });
    expect(decision.tail.map((o) => o.kind)).toEqual(['setField']);
    expect(decision.unreinstated).toBe(1);
    expect(describeDocumentRecovery(decision, 'Line 7'))
      .toMatch(/1 unsaved change\(s\) left out/);
  });

  it('a scene-only op in the scene projection replays; the same op does not in the asset one', () => {
    const ops = [addPlacement('p1')];
    const intoScene = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 0 }), bytes: BYTES, projection: 'scene',
    });
    const intoAsset = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 0 }), bytes: BYTES, projection: 'asset',
    });
    expect(intoScene.tail).toHaveLength(1);
    expect(intoAsset.tail).toHaveLength(0);
    expect(intoAsset.unreinstated).toBe(1);
  });
});

// ─── The transition moment, and the other two stale shapes ──────────────

describe('deterministischer Tie-Breaker', () => {
  const ops = [setField(1), setField(2)];

  it('UNSTAMPED — an old bytes slot beside a new frame record: the record leads, the cache is refused', () => {
    // The case the plan names. There is no timestamp race here and no "newest
    // wins": a cache that cannot prove its prefix may not be replayed onto,
    // full stop — so the bytes stand as they are and the record says, out loud,
    // what it could not put back.
    const decision = decideDocumentRecovery({
      frame: record(ops), bytes: BYTES, projection: 'scene',
    });
    expect(decision).toMatchObject({ truth: 'ops', cache: 'unstamped', tail: [], unreinstated: 2 });
    expect(describeDocumentRecovery(decision, 'Line 7'))
      .toMatch(/cannot be matched to the change log/);
  });

  it('MOVED — the bytes were rewritten after the record: same verdict, same reason', () => {
    const decision = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 1 }),
      bytes: { ...BYTES, revision: 'rev-b' },
      projection: 'scene',
    });
    expect(decision).toMatchObject({ truth: 'ops', cache: 'moved', tail: [], unreinstated: 2 });
  });

  it('ANOTHER SLOT is as stale as another revision', () => {
    const decision = decideDocumentRecovery({
      frame: record(ops, { slot: 'draft/scene_OTHER', revision: 'rev-a', floor: 1 }),
      bytes: BYTES,
      projection: 'scene',
    });
    expect(decision.cache).toBe('moved');
  });

  it('ABSENT bytes leave the record alone with the truth', () => {
    const decision = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 1 }), bytes: null, projection: 'scene',
    });
    expect(decision).toMatchObject({ truth: 'ops', cache: 'absent' });
  });

  it('a floor from another world is clamped, never sliced with', () => {
    const beyond = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: 99 }), bytes: BYTES, projection: 'scene',
    });
    expect(beyond.tail).toEqual([]);
    const negative = decideDocumentRecovery({
      frame: record(ops, { ...BYTES, floor: -3 }), bytes: BYTES, projection: 'scene',
    });
    expect(negative.tail).toHaveLength(2);
  });

  it('the verdict is a pure function of the two records — same input, same answer', () => {
    const input = {
      frame: record(ops, { ...BYTES, floor: 1 }), bytes: BYTES, projection: 'scene' as const,
    };
    expect(decideDocumentRecovery(input)).toEqual(decideDocumentRecovery(input));
  });
});

// ─── The editor's own recovery is not shadowed by the shared record ─────

describe('der geteilte Record gehoert der Szene, nicht dem Editor', () => {
  it('is skipped when the editor picks a recovery root — even when it is the newest', async () => {
    const editorFrame = rootFrame(null, 'asset_own');
    const editorDraft = toDocumentDraft({
      frame: editorFrame,
      shell: { id: 'asset_own', name: 'Gripper', base: { kind: 'empty' }, createdAt: 1 },
      ops: [setField(9)],
      savedAt: 1_000,
    });
    // The scene's record is NEWER, which under "newest wins" alone would elect
    // it — and then `chooseEditorDraft` would answer null and take the editor's
    // own recoverable work down with it.
    const sharedDraft = record([setField(1)], { ...BYTES, floor: 0 });

    const root = chooseRecoveryRoot([editorDraft, sharedDraft], null);
    expect(root?.rootDocumentId).toBe('asset_own');
    expect(chooseEditorDraft({ frames: [sharedDraft], savedAt: 5_000, cleanAncestors: [] }))
      .toBeNull();
  });

  it('an editor draft and a shared one live side by side in storage', async () => {
    await saveDocumentDraft({
      frame: rootFrame(null, 'asset_own'),
      shell: { id: 'asset_own', name: 'Gripper', base: { kind: 'empty' }, createdAt: 1 },
      ops: [setField(9)],
    });
    await saveDocumentDraft({
      frame: sharedDocumentFrame(SCENE_BASE)!,
      shell: { id: 'asset_live', name: 'Line 7', base: SCENE_BASE, createdAt: 1 },
      ops: [setField(1)],
      bytesCache: { ...BYTES, floor: 0 },
    });
    expect(await loadDocumentDraft(rootFrame(null, 'asset_own'))).not.toBeNull();
    expect(await loadDocumentDraft(sharedDocumentFrame(SCENE_BASE)!)).not.toBeNull();
  });
});

// ─── The scene side actually asks, and actually cleans up ───────────────

describe('SceneStore und die eine Wahrheit', () => {
  function makeSceneViewer(): RVViewer {
    return {
      availableModels: [], currentScene: null, currentModelUrl: null, registry: null,
      modes: { activeMode: 'planner', has: () => true, setMode: () => {}, subscribe: () => () => {} },
      loadScene: async () => {}, loadEmptyScene: async () => {},
      getPlugin: () => undefined, markRenderDirty() {}, emit() {},
    } as unknown as RVViewer;
  }

  /** The clear is fire-and-forget by design — wait for storage, not for a promise. */
  async function settled(read: () => Promise<unknown>, want: 'gone' | 'there'): Promise<unknown> {
    for (let i = 0; i < 50; i++) {
      const value = await read();
      if ((want === 'gone') === (value === null)) return value;
      await new Promise((r) => setTimeout(r, 10));
    }
    return read();
  }

  async function boundStore() {
    const { SceneStore } = await import('../src/core/hmi/scene/scene-store');
    const store = new SceneStore(makeSceneViewer());
    await store.newEmpty();
    vi.spyOn(store, 'documentIdentity').mockReturnValue(SCENE_BASE);
    return store;
  }

  it('drops the shared record when the document is clean again', async () => {
    const store = await boundStore();
    store.beginProjectionHandover();
    await saveDocumentDraft({
      frame: sharedDocumentFrame(SCENE_BASE)!,
      shell: { id: 'asset_live', name: 'Line 7', base: SCENE_BASE, createdAt: 1 },
      ops: [setField(1)],
    });

    // The record's writer — the editor facade — is gone by the time a save makes
    // the document clean, so this store is the only one that can drop it.
    (store as unknown as { _dropSharedDraftIfClean(): void })._dropSharedDraftIfClean();
    expect(await settled(() => loadDocumentDraft(sharedDocumentFrame(SCENE_BASE)!), 'gone'))
      .toBeNull();

    store.dispose();
  });

  it('keeps it while the document is dirty — that is the work it describes', async () => {
    const store = await boundStore();
    store.beginProjectionHandover();
    await saveDocumentDraft({
      frame: sharedDocumentFrame(SCENE_BASE)!,
      shell: { id: 'asset_live', name: 'Line 7', base: SCENE_BASE, createdAt: 1 },
      ops: [setField(1)],
    });
    await store.applyOp(setField(2) as never);

    (store as unknown as { _dropSharedDraftIfClean(): void })._dropSharedDraftIfClean();
    expect(await loadDocumentDraft(sharedDocumentFrame(SCENE_BASE)!)).not.toBeNull();

    store.dispose();
  });

  it('asks the ONE rule on open, and answers null when nothing was left behind', async () => {
    const store = await boundStore();
    const scene = {
      id: 'scene_7', name: 'Line 7',
      base: { kind: 'scene-glb', sceneId: 'scene_7', label: 'Line 7' },
      createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z',
      schemaVersion: 1, edits: { ops: [], settings: {} },
    };
    const plan = (store as unknown as {
      _planDocumentRecovery(s: unknown, saved: unknown): Promise<unknown>;
    })._planDocumentRecovery.bind(store);

    // No record: nothing to arbitrate, and the open path is byte-identical to
    // what it was before plan-711.
    expect(await plan(scene, scene)).toBeNull();
    // Not a saved scene of its own: no shared identity, so no question either.
    expect(await plan(scene, null)).toBeNull();

    await saveDocumentDraft({
      frame: sharedDocumentFrame(SCENE_BASE)!,
      shell: { id: 'asset_live', name: 'Line 7', base: SCENE_BASE, createdAt: 1 },
      ops: [setField(1), deleteNode()],
    });
    const verdict = await plan(scene, scene) as { truth: string; unreinstated: number };
    // A record with no provable bytes cache: the record leads, and it says so
    // rather than replaying a log of unknown overlap onto the body.
    expect(verdict).toMatchObject({ truth: 'ops', unreinstated: 2 });

    store.dispose();
  });
});

// ─── The UNGLEICH-Fall keeps two writers ────────────────────────────────

describe('Ungleich-Fall: zwei Schreiber, unveraendert', () => {
  it('an unbound document keeps its INSTANCE-keyed frame', () => {
    const viewer = {
      scene: {}, registry: null, signalStore: null, transportManager: null,
      currentModelRoot: null,
      markRenderDirty() {}, markShadowsDirty() {},
      emit() {}, on() { return () => {}; },
      rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    } as unknown as RVViewer;
    const doc = AssetDocument.newUntitled(viewer);
    expect(doc.draftFrame).toEqual(rootFrame(null, doc.id));
    // No stamp either: an unbound document has no bytes projection to point at,
    // so nothing may claim it has one.
    expect(doc.draftFrame.rootDocumentId.startsWith('scene:')).toBe(false);
    doc.dispose();
  });

  it('a record without a stamp writes no `bytesCache` field at all', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveDocumentDraft({
      frame: rootFrame(null, 'asset_plain'),
      shell: { id: 'asset_plain', name: 'Plain', base: { kind: 'empty' }, createdAt: 1 },
      ops: [setField(1)],
    });
    const stored = await loadDocumentDraft(rootFrame(null, 'asset_plain'));
    expect(stored).not.toBeNull();
    expect('bytesCache' in (stored as object)).toBe(false);
    spy.mockRestore();
  });
});
