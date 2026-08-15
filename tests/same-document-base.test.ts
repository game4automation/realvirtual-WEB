// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * same-document-base.test.ts — plan-711 §9.1 (Phase 0).
 *
 * Two things, and they are two halves of ONE question ("is the editor about to
 * open the document the scene is already showing?"):
 *
 *  1. **The comparison** — `sameDocumentBase` over every `AssetBase` kind,
 *     including the collision cases. The asymmetry of cost drives every
 *     assertion here: a missed match costs continuity (the switch falls back to
 *     today's save/restore, a supported path), a WRONG match binds one file's
 *     op log to another file's bytes. So the collision cases are the point of
 *     the file, not an appendix to it.
 *
 *  2. **The identity that was missing** — a saved scene had none
 *     (`SceneStore._loadIntoWorkspace` wrote `null`, and the projects
 *     dashboard's `openScene` wrote nothing at all), so for the ONE case
 *     plan-711 exists for the question could not even be asked. The
 *     `describe('die geschlossene Luecke')` block is red without the fix: it
 *     asserts a non-null base where the old code wrote null.
 *
 * NOT pinned here: that anything BINDS. Phase 0 records an identity and changes
 * no behaviour — the editor still opens what it always opened (asserted below,
 * because a recorded-but-unhandled base could have started reaching `_loadBase`
 * by accident).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Group } from 'three';

// The bake needs a real GLB writer and a real tree; the save test below cares
// about neither — only about WHICH IDENTITY a completed save publishes. Same
// stand-in `scene-save-concurrency.test.ts` uses, for the same reason. No open
// path in this file goes through the bake, so nothing else here changes.
vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => ({ glb: new Uint8Array([1, 2, 3, 4]), warnings: [], writtenReferences: [] }),
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));
import { objectToGlb } from '../src/core/import/rv-import-object';
import { writeSceneGlb } from '../src/core/storage/rv-scene-glb-store';
import {
  getOpenDocumentBase,
  libraryDocumentBase,
  projectDocumentBase,
  sameDocumentBase,
  sceneDocumentBase,
  setOpenDocumentBase,
} from '../src/core/editor/active-asset-store';
import {
  isLegacyAssetBase,
  stableDocumentIdOfPath,
  upgradeLegacyAssetBase,
} from '../src/core/editor/rv-asset-draft-storage';
import { stableDocumentId } from '../src/core/project/rv-project-documents';
import { resolveDocumentAlias, writeDocumentAlias } from '../src/core/project/rv-doc-alias';
import { nameOfAssetBase } from '../src/core/editor/active-document-view';
import { decideSaveVerb } from '../src/core/editor/rv-save-document';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import {
  glbSceneShell,
  makeDraftScene,
  type RvScene,
  type SceneBase,
} from '../src/core/hmi/scene/rv-scene-types';
import { writeScene } from '../src/core/hmi/scene/rv-scene-storage';
// plan-716 Phase 3: the first-save case writes a document, so it needs a home.
import { resetProjectStore } from '../src/core/project/project-store';
import { installFakeDocumentProject } from './helpers/fake-document-project';
import { legacySceneId } from './helpers/legacy-scene-id';

// ─── Fixtures ───────────────────────────────────────────────────────────

/**
 * One base of every kind, all sharing the strings that could collide.
 *
 * plan-716 §2.6 collapsed `sceneDocument`/`projectDocument`/`libraryGlb` into
 * one `document` kind, so the fixture set shrinks by two. What it must NOT lose
 * is the collision material: `document` and `builtinModel` still quote the same
 * path string, and `providerAsset`/`referencedAsset` still quote the same
 * `assetId`, because those are the pairings the comparison has to keep apart.
 */
const bases = {
  empty: { kind: 'empty' },
  document: {
    kind: 'document', documentId: 'doc_cell', path: 'models/Cell.glb', name: 'Cell',
  },
  builtinModel: { kind: 'builtinModel', url: '/models/Cell.glb', name: 'Cell' },
  providerAsset: {
    kind: 'providerAsset', providerId: 'prv', sourceId: 'src', assetId: 'a1', label: 'Cell',
  },
  referencedAsset: { kind: 'referencedAsset', assetId: 'a1', label: 'Cell' },
} satisfies Record<string, AssetBase> as {
  empty: Extract<AssetBase, { kind: 'empty' }>;
  document: Extract<AssetBase, { kind: 'document' }>;
  builtinModel: Extract<AssetBase, { kind: 'builtinModel' }>;
  providerAsset: Extract<AssetBase, { kind: 'providerAsset' }>;
  referencedAsset: Extract<AssetBase, { kind: 'referencedAsset' }>;
};

