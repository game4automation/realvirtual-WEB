// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 Phase 2 (§2.4 / F4 / §9.2) — everything that has to keep resolving
 * after a scene changes identity.
 *
 * The migration is only half the promise. The other half is that nothing the
 * user or the app already holds notices: a bookmarked `?scene=scn_…`, the
 * "reopen what was open" pointer, the autosave slot the previous session was
 * writing into, and the tab that was still open while another one migrated.
 * Each of those is a different reader of the old id, and each is pinned here.
 *
 * ## Why the alias map is asserted to survive things
 *
 * The map is PERMANENT. That claim is only worth making if the routines that
 * exist to clean up after scenes cannot take it with them, so the cleanup
 * helpers are pointed at it directly rather than trusted to leave it alone —
 * `rv-doc-alias/` shares a prefix with nothing, and the test is what keeps that
 * true when somebody adds the next `rv-scenes…` walker.
 *
 * ## What is deliberately NOT here
 *
 * "A transient session writes no draft slots" is already pinned by
 * `open-paths-characterization.test.ts` (the Phase-0 baseline, §9.2's own
 * note). Restating it here would give the property two owners and let one drift.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Harness for the alt-session weiche (mirrors scene-save-concurrency) ──

const h = vi.hoisted(() => ({
  /** Slots whose next write must be refused as a revision conflict. */
  conflicting: new Set<string>(),
  bodies: new Map<string, string>(),
}));

let nextRevision = 0;

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', async () => {
  const { SceneRevisionConflictError } = await import('../src/core/project/rv-scene-record');
  return {
    readSceneGlbBody: async (slot: string) =>
      (h.bodies.has(slot)
        ? { glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]), revision: h.bodies.get(slot)!, target: 'opfs' }
        : null),
    writeSceneGlbBody: async (write: { sceneId: string }) => {
      if (h.conflicting.has(write.sceneId)) {
        throw new SceneRevisionConflictError(write.sceneId, 'expected', 'actual');
      }
      const revision = `rev${++nextRevision}`;
      h.bodies.set(write.sceneId, revision);
      return { revision, target: 'opfs' };
    },
    dropSceneGlbBody: async (slot: string) => { h.bodies.delete(slot); },
    sceneGlbBodyRevision: async (sceneId: string) => h.bodies.get(sceneId) ?? null,
  };
});

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({ glb: new Uint8Array([1, 2, 3, 4]), warnings: [], writtenReferences: [] }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getBackend: () => null,
    getProject: () => ({ id: 'prj_one' }),
    mintReferencedAssetIdentities: async () => {},
    setDirtyDocumentsProbe: () => {},
  }),
}));

import {
  clearAllDocumentAliases,
  hasDocumentAlias,
  listDocumentAliasIds,
  readAllDocumentAliases,
  resolveDocumentAlias,
  resolveDocumentId,
  resolveSceneRoute,
  sceneUrlToDocumentUrl,
  writeDocumentAlias,
  LS_KEY_DOC_ALIAS_PREFIX,
} from '../src/core/project/rv-doc-alias';
import {
  clearAllScenes,
  clearDraftsForScope,
  readActiveId,
  readStoredActiveId,
  writeActiveId,
} from '../src/core/hmi/scene/rv-scene-storage';
import {
  clearDocumentDraft,
  loadDocumentDraft,
  loadSharedDocumentDraft,
  rootFrame,
  saveDocumentDraft,
  sharedDocumentFrame,
  sharedDocumentFrameFallbacks,
  __clearDraftStoresForTests,
  type RvDraftBase,
} from '../src/core/ops/rv-document-drafts';
import { sceneDocumentBase } from '../src/core/editor/active-asset-store';
import { runWorkspaceScenesMigration, __resetWorkspaceMigrationForTests } from '../src/core/project/rv-workspace-migration';
import { writeScene } from '../src/core/hmi/scene/rv-scene-storage';
import { writeSceneGlb, readSceneGlbPointer } from '../src/core/storage/rv-scene-glb-store';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';
import { openWorkspaceDefaultBackend, WORKSPACE_DEFAULT_PROJECT_ID } from '../src/core/project/rv-workspace-default';
import { browserManifestKey, browserBlobIndexKey } from '../src/core/project/backends/browser-backend';
import {
  clearSceneSyncNotices,
  onSceneSyncNotice,
  type SceneSyncNotice,
} from '../src/core/hmi/scene/rv-scene-live-sync';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  RV_SCENE_SCHEMA_VERSION,
  makeDraftScene,
  type RvScene,
} from '../src/core/hmi/scene/rv-scene-types';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Fixtures ───────────────────────────────────────────────────────────

