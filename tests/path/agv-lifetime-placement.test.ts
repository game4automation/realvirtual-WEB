// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-647 §9.2 (F3, D3) — removing a placement takes its traffic with it.
 *
 * A real `RVViewer` loads a layout document with two placements P1 / P2
 * (hand-authored `AssetReference` nodes, materialised by the viewer's own
 * `PlacementInstancer` through a fake asset loader). Each placed asset carries
 * a loop of two paths and one Agv; the test registers one dock per placement
 * (`registerDock`, the way a station plugin does). P1 is then removed through
 * the production removal primitive (`removePlacedFromScene`):
 *  - P1's paths leave the network, P1's dock leaves the dock registry, P1's
 *    vehicle leaves fleet, planner, spacing and zones;
 *  - P2 keeps driving and its dock keeps serving;
 *  - P1 added again + its dock registered again → no "already has a dock"
 *    warning.
 *
 * Vehicle ids are scoped by their placement (plan-559 2b): `P1.AGV_P1`.
 *
 * No `clearShared()` between the steps. Every loop has a hard step bound.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { markDeferredPlacement, setAssetReference } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { collectDeferredPlacements } from '../../src/core/engine/rv-placement-instancer';
import { removePlacedFromScene, type SceneMutationDeps } from '../../src/plugins/layout-planner/scene-mutations';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-647-placement';
/** Hard bound for every drive phase (≈ 25 s sim time). */
const MAX_STEPS = 1500;

const URL_P1 = 'blob:rv-test/p647-cell-1.glb';
const URL_P2 = 'blob:rv-test/p647-cell-2.glb';

type V3 = [number, number, number];

function pathNode(id: string, from: V3, to: V3, successors: string[]): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors },
  };
  return n;
}

/** One placed cell: a loop `<p>_A` ↔ `<p>_B` and an Agv `AGV_<p>` on `<p>_A`. */
function cell(p: string): Group {
  const root = new Group();
  root.name = `Cell_${p}`;
  root.add(pathNode(`${p}_A`, [0, 0, 0], [3, 0, 0], [`${p}_B`]));
  root.add(pathNode(`${p}_B`, [3, 0, 0], [0, 0, 0.5], [`${p}_A`]));
  const agv = new Object3D();
  agv.name = `AGV_${p}`;
  // No own LayoutObject: the vehicle is CONTENT of its placement, so the
  // placement removal (`behaviors.disposeObject(root)`) tears its bind down.
  agv.userData.realvirtual = {
    Agv: { PathId: `${p}_A`, StartPosition: 0, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 },
  };
  const body = new Mesh(new BoxGeometry(0.6, 0.3, 1), new MeshBasicMaterial());
  body.position.y = 0.15;
  agv.add(body);
  root.add(agv);
  return root;
}

function treeFor(url: string): Group {
  if (url === URL_P1) return cell('P1');
  if (url === URL_P2) return cell('P2');
  throw new Error(`fake loader: unknown url ${url}`);
}

function referenceNode(name: string, id: string, url: string, pos: V3): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(...pos);
  setNodeId(node, id);
  setAssetReference(node, { assetId: `cat:${url.split('/').pop()}`, path: url });
  return node;
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

let handle: TestViewerHandle;
let viewer: RVViewer;

const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };
function tickUntil(done: () => boolean): number {
  let n = 0;
  while (!done() && n < MAX_STEPS) { tick(); n++; }
  return n;
}

/** Scene-mutation deps against the REAL viewer (what the planner plugin hands in). */
function removalDeps(objectMap: Map<string, Object3D>): SceneMutationDeps {
  const idByObject = new WeakMap<Object3D, string>();
  for (const [id, obj] of objectMap) idByObject.set(obj, id);
  return {
    getViewer: () => viewer,
    objectMap,
    idByObject,
    getLayoutRoot: () => viewer.currentModelRoot as unknown as Group,
    getTransformControls: () => null,
    getModelRoot: () => viewer.currentModelRoot,
    getBakeRegistry: () => viewer.placements.bakeRegistry,
    getPlacements: () => viewer.placements,
  };
}