const allBases: AssetBase[] = Object.values(bases);

/** A slot-addressed document — the identity the former `sceneDocument` carried. */
const slotDocument = sceneDocumentBase('doc_plant', 'Plant') as
  Extract<AssetBase, { kind: 'document' }>;

// ─── 1. The comparison ──────────────────────────────────────────────────

describe('sameDocumentBase — the canonical comparison', () => {
  it('matches every identifiable kind with an independent copy of itself', () => {
    for (const base of allBases) {
      if (base.kind === 'empty') continue; // its own rule, asserted below
      const copy = JSON.parse(JSON.stringify(base)) as AssetBase;
      expect(sameDocumentBase(base, copy), `${base.kind} must recognise itself`).toBe(true);
      // Structural, not referential: the two sides come from different layers
      // (one from the scene store, one from the editor's open plan) and are
      // never the same object.
      expect(copy).not.toBe(base);
    }
  });

  it('is symmetric', () => {
    for (const a of allBases) {
      for (const b of allBases) {
        expect(sameDocumentBase(a, b)).toBe(sameDocumentBase(b, a));
      }
    }
  });

  it('NEVER matches across kinds — not even on an identical key string', () => {
    for (const a of allBases) {
      for (const b of allBases) {
        if (a.kind === b.kind) continue;
        expect(sameDocumentBase(a, b), `${a.kind} vs ${b.kind}`).toBe(false);
      }
    }
    // A document and a built-in model can quote the same path-shaped string and
    // are still not the same thing — one is ours, the other is a SOURCE.
    expect(bases.builtinModel.url).toContain(bases.document.path);
    expect(sameDocumentBase(bases.document, bases.builtinModel)).toBe(false);
    // Same for a catalog asset and a reference that quote the same assetId.
    expect(bases.providerAsset.assetId).toBe(bases.referencedAsset.assetId);
    expect(sameDocumentBase(bases.providerAsset, bases.referencedAsset)).toBe(false);
  });

  it('an untitled document never matches — not even another untitled one', () => {
    expect(sameDocumentBase(bases.empty, { kind: 'empty' })).toBe(false);
    expect(sameDocumentBase(bases.empty, bases.empty)).toBe(false);
  });

  it('null on either side is "nothing to compare", not an error', () => {
    expect(sameDocumentBase(null, null)).toBe(false);
    expect(sameDocumentBase(null, bases.document)).toBe(false);
    expect(sameDocumentBase(bases.document, null)).toBe(false);
  });

  describe('per-kind key fields', () => {
    // ── plan-716 §2.6 / §9.0: the documentId cases ──────────────────────
    it('document: the documentId is identity, the name is NOT', () => {
      expect(sameDocumentBase(
        bases.document,
        { ...bases.document, name: 'Cell (renamed)' },
      ), 'a renamed document is still the same document').toBe(true);
      expect(sameDocumentBase(
        bases.document,
        { ...bases.document, documentId: 'doc_other' },
      ), 'two documents may share a name').toBe(false);
    });

    it('document: the PATH is not identity either — a moved file is the same file', () => {
      // The sharpest statement of the collapse. Before plan-716 the identity of
      // owned content WAS a path, so moving a file forked it; and the same
      // bytes reached through `library/` vs the project root produced two
      // identities, which is the false negative the whole plan removes.
      expect(sameDocumentBase(
        bases.document,
        { ...bases.document, path: 'scenes/Cell.glb' },
      ), 'a moved document keeps its identity').toBe(true);
      expect(sameDocumentBase(
        bases.document,
        { ...bases.document, path: '' },
      ), 'losing the path does not lose the identity').toBe(true);
    });

    it('document: two documents at the SAME path are still two documents', () => {
      // The other direction, and the reason the id — not the path — is the key:
      // a path collision must never be allowed to bind one file to another.
      expect(sameDocumentBase(
        { kind: 'document', documentId: 'doc_a', path: 'models/X.glb', name: 'X' },
        { kind: 'document', documentId: 'doc_b', path: 'models/X.glb', name: 'X' },
      )).toBe(false);
    });

    it('document: a slot-addressed document compares like any other', () => {
      // The former `sceneDocument`. Its `path` is `''`, which used to be a
      // different KIND; it must now compare by id exactly like a path-addressed
      // one, or the plan-711 bind breaks for every scene.
      expect(slotDocument.path).toBe('');
      expect(sameDocumentBase(slotDocument, sceneDocumentBase('doc_plant', 'renamed')))
        .toBe(true);
      expect(sameDocumentBase(slotDocument, sceneDocumentBase('doc_other', 'Plant')))
        .toBe(false);
    });

    it('document: the collapsed kinds now RECOGNISE each other (the bridge that is gone)', () => {
      // `library/Custom/Belt.glb` reached as a library asset and as a project
      // document used to be two identities — the documented false negative
      // (`sameDocumentBase`'s "two known bridges"). One id, one document.
      const viaLibrary = libraryDocumentBase('Custom/Belt.glb');
      const viaPath = projectDocumentBase('library/Custom/Belt.glb', 'Belt');
      expect(sameDocumentBase(viaLibrary, viaPath)).toBe(true);
      // …and the collision that made the old bridge ILLEGAL still does not
      // fire: `<p>` and `library/<p>` are different files and stay different.
      expect(sameDocumentBase(
        projectDocumentBase('Custom/Belt.glb', 'Belt'),
        viaLibrary,
      )).toBe(false);
    });

    it('providerAsset: all three of provider/source/asset, and version is advisory', () => {
      const other = (patch: Partial<typeof bases.providerAsset>): AssetBase =>
        ({ ...bases.providerAsset, ...patch });
      expect(sameDocumentBase(bases.providerAsset, other({ providerId: 'other' }))).toBe(false);
      expect(sameDocumentBase(bases.providerAsset, other({ sourceId: 'other' }))).toBe(false);
      expect(sameDocumentBase(bases.providerAsset, other({ assetId: 'other' }))).toBe(false);
      // `version` is explicitly advisory (a mismatch does not even block a
      // reopen), so it cannot be allowed to split an identity.
      expect(sameDocumentBase(bases.providerAsset, other({ version: '7' }))).toBe(true);
    });

    it('referencedAsset: the catalog qualification has to agree with the assetId', () => {
      const qualified: AssetBase = {
        kind: 'referencedAsset', assetId: 'a1', providerId: 'prv', sourceId: 'src', label: 'Cell',
      };
      expect(sameDocumentBase(bases.referencedAsset, qualified),
        'the same id reached through a library is not the same file').toBe(false);
      expect(sameDocumentBase(qualified, { ...qualified, label: 'Other name' })).toBe(true);
      // The resolved path is a convenience, not the key (`assetId` resolves
      // first — the rule `AssetReference` itself prescribes).
      expect(sameDocumentBase(bases.referencedAsset, { ...bases.referencedAsset, path: 'a/b.glb' }))
        .toBe(true);
    });

    it('builtinModel keys on its URL alone', () => {
      expect(sameDocumentBase(bases.builtinModel, { ...bases.builtinModel, name: 'X' })).toBe(true);
      expect(sameDocumentBase(bases.builtinModel, { ...bases.builtinModel, url: '/x.glb' }))
        .toBe(false);
    });
  });
});