function sceneFixture(id: string, name: string): RvScene {
  return {
    id, name,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    schemaVersion: RV_SCENE_SCHEMA_VERSION,
    base: { kind: 'empty' },
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 100 } },
  };
}

const DOCS = [
  { id: 'doc_line_a', path: 'scenes/Line A.glb', name: 'Line A' },
  { id: 'doc_line_b', path: 'scenes/Line B.glb', name: 'Line B' },
];

function wipe(): void {
  clearAllScenes();
  clearAllSceneOwners();
  clearAllDocumentAliases();
  clearSceneSyncNotices();
  __resetWorkspaceMigrationForTests();
  h.conflicting.clear();
  h.bodies.clear();
  nextRevision = 0;
  for (const key of [...Array(localStorage.length).keys()].map(i => localStorage.key(i))) {
    if (!key) continue;
    if (
      key.startsWith('rv-scene-glb/')
      || key.startsWith('rv-scenes/')
      || key === browserManifestKey(WORKSPACE_DEFAULT_PROJECT_ID)
      || key === browserBlobIndexKey(WORKSPACE_DEFAULT_PROJECT_ID)
    ) localStorage.removeItem(key);
  }
}

beforeEach(async () => { wipe(); await __clearDraftStoresForTests(); });
afterEach(() => { wipe(); vi.restoreAllMocks(); });

// ─── URL routing ────────────────────────────────────────────────────────

describe('?scene= resolves onto ?doc=', () => {
  it('an aliased id yields the document row and the rewritten URL', () => {
    writeDocumentAlias('scn_a', 'doc_line_a');

    const route = resolveSceneRoute('scn_a', DOCS);

    expect(route).toEqual({
      kind: 'document',
      documentId: 'doc_line_a',
      relPath: 'scenes/Line A.glb',
      name: 'Line A',
    });
    expect(sceneUrlToDocumentUrl('https://app.test/?scene=scn_a', 'doc_line_a'))
      .toBe('https://app.test/?doc=doc_line_a');
  });

  it('keeps every other query parameter across the rewrite', () => {
    // `?option=` and `?mode=` change what is rendered; dropping either while
    // "fixing" the link would turn a working deep link into a different page.
    const rewritten = sceneUrlToDocumentUrl(
      'https://app.test/?scene=scn_a&mode=planner&option=bosch&project=prj_one',
      'doc_line_a',
    );
    const params = new URL(rewritten).searchParams;
    expect(params.get('scene')).toBeNull();
    expect(params.get('doc')).toBe('doc_line_a');
    expect(params.get('mode')).toBe('planner');
    expect(params.get('option')).toBe('bosch');
    expect(params.get('project')).toBe('prj_one');
  });

  it('leaves a NON-aliased scene id to the existing open path', () => {
    // Null is the "not mine" answer, and it has to stay null rather than become
    // a `missing`: an id with no alias is an ordinary catalogue scene (or a
    // folder cache row), and its open path is unchanged by this plan.
    expect(resolveSceneRoute('scn_never_migrated', DOCS)).toBeNull();
  });

  it('leaves builtin:, published: and empty alone', () => {
    for (const id of ['empty', 'builtin:Demo.glb', 'published:Sample']) {
      expect(resolveSceneRoute(id, DOCS)).toBeNull();
    }
  });

  it('an alias onto a document that is gone reports `missing`, never a crash', () => {
    writeDocumentAlias('scn_a', 'doc_deleted');

    const route = resolveSceneRoute('scn_a', DOCS);

    // Distinct from `null` on purpose: the caller must NOT fall through to
    // `openScene(scn_a)`, whose body was retired with the row — that would open
    // an empty scene and say nothing.
    expect(route).toEqual({ kind: 'missing', documentId: 'doc_deleted' });
  });

  it('an empty/absent id is simply not a route', () => {
    expect(resolveSceneRoute('', DOCS)).toBeNull();
    expect(resolveSceneRoute(null, DOCS)).toBeNull();
    expect(resolveSceneRoute(undefined, DOCS)).toBeNull();
  });
});

// ─── The resolver's two forms ───────────────────────────────────────────

