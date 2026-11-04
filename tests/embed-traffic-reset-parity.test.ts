// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-647 §9.4 (F2) — the embed and the main viewer empty the AGV traffic
 * registries through the SAME reset point (`resetTrafficRegistries()`).
 *
 * The same model (two paths, a zone) is loaded once in `<rv-embed>` and once
 * in a real `RVViewer`; both get the same plugin-style extras (a dock on a
 * path, a claim in the zone). The loaded registry sizes are equal, and after
 * the embed is removed resp. the main viewer clears its model, every
 * registry is empty (`trafficRegistryStats()` = 0).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { defineRVEmbedElement, type RVEmbedElement } from '../src/embed/rv-embed-element';
import { resetEmbedEngineRegistries } from '../src/embed/rv-embed-registry-reset';
import { getDefaultPathDockRegistry } from '../src/core/engine/rv-path-dock';
import { getDefaultZoneRegistry } from '../src/core/engine/rv-zone-registry';
import { trafficRegistryStats, type TrafficRegistryStats } from '../src/core/engine/rv-traffic-registries';
import { installEmbedBrowserMocks, type EmbedBrowserMocks } from './embed-test-kit';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { clearShared } from './helpers/agv-harness';

const ZERO: TrafficRegistryStats = {
  paths: 0, zones: 0, zoneHolders: 0, spacing: 0, docks: 0,
  authorityVehicles: { des: 0, continuous: 0 }, pendingClockEvents: 0, fleetHandles: 0,
};

function pathNode(id: string, z: number, successors: string[], extra?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: {
      type: 'Path', version: 1, closed: false, align: [0, 1, 0], id,
      segments: [{ kind: 'line', from: [0, 0, z], to: [0, 0, z + 2] }], successors, ...extra,
    },
  };
  return n;
}

async function modelBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'ParityCell';
  root.add(pathNode('PA', 0, ['PB'], { zone: 'ZP', zoneCapacity: 2 }));
  root.add(pathNode('PB', 2, []));
  return objectToGlb(root);
}

/** The plugin-style extras both runtimes get: a dock on PB, a claim in ZP. */
function addPluginState(): void {
  getDefaultPathDockRegistry().register('PB', { onVehicleArrive: (_id, release) => release() });
  expect(getDefaultZoneRegistry().claim('ZP', 'Plc')).toBe(true);
}

/**
 * Dev-server settle before teardown. A load makes the page import lazy chunks,
 * and Vite pre-transforms their imports in the background. With
 * `server.watch.usePolling` its chokidar watcher adds a polling watcher
 * (`fs.watchFile`) per transformed file; if vitest closes the server while
 * those adds are still in flight they are created AFTER the watcher closed,
 * and the never-unwatched STATWATCHERs keep the main process alive ("close
 * timed out … something prevents the main process from exiting").
 * Traced: three PRIV modules watched 7.7 s into a run, still live at exit.
 * Not a leak of the viewer — a tooling race; this short idle lets the server
 * finish before the run ends.
 */
const DEV_SERVER_SETTLE_MS = 2500;
const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, DEV_SERVER_SETTLE_MS));

let mocks: EmbedBrowserMocks;
let element: RVEmbedElement | null = null;
let handle: TestViewerHandle | null = null;
let blobUrl: string | null = null;

beforeEach(() => {
  clearShared();
  defineRVEmbedElement();
  mocks = installEmbedBrowserMocks(false);
});

afterEach(async () => {
  await settleDevServer();
  element?.remove();
  element = null;
  handle?.dispose();
  handle = null;
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  resetEmbedEngineRegistries();
  vi.restoreAllMocks();
  mocks.restore();
  clearShared();
});

describe('plan-647 §9.4 — embed and main viewer share the traffic reset', () => {
  it('loaded sizes are equal; embed removal and clearModel() both empty every registry', async () => {
    const bytes = await modelBytes();

    // ── Embed: load → plugin state → remove ──
    blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'model/gltf-binary' }));
    element = document.createElement('rv-embed') as RVEmbedElement;
    element.setAttribute('src', blobUrl);
    element.setAttribute('run', 'manual');
    element.style.width = '320px';
    element.style.height = '200px';
    let ready = false;
    element.addEventListener('rv-ready', () => { ready = true; });
    document.body.append(element);
    await element.viewer.play();
    expect(ready, 'embed reached rv-ready').toBe(true);
    addPluginState();
    const embedLoaded = trafficRegistryStats();
    element.remove();
    element = null;
    const embedCleared = trafficRegistryStats();

    // ── Main viewer: the same flow ──
    handle = await createTestViewer('webgl');
    await handle.viewer.loadModel('parity-cell.glb', { data: bytes });
    await handle.viewer.whenSceneReady();
    addPluginState();
    const mainLoaded = trafficRegistryStats();
    handle.viewer.clearModel();
    const mainCleared = trafficRegistryStats();

    console.log('[plan-647 9.4] embed', JSON.stringify(embedLoaded), '→', JSON.stringify(embedCleared));
    console.log('[plan-647 9.4] main ', JSON.stringify(mainLoaded), '→', JSON.stringify(mainCleared));
    expect(embedLoaded.paths).toBe(2);
    expect(embedLoaded.docks).toBe(1);
    expect(embedLoaded.zoneHolders).toBe(1);
    expect(mainLoaded).toEqual(embedLoaded);
    expect(embedCleared).toEqual(ZERO);
    expect(mainCleared).toEqual(ZERO);
  }, 120_000);
});
