// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-test-joins-placements — plan-769 Phase 7, test 9.26 (D24, debug-028
 * Bug 2).
 *
 * The editor's in-place test run exports the authoring tree (own content plus
 * EMPTY reference nodes) and loads that blob with the runtime flags. The placed
 * assets materialise AFTER `loadModel` resolves — their drives are pushed to
 * `viewer.drives` only then (`rv-placement-integrate.ts`). `start()` used to
 * declare `running` right after `loadModel`, so a document whose drives live in
 * its placements reported a running test with an empty drive list
 * (`homebot-main`: 18 drives, `drive list` → `[]`).
 *
 * Real objects: the viewer with its real loader (the placed asset is a `data:`
 * url), a real `AssetDocument`, the real `InPlaceTestSession` and the real GLB
 * export.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Group } from 'three';
import { InPlaceTestSession } from '@rv-private/plugins/asset-editor/in-place-test-session';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { loadAuthoringModel } from '../src/core/editor/rv-authoring-load';
import { _resetSceneTransition } from '../src/core/hmi/scene-transition-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { objectToGlb } from '../src/core/import/rv-import-object';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { findByName, innerDataUrl, plainBytes, referenceNode } from './helpers/nested-placement-fixture';

type Viewer = TestViewerHandle['viewer'];

let handle: TestViewerHandle | null = null;
/** Opens the decode gate of the placed asset (see {@link bootGatedViewer}). */
let openGate: () => void = () => {};

/**
 * A real viewer whose placed-asset DECODE waits for {@link openGate}: the real
 * `GLTFLoader` byte path behind a gate, so "the placement has not arrived yet"
 * is a state the test holds instead of a race it hopes to win.
 */
async function bootGatedViewer(): Promise<Viewer> {
  handle = await createTestViewer('webgl');
  const viewer = handle.viewer;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  openGate = release;
  const gated = {
    parseAsync: async (data: ArrayBuffer, path: string) => {
      await gate;
      return gltfLoader.parseAsync(data, path);
    },
  } as unknown as GLTFLoader;
  viewer.placements.setModelCache(new ModelCache(gated, {
    uber: () => viewer.placementUberMaterial,
    isWebGPU: () => viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  viewer.setSimulationPaused('editor-test-joins', true);
  return viewer;
}
let doc: AssetDocument | null = null;
let session: InPlaceTestSession | null = null;

/** An authoring document whose only drive lives in its placement `Cell_1`. */
async function documentWithPlacement(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Machine';
  root.add(referenceNode('Cell_1', 'plc-cell', await innerDataUrl(), true, [3, 0, 0], 'cat:cell'));
  return objectToGlb(root);
}

/**
 * The editor holds the document. Its placed asset is still decoding (the gate
 * is closed) — the state of a big placement, or of a test run whose placed
 * asset is not in the cache: the test scene's placements arrive after its load.
 */
async function openInEditor(): Promise<Viewer> {
  const viewer = await bootGatedViewer();
  const bytes = await documentWithPlacement();
  const opened = await loadAuthoringModel(viewer, 'Machine.glb', { identity: {}, keepBaked: true, data: bytes, budgetMs: 0 });
  expect(opened.ok, 'precondition: the editor document is open').toBe(true);
  expect(findByName(viewer.currentModelRoot!, 'Slide'), 'precondition: the placed asset has not arrived').toBeNull();
  doc = scratchAssetDocument(viewer, 'Machine');
  session = new InPlaceTestSession({ viewer, getDocument: () => doc });
  return viewer;
}

/** Drives that live inside the placement `Cell_1`. */
function placedDrives(viewer: Viewer): string[] {
  const cell = findByName(viewer.currentModelRoot!, 'Cell_1');
  if (!cell) return [];
  return viewer.drives.filter((d) => {
    for (let n: typeof d.node | null = d.node; n; n = n.parent) if (n === cell) return true;
    return false;
  }).map((d) => d.node.name);
}

beforeEach(async () => {
  _resetSceneTransition();
  await __clearDraftStoresForTests();
});

afterEach(() => {
  session?.dispose();
  session = null;
  doc?.dispose();
  doc = null;
  openGate();
  handle?.dispose();
  handle = null;
});

describe('the editor test run starts on the finished scene (D24)', () => {
  it('at `running` the placed content is there and its drives exist', async () => {
    const viewer = await openInEditor();

    const starting = session!.start();
    // The start must still be waiting for the placed asset — then it arrives.
    await new Promise((r) => setTimeout(r, 150));
    expect(session!.state, 'not running before the placed content exists').toBe('preparing');
    openGate();
    await starting;

    expect(session!.state).toBe('running');
    expect(viewer.runtime.isEditorTestActive).toBe(true);
    expect(placedDrives(viewer)).toEqual(['Slide']);
    expect(viewer.placements.progress).toMatchObject({ pending: 0, missing: 0 });
  });

  it('a document switch while the test scene joins its placements: the start aborts — no run, no lock, nothing attached', async () => {
    const viewer = await openInEditor();
    const other = await plainBytes();
    // The join right after the test scene's load is the moment another
    // document takes the viewer (a user opening something else). Earlier calls
    // (inside the load itself) are left alone.
    const loadModel = viewer.loadModel.bind(viewer);
    const whenSceneReady = viewer.whenSceneReady.bind(viewer);
    let testSceneLoaded = false;
    let switched: Promise<unknown> | null = null;
    viewer.loadModel = (async (url: string, options?: Parameters<typeof loadModel>[1]) => {
      const result = await loadModel(url, options);
      if (url.startsWith('blob:')) testSceneLoaded = true;
      return result;
    }) as typeof viewer.loadModel;
    viewer.whenSceneReady = () => {
      if (testSceneLoaded && !switched) switched = loadModel('Other.glb', { data: other.slice(0) });
      return whenSceneReady();
    };

    openGate();
    await session!.start();
    await switched;

    expect(switched, 'the switch happened during the start').not.toBeNull();
    expect(session!.state).toBe('idle');
    expect(viewer.runtime.isEditorTestActive).toBe(false);
    expect(doc!.lockOwner).toBeNull();
    expect(findByName(viewer.currentModelRoot!, 'Cell_1'), 'the other document is on screen').toBeNull();
    expect(viewer.drives).toEqual([]);
  });
});