describe('the resolver', () => {
  it('is STRICT for the state question and TOLERANT for the address question', () => {
    writeDocumentAlias('scn_a', 'doc_line_a');

    // Strict: null means "no alias recorded" — what the migration asks.
    expect(resolveDocumentAlias('scn_a')).toBe('doc_line_a');
    expect(resolveDocumentAlias('doc_line_a')).toBeNull();

    // Tolerant: always an id to address — what every reader asks.
    expect(resolveDocumentId('scn_a')).toBe('doc_line_a');
    expect(resolveDocumentId('doc_line_a')).toBe('doc_line_a');
    expect(resolveDocumentId(null)).toBeNull();
  });

  it('refuses to repoint an alias at a second document', () => {
    writeDocumentAlias('scn_a', 'doc_line_a');
    expect(() => writeDocumentAlias('scn_a', 'doc_line_b')).toThrow();
    expect(resolveDocumentAlias('scn_a')).toBe('doc_line_a');
  });

  it('is idempotent for the same mapping', () => {
    writeDocumentAlias('scn_a', 'doc_line_a');
    expect(() => writeDocumentAlias('scn_a', 'doc_line_a')).not.toThrow();
    expect(listDocumentAliasIds()).toEqual(['scn_a']);
  });

  it('THROWS when the alias cannot be stored — never "document there, link dead"', () => {
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage, key: string, value: string,
    ) {
      if (key.startsWith(LS_KEY_DOC_ALIAS_PREFIX)) throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    expect(() => writeDocumentAlias('scn_a', 'doc_line_a')).toThrow(/could not be recorded/);
  });
});

// ─── The active pointer ─────────────────────────────────────────────────

describe('the "reopen what was open" pointer', () => {
  it('a pre-migration pointer resolves to the document', () => {
    writeActiveId('scn_a');
    writeDocumentAlias('scn_a', 'doc_line_a');

    expect(readActiveId()).toBe('doc_line_a');
    // The stored bytes are untouched — nothing rewrites the user's pointer.
    expect(readStoredActiveId()).toBe('scn_a');
  });

  it('a pointer with no alias comes back exactly as written', () => {
    writeActiveId('scn_untouched');
    expect(readActiveId()).toBe('scn_untouched');
  });

  it('null stays null', () => {
    writeActiveId(null);
    expect(readActiveId()).toBeNull();
  });
});

// ─── Frame keys (Form A — the permanent alias read path, R1-A8) ─────────

/**
 * plan-716 Phase 4 finishes the frame-key half of §2.4.
 *
 * Phase 3 already handed `sceneDocumentBase` a documentId (the R1-I5 transition
 * rule), but the frame still went through `base.sceneId` and so spelled itself
 * `scene:<documentId>` — consistent, and wrong about what the id was. With the
 * kind collapsed there is no id here that is not a document id, so the frame
 * says `doc:` unconditionally and the alias lookup moves OUT of this function
 * (an old link is resolved when the base is built, not when it is keyed).
 *
 * That leaves TWO historic spellings on the permanent read path, and the
 * distinction between them is the point of this block: `scene:<documentId>` is
 * what a PHASE-3 build wrote for this very document, while `scene:<scn_…>` is
 * what a pre-migration build wrote under the old catalogue id and is reachable
 * only by walking the alias map backwards.
 */
