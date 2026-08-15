// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * published-examples-glb — plan-413 §9.3.
 *
 * The Examples shelf end to end, against the bytes that are actually shipped:
 * the committed `public/scenes/*.glb` are served by the same dev server that
 * hosts this test, so `fetch('/scenes/index.json')` here is the fetch the boot
 * routine makes. That is the point — a catalogue that still said `.scene.glb`,
 * or a GLB that never got committed, fails here and nowhere else.
 *
 * What is pinned:
 *   1. the shipped catalogue lists GLBs and parses into entries;
 *   2. the shipped example files are GLBs carrying their classification;
 *   3. opening one is the ordinary GLB path — a transient scene over the
 *      example URL, no fetch and no op log in the store;
 *   4. "Add to My Scenes" copies the BYTES (compared byte for byte) into the
 *      user's own body slot and writes a v3 catalogue row with an empty op log;
 *   5. `BundledBackend.readScene()` answers a GLB `SceneRecord` for it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import {
  parsePublishedIndex,
  publishedSceneUrl,
  type PublishedSceneEntry,
} from '../src/core/hmi/scene/rv-published-scenes';
import { listMetas, readScene } from '../src/core/hmi/scene/rv-scene-storage';
import { readSceneGlbBody } from '../src/core/hmi/scene/rv-scene-glb-io';
import { classificationOfGlbBlob } from '../src/core/project/rv-project-documents';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';

/** The catalogue as the deploy publishes it. */
async function shippedCatalogue(): Promise<PublishedSceneEntry[]> {
  const resp = await fetch('/scenes/index.json', { cache: 'no-store' });
  expect(resp.ok).toBe(true);
  return parsePublishedIndex(await resp.json());
}

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

function makeViewer(published: PublishedSceneEntry[]): FakeViewer {
  const v: FakeViewer = {
    availableModels: [],
    availablePublishedScenes: published,
    currentScene: null,
    currentModelUrl: null,
    modes: { has: () => true, setMode: vi.fn() },
    loadScene: vi.fn(async (s: RvScene) => { v.currentScene = s; }),
    loadEmptyScene: vi.fn(async () => { v.currentScene = null; }),
    getPlugin: () => undefined,
  };
  return v;
}

describe('published examples are GLBs (plan-413 §9.3)', () => {
  let catalogue: PublishedSceneEntry[];

  beforeEach(async () => {
    localStorage.clear();
    catalogue = await shippedCatalogue();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('the shipped catalogue lists .glb entries and parses into examples', () => {
    expect(catalogue.length).toBeGreaterThan(0);
    for (const e of catalogue) {
      expect(e.file).toMatch(/\.glb$/i);
      expect(e.urlName).not.toMatch(/\./);
      expect(e.label.length).toBeGreaterThan(0);
    }
  });

  it('every shipped example is a GLB that says it is a scene', async () => {
    for (const e of catalogue) {
      const resp = await fetch(publishedSceneUrl(e.file), { cache: 'no-store' });
      expect(resp.ok, `${e.file} is served`).toBe(true);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      // 'glTF' — not a JSON body wearing a .glb name.
      expect(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)).toBe(0x46546c67);
      // The classification travels in the bytes (phase 1) and was stamped by the
      // bake (phase 3).
      const classification = await classificationOfGlbBlob(new Blob([bytes as BlobPart]));
      expect(classification, `${e.file} carries a classification`).toBeTruthy();
      expect(classification?.level).toBe('scene');
    }
  });

  it('opening an example is the ordinary GLB path — transient, no op log, no fetch', async () => {
    const viewer = makeViewer(catalogue);
    const store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
    const spy = vi.spyOn(globalThis, 'fetch');

    await store.openPublishedExample(catalogue[0]);

    // The store hands a URL to the loader; it does not read the file itself.
    expect(spy).not.toHaveBeenCalled();
    const snap = store.getSnapshot();
    expect(snap.transient).toBe(true);
    expect(snap.draft?.edits.ops).toEqual([]);
    expect(snap.draft?.base).toMatchObject({ kind: 'builtin' });
    expect((snap.draft?.base as { url: string }).url).toContain(catalogue[0].file);
    // Read-only: nothing of the visitor's was written.
    expect(listMetas()).toEqual([]);
    store.dispose();
  });

  it('"Add to My Scenes" copies the bytes and writes a v3 row with no op log', async () => {
    const viewer = makeViewer(catalogue);
    const store = new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
    const entry = catalogue[0];

    const source = new Uint8Array(
      await (await fetch(publishedSceneUrl(entry.file), { cache: 'no-store' })).arrayBuffer(),
    );

    const id = await store.addPublishedToMyScenes(entry);

    // 1. The bytes are a copy, not a re-encode: compared in full.
    const body = await readSceneGlbBody(id);
    expect(body).toBeTruthy();
    expect(body!.glb.byteLength).toBe(source.byteLength);
    expect(Array.from(body!.glb)).toEqual(Array.from(source));

    // 2. The row is a v3 shell over that body — no JSON op log anywhere.
    const row = readScene(id)!;
    expect(row.schemaVersion).toBe(3);
    expect(row.base).toMatchObject({ kind: 'scene-glb', sceneId: id });
    expect(row.edits.ops).toEqual([]);

    // 3. The classification cache on the row came out of the copied bytes.
    expect(row.classification?.level).toBe('scene');
    expect(listMetas().find(m => m.id === id)?.classification?.level).toBe('scene');
    store.dispose();
  });

  it('BundledBackend.readScene answers a GLB SceneRecord for an example', async () => {
    const entry = catalogue[0];
    const backend = new BundledBackend({
      baseUrl: '/',
      publishedScenes: catalogue,
      // The deploy root of this test IS the dev server, so the real fetch is
      // the honest implementation here.
      fetchImpl: fetch.bind(globalThis),
    });

    const scenes = sceneDocumentsOf(await backend.readManifest());
    const meta = scenes.find(s => s.path.endsWith(entry.file));
    expect(meta, 'the example is a manifest scene entry').toBeTruthy();

    const record = await backend.readScene(meta!.path);
    expect(record).toBeTruthy();
    expect(record!.glb).toBeTruthy();
    expect(new DataView(record!.glb.buffer, record!.glb.byteOffset, 4).getUint32(0, true))
      .toBe(0x46546c67);
  });
});