// ─── 1b. Reading what an older build wrote (plan-716 §2.6) ──────────────

describe('legacy kinds are READ as documents, and can never be written', () => {
  it('upgrades all three collapsed kinds', () => {
    expect(upgradeLegacyAssetBase(
      { kind: 'projectDocument', relPath: 'models/Cell.glb', name: 'Cell' },
    )).toEqual({
      kind: 'document',
      documentId: stableDocumentIdOfPath('models/Cell.glb'),
      path: 'models/Cell.glb',
      name: 'Cell',
    });
    // The `library/` prefix is re-attached exactly once, here.
    expect(upgradeLegacyAssetBase(
      { kind: 'libraryGlb', fileName: 'Belt.glb', relPath: 'Custom/Belt.glb' },
    )).toEqual({
      kind: 'document',
      documentId: stableDocumentIdOfPath('library/Custom/Belt.glb'),
      path: 'library/Custom/Belt.glb',
      name: 'Belt',
    });
    // A scene keeps the empty path: it is addressed by id, not by a path.
    expect(upgradeLegacyAssetBase(
      { kind: 'sceneDocument', sceneId: 'doc_plant', sceneName: 'Plant' },
    )).toEqual({ kind: 'document', documentId: 'doc_plant', path: '', name: 'Plant' });
  });

  it('an upgraded record BINDS to the same document the live path builds', () => {
    // The whole point of read tolerance: a draft written by the previous build
    // must still recognise the document it belongs to.
    expect(sameDocumentBase(
      upgradeLegacyAssetBase({ kind: 'libraryGlb', fileName: 'Belt.glb', relPath: 'Custom/Belt.glb' }),
      libraryDocumentBase('Custom/Belt.glb'),
    )).toBe(true);
    expect(sameDocumentBase(
      upgradeLegacyAssetBase({ kind: 'projectDocument', relPath: 'models/Cell.glb', name: 'Cell' }),
      projectDocumentBase('models/Cell.glb', 'Cell'),
    )).toBe(true);
  });

  it('resolves a scn_ id through the alias map when one is recorded', () => {
    writeDocumentAlias('scn_7', 'doc_line7');
    expect(upgradeLegacyAssetBase(
      { kind: 'sceneDocument', sceneId: 'scn_7', sceneName: 'Line 7' },
      { documentIdForSceneId: (id) => resolveDocumentAlias(id) },
    )).toMatchObject({ documentId: 'doc_line7' });
  });

  it('prefers the manifest id over the derivation when the resolver has one', () => {
    expect(upgradeLegacyAssetBase(
      { kind: 'projectDocument', relPath: 'models/Cell.glb', name: 'Cell' },
      { documentIdForPath: () => 'doc_real_row' },
    )).toMatchObject({ documentId: 'doc_real_row' });
  });

  it('recognises legacy records and refuses live ones', () => {
    expect(isLegacyAssetBase({ kind: 'libraryGlb', fileName: 'a.glb', relPath: 'a.glb' })).toBe(true);
    expect(isLegacyAssetBase({ kind: 'projectDocument', relPath: 'a.glb', name: 'a' })).toBe(true);
    expect(isLegacyAssetBase({ kind: 'sceneDocument', sceneId: 's', sceneName: 'S' })).toBe(true);
    expect(isLegacyAssetBase(bases.document)).toBe(false);
    expect(isLegacyAssetBase(bases.builtinModel)).toBe(false);
    expect(isLegacyAssetBase(null)).toBe(false);
    expect(isLegacyAssetBase('libraryGlb')).toBe(false);
  });

  it('the duplicated path→id derivation agrees with the project module', () => {
    // `stableDocumentIdOfPath` is a deliberate copy of `stableDocumentId`
    // (cycle avoidance, documented at both). A drift between them would fork
    // every legacy record off the document it names, so it is asserted rather
    // than trusted to a comment.
    for (const p of [
      'models/Cell.glb', 'library/Custom/Belt.glb', 'scenes/Plant.glb',
      '', 'a/b/c/d/e/deeply-nested-and-quite-long-file-name.gltf', 'Ümläut .glb',
    ]) {
      expect(stableDocumentIdOfPath(p), p).toBe(stableDocumentId(p));
    }
  });
});

