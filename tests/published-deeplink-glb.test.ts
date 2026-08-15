// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * published-deeplink-glb — plan-413 §9.10 (SOL R1-3).
 *
 * `?scene=published:<name>` used to run PAST the Examples catalogue: the boot
 * routine fetched `scenes/<name>.scene.json` itself and handed the parsed
 * object to `openPublished()`. Deleting the JSONs would therefore have broken
 * every mailed example link while the Examples shelf kept working — a defect
 * that would have surfaced in somebody's inbox, not in a test.
 *
 * The deep link now resolves against the catalogue and loads a GLB. The boot
 * routine itself is not reachable from a test (a 1500-line `init()`), so its
 * decision was extracted into `resolvePublishedDeepLink()` and is tested here
 * beside the two things it drives: the store's `openPublished()`, and the
 * existence probe that decides between "open it" and "fall through".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import {
  publishedSceneUrl,
  resolvePublishedDeepLink,
  type PublishedSceneEntry,
} from '../src/core/hmi/scene/rv-published-scenes';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';

const entry: PublishedSceneEntry = {
  file: 'DemoPlanner.glb',
  urlName: 'DemoPlanner',
  label: 'Planner Demo',
  mode: 'planner',
};

interface FakeViewer {
  loadScene: (s: RvScene) => Promise<void>;
  loadEmptyScene: () => Promise<void>;
  getPlugin: <T>(id: string) => T | undefined;
  availableModels: { url: string; label: string }[];
  availablePublishedScenes: PublishedSceneEntry[];
  currentScene: RvScene | null;
  currentModelUrl: string | null;
  modes: { has: (id: string) => boolean; setMode: (id: string) => void };
}

function makeViewer(opts: { failLoad?: boolean } = {}): FakeViewer {
  const v: FakeViewer = {
    availableModels: [],
    availablePublishedScenes: [entry],
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

describe('?scene=published:<name> loads a GLB (plan-413 §9.10)', () => {
  let store: SceneStore;
  let viewer: FakeViewer;
  const originalUrl = window.location.href;

  beforeEach(() => {
    localStorage.clear();
    viewer = makeViewer();
    store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
  });

  afterEach(() => {
    store.dispose();
    vi.restoreAllMocks();
    window.history.replaceState(window.history.state, '', originalUrl);
  });

  it('routes a catalogued name to its GLB and stamps the address bar', async () => {
    const link = resolvePublishedDeepLink('DemoPlanner', viewer.availablePublishedScenes);
    expect(link.catalogued).toBe(true);
    expect(link.file).toBe('DemoPlanner.glb');

    await store.openPublished(publishedSceneUrl(link.file), 'DemoPlanner', link.label);

    const loaded = viewer.currentScene!;
    expect(loaded.base.kind).toBe('builtin');
    expect((loaded.base as { url: string }).url).toMatch(/scenes\/DemoPlanner\.glb$/);
    expect(new URL(window.location.href).searchParams.get('scene'))
      .toBe('published:DemoPlanner');
    // Transient: the visitor's own storage is untouched.
    expect(store.getSnapshot().transient).toBe(true);
    expect(listMetas()).toEqual([]);
  });

  it('never parses JSON on the way in', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await store.openPublished(publishedSceneUrl(entry.file), entry.urlName);
    // The old path did `resp.json()` here. There is no request at all now: the
    // URL goes to the model loader and the loader owns the transfer.
    expect(spy).not.toHaveBeenCalled();
  });

  it('an unknown name is not catalogued — the boot chain continues', () => {
    const link = resolvePublishedDeepLink('NoSuchExample', viewer.availablePublishedScenes);
    expect(link.catalogued).toBe(false);
    expect(link.file).toBe('NoSuchExample.glb');
    // `main.ts` opens only on `catalogued`, so nothing is opened and nothing is
    // written; the default model resolution below it takes over.
    expect(store.getSnapshot().draft).toBeNull();
    expect(listMetas()).toEqual([]);
  });

  it('an HTTP probe could not decide this — which is why the catalogue does', async () => {
    // The reason `main.ts` has no existence probe: the dev server hosting this
    // test, like any SPA host with a history fallback, answers 200 with
    // index.html for a scene file that does not exist. A probe would have opened
    // a deep link to nothing and produced a broken boot instead of a fall-through.
    const resp = await fetch(publishedSceneUrl('NoSuchExample.glb'), { cache: 'no-store' });
    expect(resp.ok).toBe(true);
    expect((await resp.text()).slice(0, 4)).not.toBe('glTF');
  });

  it('a failing load leaves the workspace and the address bar untouched', async () => {
    await store.newEmpty();
    const before = new URL(window.location.href).searchParams.get('scene');
    const failing = new SceneStore(
      makeViewer({ failLoad: true }) as unknown as ConstructorParameters<typeof SceneStore>[0],
    );
    await failing.newEmpty().catch(() => {});
    await expect(
      failing.openPublished(publishedSceneUrl(entry.file), entry.urlName),
    ).rejects.toThrow();
    // `openPublished` stamps the URL only AFTER a successful transient open.
    expect(new URL(window.location.href).searchParams.get('scene')).toBe(before);
    expect(failing.getSnapshot().activePublishedName).toBeNull();
    failing.dispose();
  });
});
