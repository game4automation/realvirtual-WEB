// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneStore — an "Example" is a DOCUMENT (plan-731 Phase 2, F3/F4).
 *
 * This file used to specify a parallel world: `listPublished()` mirrored a
 * second catalogue into the snapshot, `openPublishedExample()` opened one
 * TRANSIENTLY under a `published:<urlName>` marker, and
 * `materializePublishedExample()` copied it into a document so it could finally
 * be a first-class artefact. All four — the list, the marker, and the two verbs
 * — were the second document identity space.
 *
 * plan-731 kept the BEHAVIOUR and dropped the space. What used to be
 * "materialise this source into a document" is the state an example is already
 * in: a `documents[]` row, opened by `openDocument()`. So what is specified
 * here now is that the one open verb still does the two things the example verb
 * did — it applies the row's declared workspace mode, and it leaves the
 * visitor's own storage alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';
import { documentsOf } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

/** The example, as `public/project.json` carries it: a row, with a mode. */
const EXAMPLE: RvDocumentEntry = {
  id: 'doc_demoplanner_gf4m6v',
  name: 'Planner Demo',
  path: 'DemoPlanner.glb',
  section: 'scenes',
  mode: 'planner',
};

/** A row with no declared mode — the shape of every ordinary document. */
const PLAIN: RvDocumentEntry = {
  id: 'doc_plain_1',
  name: 'Plain Model',
  path: 'Plain.glb',
  section: 'models',
};

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  modes: { has: (id: string) => boolean; setMode: (id: string) => void };
  loadScenes: RvScene[];
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    loadScenes: [],
    availableModels: [],
    currentScene: null,
    currentModelUrl: null,
    modes: { has: (id: string) => id === 'planner', setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene) => { v.loadScenes.push(s); v.currentScene = s; }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

describe('SceneStore — an example is an ordinary document', () => {
  let viewer: FakeViewer;
  let store: SceneStore;
  let project: FakeDocumentProject;

  beforeEach(() => {
    localStorage.clear();
    viewer = makeViewer();
    project = installFakeDocumentProject({ documents: [EXAMPLE, PLAIN] });
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    store.dispose();
    project.restore();
    vi.restoreAllMocks();
  });

  it('the snapshot carries no second list beside the documents', () => {
    // `published` and `activePublishedName` were the snapshot's half of the
    // second identity space. Both are gone; `builtins` (the model catalogue
    // mirror, a genuinely different thing) stays.
    const snap = store.getSnapshot() as unknown as Record<string, unknown>;
    expect('published' in snap).toBe(false);
    expect('activePublishedName' in snap).toBe(false);
    expect('builtins' in snap).toBe(true);
  });

  it('the store has no second open verb', () => {
    const s = store as unknown as Record<string, unknown>;
    expect(s.listPublished).toBeUndefined();
    expect(s.openPublished).toBeUndefined();
    expect(s.openPublishedExample).toBeUndefined();
    expect(s.materializePublishedExample).toBeUndefined();
  });

  it('openDocument loads the example and applies its declared mode', async () => {
    await store.openDocument(EXAMPLE.id);

    const snap = store.getSnapshot();
    expect(snap.draft?.name).toBe('Planner Demo');
    expect(snap.draft?.base).toMatchObject({ kind: 'builtin' });
    // The mode the catalogue used to carry, now carried by the row (2e).
    expect(viewer.modes.setMode).toHaveBeenCalledWith('planner');
  });

  it('a row without a declared mode changes no mode', async () => {
    await store.openDocument(PLAIN.id);
    expect(viewer.modes.setMode).not.toHaveBeenCalled();
  });

  it('an unknown mode is warned about, not applied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    project.restore();
    project = installFakeDocumentProject({
      documents: [{ ...EXAMPLE, mode: 'no-such-mode' }],
    });
    await store.openDocument(EXAMPLE.id);
    expect(viewer.modes.setMode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('opening it writes no My-Scenes catalogue row', async () => {
    // The property the transient open existed for. It still holds — for the
    // reason it always should have: the catalogue it would have written to has
    // not existed since plan-716.
    await store.openDocument(EXAMPLE.id);
    expect(listMetas()).toEqual([]);
  });

  it('the address bar carries ?doc=, never ?scene=published:', async () => {
    const before = window.location.href;
    try {
      await store.openDocument(EXAMPLE.id);
      const params = new URL(window.location.href).searchParams;
      expect(params.get('doc')).toBe(EXAMPLE.id);
      expect(params.get('scene')).toBeNull();
    } finally {
      window.history.replaceState(window.history.state, '', before);
    }
  });

  it('"make it mine" is the ordinary copy verb — one of them, not two', () => {
    // `materializePublishedExample()` is gone (asserted above). What it did — a
    // named copy the user owns, with a manifest row from its first instant — is
    // what `saveAs` and `duplicate` do, and `saveAs` is the seam plan-716
    // Phase 6 had already routed it through internally. Here we pin only that
    // the general verbs are the ones left standing; what they WRITE is
    // specified where they are tested (`scene-save-as-name`,
    // `scene-save-into-document`), and duplicating those assertions against
    // this example row would be a second specification of one behaviour — the
    // very thing this plan removed.
    expect(typeof store.saveAs).toBe('function');
    expect(typeof store.duplicate).toBe('function');
  });

  it('the example row is a document like any other, from the manifest out', async () => {
    const rows = documentsOf(project.project());
    expect(rows.map(r => r.id)).toContain(EXAMPLE.id);
    // Addressable by the one id, openable by the one verb — the whole of F3.
    await store.openDocument(EXAMPLE.id);
    expect(store.getSnapshot().draft?.name).toBe('Planner Demo');
  });
});