describe('draft frame keys', () => {
  const base = (documentId: string): RvDraftBase =>
    sceneDocumentBase(documentId, 'Line A') as RvDraftBase;

  it('a document always keys doc:<documentId> — no alias lookup involved', () => {
    expect(sharedDocumentFrame(base('doc_line_a'))?.rootDocumentId).toBe('doc:doc_line_a');
    // Writing an alias for an unrelated scene changes nothing about the frame:
    // the id in hand is already the document's.
    writeDocumentAlias('scn_zzz', 'doc_other');
    expect(sharedDocumentFrame(base('doc_line_a'))?.rootDocumentId).toBe('doc:doc_line_a');
  });

  it('reads the Phase-3 spelling scene:<documentId> as a fallback, always', () => {
    // No alias needed: a Phase-3 build wrote this key for every document it
    // autosaved, migrated or not.
    expect(sharedDocumentFrameFallbacks(base('doc_line_a')).map(f => f.rootDocumentId))
      .toEqual(['scene:doc_line_a']);
  });

  it('also reads the pre-migration scene:<scn_…>, found by walking the alias map back', () => {
    writeDocumentAlias('scn_a', 'doc_line_a');
    expect(sharedDocumentFrameFallbacks(base('doc_line_a')).map(f => f.rootDocumentId))
      .toEqual(['scene:doc_line_a', 'scene:scn_a']);
    // An alias pointing somewhere else is not picked up.
    writeDocumentAlias('scn_b', 'doc_other');
    expect(sharedDocumentFrameFallbacks(base('doc_line_a')).map(f => f.rootDocumentId))
      .toEqual(['scene:doc_line_a', 'scene:scn_a']);
  });

  it('a draft left under the pre-migration scene: key is still found', async () => {
    // The Form-A case in full: the previous session wrote an op draft under the
    // scene-keyed frame; the migration does not touch IndexedDB; the next open
    // must still offer that work back.
    const legacyFrame = rootFrame(null, 'scene:scn_a');
    await saveDocumentDraft({
      frame: legacyFrame,
      shell: { id: 'sh1', name: 'Line A', base: base('doc_line_a'), createdAt: 1 },
      ops: [{ id: 'op_1' } as never],
    });

    writeDocumentAlias('scn_a', 'doc_line_a');

    // The new frame holds nothing…
    expect(await loadDocumentDraft(sharedDocumentFrame(base('doc_line_a'))!)).toBeNull();
    // …and the resolving read finds it anyway.
    const found = await loadSharedDocumentDraft(base('doc_line_a'));
    expect(found?.ops).toHaveLength(1);
    expect(found?.frame.rootDocumentId).toBe('scene:scn_a');

    await clearDocumentDraft(legacyFrame);
  });

  it('a draft left under the PHASE-3 key is found without any alias', async () => {
    const phase3Frame = rootFrame(null, 'scene:doc_line_a');
    await saveDocumentDraft({
      frame: phase3Frame,
      shell: { id: 'sh1', name: 'Line A', base: base('doc_line_a'), createdAt: 1 },
      ops: [{ id: 'op_1' } as never],
    });

    const found = await loadSharedDocumentDraft(base('doc_line_a'));
    expect(found?.ops).toHaveLength(1);
    expect(found?.frame.rootDocumentId).toBe('scene:doc_line_a');

    await clearDocumentDraft(phase3Frame);
  });

  it('the new frame wins when both exist', async () => {
    writeDocumentAlias('scn_a', 'doc_line_a');
    await saveDocumentDraft({
      frame: sharedDocumentFrameFallbacks(base('doc_line_a'))[0]!,
      shell: { id: 'sh1', name: 'old', base: base('doc_line_a'), createdAt: 1 },
      ops: [{ id: 'op_old' } as never],
    });
    await saveDocumentDraft({
      frame: sharedDocumentFrame(base('doc_line_a'))!,
      shell: { id: 'sh2', name: 'new', base: base('doc_line_a'), createdAt: 2 },
      ops: [{ id: 'op_new_1' } as never, { id: 'op_new_2' } as never],
    });

    const found = await loadSharedDocumentDraft(base('doc_line_a'));
    expect(found?.ops).toHaveLength(2);
    expect(found?.frame.rootDocumentId).toBe('doc:doc_line_a');
  });

  it('is not a document at all → no frame, no fallbacks, no draft', async () => {
    // The gate, restated for the collapse: a SOURCE keeps its instance-keyed
    // frame, which is the draft layer's spelling of "sources are not documents".
    for (const notADocument of [
      { kind: 'empty' },
      { kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' },
    ] as RvDraftBase[]) {
      expect(sharedDocumentFrame(notADocument), notADocument.kind).toBeNull();
      expect(sharedDocumentFrameFallbacks(notADocument), notADocument.kind).toEqual([]);
      expect(await loadSharedDocumentDraft(notADocument)).toBeNull();
    }
  });
});

// ─── Draft bodies (Forms B and C) after the migration ───────────────────

describe('the autosave slot follows the identity (Forms B/C, R1-S2)', () => {
  it('a Form-C draft is reachable under draft/<documentId> after migrating', async () => {
    writeScene(sceneFixture('scn_a', 'Line A'));
    await writeSceneGlb('scn_a', new TextEncoder().encode('body'));
    await writeSceneGlb('draft/scn_a', new TextEncoder().encode('unsaved-work'));

    await runWorkspaceScenesMigration({
      backend: openWorkspaceDefaultBackend({ requestPersistence: false }),
    });

    const documentId = resolveDocumentAlias('scn_a')!;
    expect(readSceneGlbPointer(`draft/${documentId}`)).not.toBeNull();
    expect(readSceneGlbPointer('draft/scn_a')).toBeNull();
  });

  it('a Form-B (per-base) slot is left where it is — it is not id-keyed', async () => {
    // `draft/<baseKey>` names a BASE, not a scene, so no identity of it changed
    // and moving it would strand the draft of a built-in nobody migrated.
    await writeSceneGlb('draft/empty', new TextEncoder().encode('base-draft'));
    writeScene(sceneFixture('scn_a', 'Line A'));
    await writeSceneGlb('scn_a', new TextEncoder().encode('body'));

    await runWorkspaceScenesMigration({
      backend: openWorkspaceDefaultBackend({ requestPersistence: false }),
    });

    expect(readSceneGlbPointer('draft/empty')).not.toBeNull();
  });
});

// ─── The alt-session weiche (§2.4, R1-S4) ───────────────────────────────

describe('a tab holding the OLD identity when its save is refused', () => {
  /**
   * Save a scene, then make every further write of its slots fail the
   * revision precondition and let the debounced autosave run into it.
   *
   * `aliased` is the ONLY difference between the two cases below, which is what
   * makes the pair an argument rather than two observations.
   */
  async function refusedAutosave(aliased: boolean): Promise<SceneSyncNotice[]> {
    // The tab holds a SCENE id — that is the whole premise of the case, and
    // since plan-716 Phase 3 it is also the only way to get one: `save()` mints
    // documents now, so the old `newEmpty()` + `save()` setup would hand this
    // helper a document id and test a different tab than the one it describes.
    // Seeding the catalogue row directly is what an interrupted pre-migration
    // session actually left behind.
    const sceneId = legacySceneId();
    writeScene({ ...makeDraftScene({ kind: 'empty' }, 'Old cell'), id: sceneId });
    const store = new SceneStore(makeViewer() as never);
    await store.openScene(sceneId);
    if (aliased) writeDocumentAlias(sceneId, 'doc_line_a');

    const notices: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice(n => notices.push(n));
    h.conflicting.add(sceneId);
    h.conflicting.add(`draft/${sceneId}`);
    await store.applyOp({
      id: `op_${aliased}`, ts: Date.now(), schemaV: 1, kind: 'setField',
      nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed', value: 5, prev: 0,
    } as never);
    await new Promise(resolve => setTimeout(resolve, 2400));
    off();
    expect(hasDocumentAlias(sceneId)).toBe(aliased);
    return notices;
  }

  it('WITHOUT an alias it is an ordinary conflict — unchanged behaviour', async () => {
    const notices = await refusedAutosave(false);
    expect(notices.some(n => n.kind === 'conflict')).toBe(true);
    expect(notices.some(n => n.kind === 'moved')).toBe(false);
  }, 30_000);

  it('WITH an alias it says "moved — reload" and never "conflict"', async () => {
    const notices = await refusedAutosave(true);
    expect(notices.some(n => n.kind === 'moved')).toBe(true);
    expect(notices.some(n => n.kind === 'conflict')).toBe(false);
    expect(notices.find(n => n.kind === 'moved')!.message).toMatch(/Reload the page/);
  }, 30_000);
});

// ─── Permanence ─────────────────────────────────────────────────────────

describe('the alias map is permanent', () => {
  it('survives the scene-catalogue cleanup routines', () => {
    writeDocumentAlias('scn_a', 'doc_line_a');
    writeDocumentAlias('scn_b', 'doc_line_b');

    // Everything in this codebase whose job is to remove scene state.
    clearAllScenes();
    clearDraftsForScope('prj_one');
    clearAllSceneOwners();
    __resetWorkspaceMigrationForTests();

    expect(readAllDocumentAliases()).toEqual({ scn_a: 'doc_line_a', scn_b: 'doc_line_b' });
  });

  it('shares a key prefix with none of the namespaces those routines walk', () => {
    // The structural reason the test above passes, asserted directly so it
    // survives someone adding a new `rv-scenes…` walker.
    for (const walked of ['rv-scenes/', 'rv-scene-glb/', 'rv-scene-owner/', 'rv-scenes-retired/']) {
      expect(LS_KEY_DOC_ALIAS_PREFIX.startsWith(walked)).toBe(false);
      expect(walked.startsWith(LS_KEY_DOC_ALIAS_PREFIX)).toBe(false);
    }
  });
});

// ─── Viewer stub ────────────────────────────────────────────────────────

function makeViewer() {
  const v = {
    availableModels: [{ url: '/models/Demo.glb', label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: { name: 'root' },
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.currentScene = s; },
    loadEmptyScene: async () => {},
  };
  return v;
}