beforeAll(async () => {
  clearShared();
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => ({ scene: treeFor(url) }),
  } as unknown as GLTFLoader;
  viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => viewer.placementUberMaterial,
    isWebGPU: () => viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
}, 180_000);

afterAll(async () => { await settleDevServer(); handle?.dispose(); clearShared(); }, 30_000);

describe('plan-647 §9.2 — placement removal takes its traffic with it', () => {
  it('P1 removed: its paths, dock and vehicle are gone; P2 drives on; re-adding P1 warns about nothing', async () => {
    const doc = new Group();
    doc.name = 'Layout';
    doc.add(referenceNode('P1', 'nid-p1', URL_P1, [0, 0, 0]));
    doc.add(referenceNode('P2', 'nid-p2', URL_P2, [0, 0, 6]));
    await viewer.loadModel('p647-layout.glb', { data: await objectToGlb(doc) });
    await viewer.whenSceneReady();
    await viewer.placements.whenMaterialized();
    viewer.scene.updateMatrixWorld(true);

    const net = getDefaultPathNetwork();
    const fleet = getDefaultAgvFleet();
    const mb = getDefaultMovementAuthority('continuous');
    const docks = getDefaultPathDockRegistry();
    expect(net.all().map((p) => p.id).sort()).toEqual(['P1_A', 'P1_B', 'P2_A', 'P2_B']);
    expect(fleet.get('P1.AGV_P1'), 'P1.AGV_P1 bound').not.toBeNull();
    expect(fleet.get('P2.AGV_P2'), 'P2.AGV_P2 bound').not.toBeNull();

    const arrivals: string[] = [];
    const dock = (name: string) => ({
      id: name,
      onVehicleArrive(agvId: string, release: () => void) { arrivals.push(`${name}:${agvId}`); release(); },
    });
    docks.register('P1_B', dock('D1'));
    docks.register('P2_B', dock('D2'));
    const s0 = tickUntil(() => arrivals.includes('D1:P1.AGV_P1') && arrivals.includes('D2:P2.AGV_P2'));
    expect(s0, 'both docks served within the bound').toBeLessThan(MAX_STEPS);

    // ── Remove P1 through the production primitive ──
    const p1 = viewer.scene.getObjectByName('P1');
    expect(p1, 'placement root P1').toBeTruthy();
    removePlacedFromScene(removalDeps(new Map([['nid-p1', p1!]])), 'nid-p1');

    const ids = net.all().map((p) => p.id).sort();
    console.log('[plan-647 9.2] paths after removing P1:', ids.join(','), 'dock P1_B:', docks.dockAt('P1_B') !== null);
    expect.soft(ids).toEqual(['P2_A', 'P2_B']);
    expect.soft(docks.dockAt('P1_B'), 'P1 dock unbound with its path').toBeNull();
    expect.soft(docks.dockAt('P2_B')).not.toBeNull();
    expect.soft(fleet.get('P1.AGV_P1')).toBeNull();
    expect.soft(mb.has('P1.AGV_P1')).toBe(false);
    expect.soft(getDefaultSpacingController().size).toBe(1);
    expect.soft(getDefaultZoneRegistry().collectHeld('P1.AGV_P1', [])).toBe(0);

    // ── P2 keeps driving and its dock keeps serving ──
    arrivals.length = 0;
    const s1 = tickUntil(() => arrivals.includes('D2:P2.AGV_P2'));
    expect(s1, 'P2 dock served again after the removal').toBeLessThan(MAX_STEPS);
    expect(arrivals.filter((a) => a.startsWith('D1:'))).toEqual([]);

    // ── P1 added again, dock registered again: no "already has a dock" warning ──
    const again = referenceNode('P1', 'nid-p1-again', URL_P1, [0, 0, 0]);
    markDeferredPlacement(again, 'nid-p1-again');
    viewer.currentModelRoot!.add(again);
    viewer.placements.materializeDeferred(collectDeferredPlacements(again));
    await viewer.placements.whenMaterialized();
    expect(net.get('P1_B'), 'P1 paths back').not.toBeNull();
    const warn = vi.spyOn(console, 'warn');
    try {
      docks.register('P1_B', dock('D1again'));
      const dockWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('already has a dock'));
      expect(dockWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 180_000);
});
