// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneStore — "Examples" (published scene) behaviour.
 *
 * Covers the catalogue mirror, transient open (read-only, no localStorage),
 * preferred-mode switching, and the "Add to My Scenes" import that turns a
 * read-only demo into an editable user-owned scene.
 *
 * Rewritten for plan-413 phase 3: an Example is a GLB, so opening one hands a
 * URL to the model loader instead of parsing an op log, and importing one
 * copies bytes instead of cloning a record.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { PublishedSceneEntry } from '../src/core/hmi/scene/rv-published-scenes';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';
import { buildEmptyGlbBlob } from '../src/core/hmi/scene/empty-glb';
import { documentsOf } from '../src/core/project/rv-project-documents';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

const entry: PublishedSceneEntry = {
  file: 'DemoPlanner.glb',
  urlName: 'DemoPlanner',
  label: 'Planner Demo',
  mode: 'planner',
};

/** Bytes of an example, as the deploy would serve them. */
let exampleGlb: Uint8Array;

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  availablePublishedScenes: PublishedSceneEntry[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  modes: { has: (id: string) => boolean; setMode: (id: string) => void };
  loadScenes: RvScene[];
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loadScenes: [],
    availableModels: [],
    availablePublishedScenes: [entry],
    currentScene: null,
    currentModelUrl: null,
    modes: { has: (id: string) => id === 'planner', setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene) => { v.loadScenes.push(s); v.currentScene = s; }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

describe('SceneStore — Examples / published scenes', () => {
  let viewer: FakeViewer;
  let store: SceneStore;

  beforeEach(async () => {
    localStorage.clear();
    viewer = makeViewer();
    exampleGlb = new Uint8Array(await buildEmptyGlbBlob().arrayBuffer());
    // A `Response` body reads once, so every call gets a fresh one — repeated
    // imports are one of the cases under test.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response(exampleGlb.slice() as unknown as BodyInit, { status: 200 }),
    );
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mirrors viewer.availablePublishedScenes into the snapshot', () => {
    expect(store.getSnapshot().published).toEqual([entry]);
    expect(store.listPublished()).toEqual([entry]);
  });

  it('openPublishedExample loads the GLB transiently and switches mode, no localStorage write', async () => {
    await store.openPublishedExample(entry);

    // Not persisted as a My Scene.
    expect(listMetas()).toHaveLength(0);
    // Loaded into the workspace as a fresh (unsaved) draft over the example URL.
    const snap = store.getSnapshot();
    expect(snap.isDraft).toBe(true);
    expect(snap.saved).toBeNull();
    expect(snap.draft?.name).toBe('Planner Demo');
    expect(snap.draft?.base).toMatchObject({ kind: 'builtin' });
    expect((snap.draft?.base as { url: string }).url).toMatch(/scenes\/DemoPlanner\.glb$/);
    expect(viewer.loadScene).toHaveBeenCalledTimes(1);
    // Preferred mode applied.
    expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
    // The open example is marked active so its row can highlight.
    expect(snap.activePublishedName).toBe('DemoPlanner');
  });

  it('opening an example fetches nothing itself — the loader owns the bytes', async () => {
    await store.openPublishedExample(entry);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('opening another scene clears the active-example marker', async () => {
    await store.openPublishedExample(entry);
    expect(store.getSnapshot().activePublishedName).toBe('DemoPlanner');
    await store.newEmpty();
    expect(store.getSnapshot().activePublishedName).toBeNull();
  });

  it('rejects an import whose bytes are not a GLB', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      async () => new Response('{"schemaVersion":2}', { status: 200 }),
    );
    await expect(store.addPublishedToMyScenes(entry)).rejects.toThrow(/not a GLB/);
    expect(listMetas()).toHaveLength(0);
  });

  // ── "Make the demo mine" materialises a DOCUMENT (plan-716 F1, Phase 6) ──
  //
  // Importing an example was the last place in the product that minted a `scn_`
  // id and wrote a catalogue row. It goes through the same create seam as "New"
  // and `saveAs` now, so these three cases need a project to write into — which
  // is the point: after Phase 1 there always is one, and a copy the user made
  // his own is a file in it rather than a second-class artefact.

  describe('addPublishedToMyScenes — a source materialises a document', () => {
    let project: FakeDocumentProject;

    beforeEach(() => { project = installFakeDocumentProject(); });
    afterEach(() => { project.restore(); });

    it('places a document under the example label and opens it', async () => {
      const id = await store.addPublishedToMyScenes(entry);

      const rows = documentsOf(project.project());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(id);
      expect(rows[0]!.name).toBe('Planner Demo');
      expect(rows[0]!.path).toBe('scenes/Planner Demo.glb');
      // The example's own bytes, copied — not an empty GLB.
      expect(project.files.get('scenes/Planner Demo.glb')).toEqual(exampleGlb);
      // Nothing landed in the catalogue that used to carry it.
      expect(listMetas()).toEqual([]);

      // Preferred mode applied for the opened copy too.
      expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
      // The opened copy is the user's own document, not the transient example.
      expect(store.getSnapshot().activePublishedName).toBeNull();
    });

    it('mints a document id, never a scene id', async () => {
      const id = await store.addPublishedToMyScenes(entry);
      expect(id.startsWith('scn_')).toBe(false);
      expect(documentsOf(project.project()).map(d => d.id)).toEqual([id]);
    });

    it('probes the name on repeated imports rather than overwriting', async () => {
      await store.addPublishedToMyScenes(entry);
      await store.addPublishedToMyScenes(entry);
      await store.addPublishedToMyScenes(entry);
      expect(documentsOf(project.project()).map(d => d.name).sort())
        .toEqual(['Planner Demo', 'Planner Demo 2', 'Planner Demo 3']);
    });

    it('says so when there is nowhere to import into, and writes nothing', async () => {
      project.restore();     // a read-only deploy: no writable backend at all
      await expect(store.addPublishedToMyScenes(entry)).rejects.toThrow(/writable project/i);
      expect(listMetas()).toEqual([]);
      project = installFakeDocumentProject();   // so afterEach has one to restore
    });
  });

  // ─── F12: delivery must keep working after plan-397 ─────────────────────

  describe('Beispiel-Szenen sind transient — auch gegenüber GLB-Körpern', () => {
    it('lädt NICHT den Draft-Körper des Besuchers statt des Beispiels', async () => {
      // The shape that made this necessary: a transient open that probes a body
      // slot would serve the visitor's own draft in place of the example. The
      // example's base is now its own URL, so the slot is not even a candidate —
      // this pins that it stays that way.
      const { writeSceneGlb } = await import('../src/core/storage/rv-scene-glb-store');
      const { objectToGlb } = await import('../src/core/import/rv-import-object');
      const { Group } = await import('three');

      const intruder = new Group();
      intruder.name = 'VisitorsOwnWork';
      await writeSceneGlb('draft/empty', new Uint8Array(await objectToGlb(intruder)));

      await store.openPublishedExample(entry);

      // The example URL was loaded, not the visitor's draft body.
      const loaded = viewer.currentScene!;
      expect(loaded.base.kind).toBe('builtin');
      expect((loaded.base as { url: string }).url).toMatch(/scenes\/DemoPlanner\.glb$/);
      // A published scene is read-only: still nothing written to My Scenes.
      expect(listMetas()).toEqual([]);
    });
  });

});
