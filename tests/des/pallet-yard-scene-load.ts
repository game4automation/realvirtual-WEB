// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * pallet-yard-scene-load.ts — load the REAL scenes/PalletYard.glb the way the
 * viewer does, for the plan-612 tests that bind a DESRunner to it.
 *
 * Since CP1d-b the stackers and conveyors are PLACEMENTS (library references):
 * `loadGLB` alone leaves their reference nodes empty. This helper goes through
 * a real test viewer — `loadModel` → deferred placements → `PlacementInstancer`
 * → `whenSceneReady` — and hands back the model root plus a DES bind host built
 * from the viewer's own signal store, drives and registry (what the tests used
 * to build from the `loadGLB` result). The viewer's loop is paused: the test
 * drives time itself (runner ticks), nothing else steps.
 *
 * No behaviours are registered on the viewer (no continuous binding); the
 * DESRunner a test starts binds the material flow itself.
 */

import type { Object3D, Scene } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { RVDrive } from '../../src/core/engine/rv-drive';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { clearShared } from '../helpers/agv-harness';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';

export const PALLET_YARD_URL = '/demo-realvirtual/PalletYard.glb';

/** The bind host a `DESRunner.start(..., { root, host })` needs. */
export interface YardSceneHost {
  signalStore: RVViewer['signalStore'];
  on: () => () => void;
  contextMenu: ContextMenuStore;
  drives: RVDrive[];
  registry: RVViewer['registry'];
  getPlugin: () => undefined;
}

export interface LoadedYardScene {
  handle: TestViewerHandle;
  viewer: RVViewer;
  /** The model root (`PalletYard`), placements materialised below `PalletYardRoot`. */
  root: Object3D;
  scene: Scene;
  drives: RVDrive[];
  host: YardSceneHost;
  dispose(): void;
}

export interface LoadYardOptions {
  /** Override the public demo URL for another scene fixture. */
  url?: string;
  /** Runs before the load (register plugins — e.g. one carrying `bakeClaims()`). */
  before?: (viewer: RVViewer) => void;
  /** Leave the viewer loop paused (default true). */
  paused?: boolean;
}

/** Load the real scene with every placement materialised. */
export async function loadPalletYardScene(opts: LoadYardOptions = {}): Promise<LoadedYardScene> {
  clearShared();
  const handle = await createTestViewer('webgl');
  const viewer = handle.viewer;
  if (opts.paused !== false) viewer.loop.setPaused('pallet-yard-scene-load', true);
  opts.before?.(viewer);
  await viewer.loadModel(opts.url ?? PALLET_YARD_URL);
  await viewer.whenSceneReady();
  const root = (viewer as unknown as { currentModel: Object3D }).currentModel;
  viewer.scene.updateMatrixWorld(true);
  const host: YardSceneHost = {
    signalStore: viewer.signalStore, on: () => () => {}, contextMenu: new ContextMenuStore(),
    drives: viewer.drives, registry: viewer.registry, getPlugin: () => undefined,
  };
  return {
    handle, viewer, root, scene: viewer.scene, drives: viewer.drives, host,
    dispose: () => { handle.dispose(); clearShared(); },
  };
}

/** The node named `name` (first in traversal order), or null. */
export function nodeNamed(root: Object3D, name: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === name) hit = n; });
  return hit;
}
