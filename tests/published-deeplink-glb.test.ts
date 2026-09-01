// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `?scene=published:<name>` — the legacy deep link (plan-731 Phase 2, F3/F4).
 *
 * plan-413 §9.10 put this file here to pin that a mailed example link kept
 * working when the examples became GLBs. The link is older than the catalogue
 * that used to answer it and has to outlive it too — somebody's inbox is where
 * a break would surface, not a test — so the same guarantee is pinned again
 * against the thing that answers it now.
 *
 * What changed underneath: the CATALOGUE used to decide, and what it opened was
 * a TRANSIENT under a `published:<urlName>` marker. The MANIFEST decides now,
 * and what it opens is a document. That is the whole of the identity-space
 * collapse, seen from the one place a stranger touches it.
 *
 * The boot routine itself is not reachable from a test (a 1500-line `init()`),
 * so its decision lives in `resolvePublishedSceneParam()` and is tested here
 * beside the store verb it drives.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { resolvePublishedSceneParam } from '../src/core/hmi/scene/rv-published-scenes';
import { sceneUrlToDocumentUrl } from '../src/core/project/rv-doc-alias';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';
import { documentsOf } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

const EXAMPLE: RvDocumentEntry = {
  id: 'doc_demoplanner_gf4m6v',
  name: 'Planner Demo',
  path: 'DemoPlanner.glb',
  section: 'scenes',
  mode: 'planner',
};

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  modes: { has: (id: string) => boolean; setMode: (id: string) => void };
}

function makeViewer(opts: { failLoad?: boolean } = {}): FakeViewer {
  const v: FakeViewer = {
    availableModels: [],
    currentScene: null,
    currentModelUrl: null,
    modes: { has: () => true, setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene) => {
      if (opts.failLoad) throw new Error('the model file could not be read');
      v.currentScene = s;
    }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

describe('?scene=published:<name> resolves through the alias', () => {
  let store: SceneStore;
  let viewer: FakeViewer;
  let project: FakeDocumentProject;
  const originalUrl = window.location.href;

  beforeEach(() => {
    localStorage.clear();
    viewer = makeViewer();
    project = installFakeDocumentProject({ documents: [EXAMPLE] });
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    store.dispose();
    project.restore();
    vi.restoreAllMocks();
    window.history.replaceState(window.history.state, '', originalUrl);
  });

  it('an old link finds the document the manifest carries', () => {
    const docs = documentsOf(project.project());
    const hit = resolvePublishedSceneParam('published:DemoPlanner', docs);
    expect(hit?.id).toBe(EXAMPLE.id);
    // The load-bearing claim of F3: the id the OLD address resolves to is the
    // same id the NEW address carries. One space, reached from two doors.
    expect(hit?.id).toBe(docs.find(d => d.path === 'DemoPlanner.glb')?.id);
  });

  it('opening it stamps ?doc= into the address bar, not ?scene=', async () => {
    const hit = resolvePublishedSceneParam(
      'published:DemoPlanner', documentsOf(project.project()),
    )!;
    // What `main.ts` does with the hit: normalise, then open.
    window.history.replaceState({}, '', sceneUrlToDocumentUrl(window.location.href, hit.id));
    await store.openDocument(hit.id, { name: hit.name });

    const params = new URL(window.location.href).searchParams;
    expect(params.get('doc')).toBe(EXAMPLE.id);
    expect(params.get('scene')).toBeNull();

    const loaded = viewer.currentScene!;
    expect(loaded.base.kind).toBe('builtin');
    expect((loaded.base as { url: string }).url).toMatch(/DemoPlanner\.glb$/);
  });

  it('the row carries the preferred mode the catalogue used to carry', () => {
    const hit = resolvePublishedSceneParam(
      'published:DemoPlanner', documentsOf(project.project()),
    );
    expect(hit?.mode).toBe('planner');
  });

  it('an unknown name resolves to nothing — the boot chain continues', () => {
    // Replaces `catalogued: false`. `main.ts` opens only on a hit, so nothing is
    // opened and nothing is written; default model resolution takes over.
    expect(resolvePublishedSceneParam(
      'published:NoSuchExample', documentsOf(project.project()),
    )).toBeNull();
    expect(store.getSnapshot().draft).toBeNull();
    expect(listMetas()).toEqual([]);
  });

  it('an HTTP probe could not decide this — which is why the manifest does', async () => {
    // The reason the boot has no existence probe, unchanged by this plan: the
    // dev server hosting this test, like any SPA host with a history fallback,
    // answers 200 with index.html for a file that does not exist. A probe would
    // have opened a deep link to nothing instead of falling through.
    const resp = await fetch('/NoSuchExample.glb', { cache: 'no-store' });
    expect(resp.ok).toBe(true);
    expect((await resp.text()).slice(0, 4)).not.toBe('glTF');
  });

  it('a failing load leaves the address bar untouched', async () => {
    const before = new URL(window.location.href).searchParams.get('doc');
    const failing = new SceneStore(
      makeViewer({ failLoad: true }) as unknown as ConstructorParameters<typeof SceneStore>[0],
    );
    await expect(failing.openDocument(EXAMPLE.id)).rejects.toThrow();
    expect(new URL(window.location.href).searchParams.get('doc')).toBe(before);
    failing.dispose();
  });

  it('a name the manifest does not carry writes nothing at all', () => {
    expect(resolvePublishedSceneParam('published:Whatever', [])).toBeNull();
    expect(listMetas()).toEqual([]);
  });
});