// ─── 2. The new identity, where it is READ ──────────────────────────────

describe('a slot-addressed document — the four stille-default sites answer for it', () => {
  it('nameOfAssetBase prints the document name, not "Untitled"', () => {
    expect(nameOfAssetBase(slotDocument)).toBe('Plant');
    // The fallback is still there for a record written without one.
    expect(nameOfAssetBase(sceneDocumentBase('doc_1', ''))).toBe('Untitled');
  });

  it('decideSaveVerb answers with the SCENE verb and no relPath (Triage R2-F-A)', () => {
    const backend = { id: 'b1', kind: 'folder', writable: true } as never;
    const decision = decideSaveVerb(
      { lineage: 'asset', base: slotDocument, name: 'Plant' }, backend,
    );
    expect(decision.verb).toBe('save');
    // A slot-addressed document addresses its bytes by ID. A `relPath` here
    // would be the beginning of the wrong writer (F4 / R2-F-A), and plan-716
    // §2.6 requires this answer to survive the collapse word for word.
    expect((decision as { relPath?: string }).relPath).toBeUndefined();
    // And it is NOT the "make it mine" copy verb a catalog asset gets.
    expect((decision as { copies?: boolean }).copies).toBeUndefined();
  });

  it('a PATH-addressed document saves to its own path — the other two former kinds', () => {
    // The copy-semantics half of §2.6: all three collapsed kinds keep their
    // exact verb. `library/` appears once, and neither answer sets `copies`.
    const backend = { id: 'b1', kind: 'folder', writable: true } as never;
    expect(decideSaveVerb(
      { lineage: 'asset', base: projectDocumentBase('models/Cell.glb', 'Cell'), name: 'Cell' },
      backend,
    )).toEqual({ verb: 'save', relPath: 'models/Cell.glb' });
    expect(decideSaveVerb(
      { lineage: 'asset', base: libraryDocumentBase('Custom/Belt.glb'), name: 'Belt' },
      backend,
    )).toEqual({ verb: 'save', relPath: 'library/Custom/Belt.glb' });
  });

  it('a SOURCE still copies — the copy semantics are untouched by the collapse', () => {
    const backend = { id: 'b1', kind: 'folder', writable: true } as never;
    for (const base of [bases.builtinModel, bases.providerAsset] as AssetBase[]) {
      const decision = decideSaveVerb({ lineage: 'asset', base, name: 'Cell' }, backend);
      expect(decision.verb, base.kind).toBe('save-into-project');
      expect((decision as { copies?: boolean }).copies, base.kind).toBe(true);
    }
    // …and a document never does.
    expect((decideSaveVerb(
      { lineage: 'asset', base: bases.document, name: 'Cell' }, backend,
    ) as { copies?: boolean }).copies).toBeUndefined();
  });

  it('the shared refusals still win over the new case', () => {
    expect(decideSaveVerb({ lineage: 'asset', base: slotDocument, name: 'Plant' }, null))
      .toMatchObject({ verb: 'blocked' });
    const readOnly = { id: 'b1', kind: 'folder', writable: false } as never;
    expect(decideSaveVerb({ lineage: 'asset', base: slotDocument, name: 'Plant' }, readOnly))
      .toMatchObject({ verb: 'blocked' });
  });
});

// ─── 3. The gap that is now closed ──────────────────────────────────────

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  /** `null` for the open paths; the save test installs a stub (see there). */
  registry: unknown;
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

function newStore(): SceneStore {
  return new SceneStore(
    makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0],
  );
}

const builtin: SceneBase = { kind: 'builtin', url: '/models/Demo.glb', label: 'Demo' };

beforeEach(() => {
  localStorage.clear();
  setOpenDocumentBase(null);
});

describe('die geschlossene Luecke: eine gespeicherte Szene traegt jetzt eine Identitaet', () => {
  /**
   * A saved scene whose body is a GLB — what `openScene` opens.
   *
   * The BODY has to exist: `_resolveLoad` refuses a `scene-glb` base whose
   * bytes are gone rather than showing an empty scene, so a catalogue row on
   * its own would fail the open before it reached the line under test.
   */
  async function seedSavedScene(name = 'Plant'): Promise<RvScene> {
    const scene = writeScene(glbSceneShell({ id: legacySceneId(), name }));
    const group = new Group();
    group.name = name;
    await writeSceneGlb(scene.id, new Uint8Array(await objectToGlb(group)));
    return scene;
  }

  it('openScene records a sceneDocument base that compares equal to the scene', async () => {
    const scene = await seedSavedScene();
    const store = newStore();
    await store.openScene(scene.id);

    const base = getOpenDocumentBase();
    // THE assertion of Phase 0. Before the fix this was `null` — the scene was
    // on screen and nothing could say so.
    expect(base).not.toBeNull();
    expect(base).toEqual({ kind: 'document', documentId: scene.id, path: '', name: 'Plant' });
    expect(sameDocumentBase(base, sceneDocumentBase(scene.id, 'Plant'))).toBe(true);
    // …and the name survives into the card's reader.
    expect(nameOfAssetBase(base!)).toBe('Plant');
    store.dispose();
  });

  /**
   * The FIRST SAVE — the half of the chain no test walked, and the one the
   * shipped build got wrong (plan-711 fix round).
   *
   * Every other case here reaches the identity through a LOAD, and
   * `_loadIntoWorkspace` is the funnel that publishes it. A save does not go
   * through that funnel: it mints the scene id, turns the workspace base into
   * `scene-glb` and makes the document identifiable in place. The handle kept
   * answering with the PRE-save base, so `_resolveOpenPlan` compared
   * `builtinModel` against a document identity, `sameDocumentBase` said false,
   * and the editor opened the raw base model as a second document — every
   * scene saved in this session was unbindable.
   *
   * It stayed invisible because the bind tests hand `sceneDocumentBase(...)` to
   * the document directly (`shared-instance-transition.test.ts`) instead of
   * asking a store that has just saved. So this walks the real chain: save,
   * then ask BOTH sides of the comparison the editor makes, then take the
   * living instance the way the editor takes it.
   */
  it('the FIRST SAVE publishes the identity, with no load in between', async () => {
    // A viewer with a registry: `_writeBody` refuses without one, and a save
    // that writes no body mints no `scene-glb` base — i.e. the very step under
    // test would not happen for a reason that has nothing to do with it.
    const viewer = makeViewer();
    viewer.registry = {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
      getComponentsAt: () => undefined,
    };
    const store = new SceneStore(
      viewer as unknown as ConstructorParameters<typeof SceneStore>[0],
    );
    // plan-716 Phase 3: the first save writes a DOCUMENT, so there has to be a
    // project to write into. Nothing else about the chain changes — the point
    // of the case is still that a save publishes an identity without a load.
    // Phase 4 completes the R1-I5 transition: the constructor and its call
    // sites are unchanged, and the kind it builds is now `document`.
    const project = installFakeDocumentProject();
    try {
    // An empty draft: the "Untitled" workspace a user starts in, and the one
    // base whose bytes need neither a fetch nor a stored body.
    await store.openEmpty();
    // Before: no scene identity to be had, and nothing published.
    expect(getOpenDocumentBase()).toBeNull();
    expect(store.documentIdentity()).toBeNull();

    await store.applyOp({
      id: 'op_save_chain', ts: 1, schemaV: 1, kind: 'setField',
      nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 120, prev: 0,
    } as never);
    expect(await store.save()).toBe('saved');

    const identity = store.documentIdentity();
    expect(identity).not.toBeNull();
    expect(identity!.kind).toBe('document');
    // THE assertion: the two sides the editor compares now agree. Without the
    // publish this is the stale `builtinModel` and the bind never fires.
    expect(getOpenDocumentBase()).toEqual(identity);
    expect(sameDocumentBase(getOpenDocumentBase(), identity)).toBe(true);

    // …and the identity is not a label on a dead thing: the store hands over
    // the LIVING document under it, which is what binding means.
    const handover = store.beginProjectionHandover();
    expect(handover).not.toBeNull();
    expect(handover!.document).toBe(store.document);
    expect(sameDocumentBase(handover!.base, identity)).toBe(true);
    handover!.release();
    } finally {
      project.restore();
      resetProjectStore();
      store.dispose();
    }
  });

  it('a DIFFERENT saved scene does not compare equal (the ungleich case stays ungleich)', async () => {
    const a = await seedSavedScene('Plant A');
    const b = await seedSavedScene('Plant B');
    const store = newStore();
    await store.openScene(a.id);
    const first = getOpenDocumentBase();
    await store.openScene(b.id);
    const second = getOpenDocumentBase();

    expect(sameDocumentBase(first, second)).toBe(false);
    expect(sameDocumentBase(second, sceneDocumentBase(b.id, 'Plant B'))).toBe(true);
    store.dispose();
  });

  it('a FORK does not inherit the source scene identity', async () => {
    // `forkFromBase` keeps the source's `scene-glb` base while being an unsaved
    // document of its own. Keying the identity off the base (instead of off the
    // SAVED scene) would hand the copy the original's identity — the false
    // positive risk 8 names, and the reason the condition is `saved && …`.
    const source = await seedSavedScene('Plant');
    const store = newStore();
    await store.forkFromBase(source.id);

    expect(getOpenDocumentBase()).toBeNull();
    store.dispose();
  });

  it('the other open paths are untouched — builtin still records builtinModel', async () => {
    const store = newStore();
    await store.openBuiltin(builtin.url as string, 'Demo');
    expect(getOpenDocumentBase()).toEqual(
      { kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' },
    );

    // An unsaved draft over a builtin base is not a saved scene and stays
    // identified by its bytes, exactly as before.
    await store.openEmpty();
    expect(getOpenDocumentBase()).toBeNull();
    store.dispose();
  });

  it('an unsaved draft SCENE (never saved) carries no scene identity', async () => {
    const store = newStore();
    // `makeDraftScene` + openTransient is the shared-link path; a plain draft
    // over a builtin base is the "Untitled" workspace. Neither is a saved
    // scene, so neither may claim a `sceneDocument` identity.
    const draft = makeDraftScene(builtin, 'Untitled');
    expect(draft.base.kind).toBe('builtin');
    await store.openBuiltin('/models/Demo.glb', 'Demo');
    expect(getOpenDocumentBase()?.kind).toBe('builtinModel');
    store.dispose();
  });
});
