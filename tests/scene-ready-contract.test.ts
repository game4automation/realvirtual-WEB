// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 structure hardening, part 2 — the scene-ready contract.
 *
 * `model-loaded` is NOT "the scene is complete": the placed references of a
 * layout document materialise asynchronously after it (`viewer.placements`).
 * One state, one event, one join point:
 *
 *   viewer.placements.state                'idle' | 'materializing'
 *   viewer event placements-materialized   exactly once per load
 *   viewer.whenSceneReady()                no load in flight AND placements idle
 *
 * Pinned here, on a REAL `RVViewer` with a gated in-memory decode (the second
 * asset's bake is held until the test opens its gate):
 *  (a) the event fires exactly once per load — zero references, references,
 *      abort by a document change;
 *  (b) `whenSceneReady()` resolves after the last `layout-content-added`;
 *  (c) the simulation is held while the scene is incomplete and the transport
 *      topology sees BOTH conveyors afterwards;
 *  (d) the MCP open verbs' fields: `pending === 0` when ready, `pending > 0` +
 *      hint when the budget runs out; `web_status.placements`;
 *  (e) a save mid-materialisation writes EVERY reference (bytes + op log, not
 *      the scene graph);
 *  (f) the camera re-fits the complete layout only when nobody moved it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { PLACEMENTS_PAUSE_REASON } from '../src/core/engine/rv-scene-ready';
import type { PlacementsSettledInfo } from '../src/core/engine/rv-placement-instancer';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { placementsStatus, sceneReadyFields, setSceneReadyBudgetMs } from '../src/plugins/mcp-bridge/rv-mcp-scene-ready';
import { SensorRecorderPlugin } from '../src/plugins/sensor-recorder-plugin';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { withComponent, group } from './fixtures/bake-fixture';
import {
  INNER_URL, OUTER_URL, CELL_REF_NODE_ID, bootNestedViewer, sleep as nestedSleep,
  documentBytes as nestedDocumentBytes, plainBytes as nestedPlainBytes, type Booted as NestedBooted,
} from './helpers/nested-placement-fixture';
void nestedSleep;

const FAST_URL = 'blob:rv-test/ready-conveyor-a.glb';
const SLOW_URL = 'blob:rv-test/ready-conveyor-b.glb';

/** Conveyor: frame + Transport-Z{belt} — one TransportSurface per occurrence. */
function makeConveyor(name: string): Group {
  const root = group(name);
  const frame = new Mesh(new BoxGeometry(2, 0.2, 0.6), new MeshStandardMaterial({ color: 0x336699 }));
  frame.name = 'frame';
  frame.position.set(0, 0.4, 0);
  root.add(frame);
  const transport = withComponent(group('Transport-Z'), 'TransportSurface', { speed: 200 });
  const belt = new Mesh(new BoxGeometry(2, 0.05, 0.5), new MeshStandardMaterial({ color: 0x222222 }));
  belt.name = 'belt';
  belt.position.set(0, 0.55, 0);
  transport.add(belt);
  root.add(transport);
  const sensor = withComponent(group('Sensor-1'), 'Sensor', { UseRaycast: false });
  const beam = new Mesh(new BoxGeometry(0.1, 0.3, 0.6), new MeshStandardMaterial({ color: 0x339933 }));
  beam.name = 'beam';
  beam.position.set(0.9, 0.7, 0);
  sensor.add(beam);
  root.add(sensor);
  return root;
}

interface Spec { id: string; name: string; position: [number, number, number]; url: string; assetId: string }

/** Two conveyors end to end (A feeds B); B is the asset whose decode the test holds. */
const LINE: Spec[] = [
  { id: 'plc_a', name: 'ConveyorA', position: [40, 0, 0], url: FAST_URL, assetId: 'cat:conv-a' },
  { id: 'plc_b', name: 'ConveyorB', position: [42, 0, 0], url: SLOW_URL, assetId: 'cat:conv-b' },
];

async function documentBytes(specs: Spec[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  for (const s of specs) {
    const node = new Object3D();
    node.name = s.name;
    node.position.set(...s.position);
    setNodeId(node, s.id);
    setAssetReference(node, { assetId: s.assetId, path: s.url });
    setPlacementMeta(node, {});
    root.add(node);
  }
  return objectToGlb(root);
}

async function plainBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Plain';
  const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x884422 }));
  m.name = 'box';
  root.add(m);
  return objectToGlb(root);
}

interface Booted {
  h: TestViewerHandle;
  /** Let the SLOW asset decode. */
  openSlow(): void;
  settled: PlacementsSettledInfo[];
  order: string[];
}

let handle: TestViewerHandle | null = null;
let restoreBudget: number | null = null;
afterEach(() => {
  handle?.dispose();
  handle = null;
  if (restoreBudget !== null) { setSceneReadyBudgetMs(restoreBudget); restoreBudget = null; }
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Real viewer, no planner; the SLOW asset decodes only once its gate is opened. */
async function boot(): Promise<Booted> {
  const h = await createTestViewer('webgl');
  handle = h;
  let openGate!: () => void;
  const gate = new Promise<void>((r) => { openGate = r; });
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      if (url === SLOW_URL) await gate;
      return { scene: makeConveyor(url === SLOW_URL ? 'ConveyorB' : 'ConveyorA') };
    },
  } as unknown as GLTFLoader;
  h.viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => h.viewer.placementUberMaterial,
    isWebGPU: () => h.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  const settled: PlacementsSettledInfo[] = [];
  const order: string[] = [];
  h.viewer.on('model-loaded', () => order.push('model-loaded'));
  h.viewer.on('layout-content-added', () => order.push('layout-content-added'));
  h.viewer.on('placements-materialized', (info) => {
    settled.push(info);
    order.push(info.aborted ? 'aborted' : 'materialized');
  });
  return { h, settled, order, openSlow: () => openGate() };
}

describe('scene-ready contract (plan-753)', () => {
  it('(a) a document WITHOUT references: one event, right after model-loaded, state idle', async () => {
    const { h, settled, order } = await boot();
    await h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    expect(settled).toEqual([{ aborted: false, total: 0, materialized: 0, missing: 0 }]);
    expect(order).toEqual(['model-loaded', 'materialized']);
    expect(h.viewer.placements.state).toBe('idle');
    await h.viewer.whenSceneReady(); // resolves at once
    expect(settled).toHaveLength(1);
  });

  it('(a)(b) references: no event while a bake is pending; ONE event; whenSceneReady after the last layout-content-added', async () => {
    const { h, openSlow, settled, order } = await boot();
    await h.viewer.loadModel('line.glb', { data: await documentBytes(LINE) });

    // `loadModel` is back and `model-loaded` fired — the scene is NOT complete.
    expect(order[0]).toBe('model-loaded');
    expect(h.viewer.placements.state).toBe('materializing');
    expect(settled, 'no event while B is still baking').toHaveLength(0);

    let drivesChanged = 0;
    h.viewer.on('drives-changed', () => { drivesChanged++; });
    let ready = false;
    const readyP = h.viewer.whenSceneReady().then(() => { ready = true; order.push('ready'); });
    // The fast asset lands on its own; the join point must NOT resolve on it.
    await sleep(80);
    expect(order.filter((e) => e === 'layout-content-added')).toHaveLength(1);
    expect(ready).toBe(false);
    expect(h.viewer.placements.progress).toMatchObject({ state: 'materializing', total: 2, materialized: 1, pending: 1 });

    openSlow();
    await readyP;
    expect(order).toEqual(['model-loaded', 'layout-content-added', 'layout-content-added', 'materialized', 'ready']);
    expect(settled).toEqual([{ aborted: false, total: 2, materialized: 2, missing: 0 }]);
    expect(h.viewer.placements.progress).toMatchObject({ state: 'idle', pending: 0, materialized: 2, missing: 0 });
    // Drive order / recorder / React drive list re-derive ONCE for the whole batch.
    expect(drivesChanged).toBe(1);
  });

  it('(a) a document change mid-materialisation: ONE aborted event for the old load, one for the new; the orphaned bake writes nothing', async () => {
    const { h, openSlow, settled, order } = await boot();
    await h.viewer.loadModel('line.glb', { data: await documentBytes(LINE) });
    expect(h.viewer.placements.state).toBe('materializing');
    const waiter = h.viewer.whenSceneReady();

    await h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    expect(settled.map((s) => s.aborted)).toEqual([true, false]);
    expect(settled[1]).toEqual({ aborted: false, total: 0, materialized: 0, missing: 0 });

    // The join point followed the document change and resolved for the NEW one.
    await waiter;
    expect(h.viewer.placements.state).toBe('idle');

    // The old document's bake finishes now — into nothing.
    const before = order.length;
    openSlow();
    await sleep(80);
    expect(order.slice(before)).toEqual([]);
    expect(settled).toHaveLength(2);
    // (The plain model is itself ONE in-place bake instance — nothing else.)
    expect(h.viewer.bakeRegistry.stats().instances).toBe(1);
    expect(h.viewer.transportManager!.surfaces).toHaveLength(0);
    expect(h.viewer.placements.progress).toMatchObject({ total: 0, materialized: 0, pending: 0 });
    expect(h.viewer.simulationPauseReasons).not.toContain(PLACEMENTS_PAUSE_REASON);
  });

  it('(c) the simulation is held while the scene is incomplete; afterwards the transport manager has BOTH conveyors', async () => {
    const { h, openSlow } = await boot();
    // A snapshot-at-onModelLoaded consumer: the sensor recorder.
    const recorder = new SensorRecorderPlugin();
    h.viewer.use(recorder);
    await h.viewer.loadModel('line.glb', { data: await documentBytes(LINE) });
    expect(recorder.recorder.series, 'onModelLoaded saw a scene without its references').toHaveLength(0);

    // Half a line: A is there (or about to be), B is not. A source on A would
    // run its MUs off an end that is none — the sim must not tick.
    expect(h.viewer.simulationPauseReasons).toContain(PLACEMENTS_PAUSE_REASON);
    expect(h.viewer.isSimulationPaused).toBe(true);
    await sleep(80);
    expect(h.viewer.transportManager!.surfaces).toHaveLength(1);
    expect(h.viewer.isSimulationPaused, 'still held: B is pending').toBe(true);

    let topologyChanges = 0;
    const tm = h.viewer.transportManager!;
    const original = tm.notifyTopologyChanged.bind(tm);
    tm.notifyTopologyChanged = () => { topologyChanges++; original(); };

    openSlow();
    await h.viewer.whenSceneReady();
    expect(tm.surfaces).toHaveLength(2);
    expect(recorder.recorder.series, 'the recorder re-seeded on placements-materialized').toHaveLength(2);
    expect(topologyChanges, 'the late conveyor invalidated the topology caches itself').toBeGreaterThan(0);
    expect(h.viewer.simulationPauseReasons).not.toContain(PLACEMENTS_PAUSE_REASON);
    expect(h.viewer.isSimulationPaused).toBe(false);

    // A user pause is not the hold's to release.
    h.viewer.setSimulationPaused('user', true);
    h.viewer.clearModel();
    expect(h.viewer.simulationPauseReasons).toEqual(['user']);
  });

  it('(d) MCP open verbs: pending > 0 + hint when the budget runs out, pending === 0 once ready; web_status.placements', async () => {
    const { h, openSlow } = await boot();
    restoreBudget = setSceneReadyBudgetMs(80);
    await h.viewer.loadModel('line.glb', { data: await documentBytes(LINE) });

    const t0 = performance.now();
    const early = await sceneReadyFields(h.viewer);
    expect(performance.now() - t0, 'answers instead of hanging').toBeLessThan(2000);
    expect(early.placements).toMatchObject({ total: 2, pending: 1 });
    expect(early.placementsHint).toMatch(/web_status/);
    expect(placementsStatus(h.viewer)).toMatchObject({ state: 'materializing', pending: 1, total: 2, loading: false });

    openSlow();
    setSceneReadyBudgetMs(5000);
    const late = await sceneReadyFields(h.viewer);
    expect(late.placements).toEqual({ total: 2, materialized: 2, pending: 0, missing: 0 });
    expect(late.placementsHint).toBeUndefined();
    expect(placementsStatus(h.viewer)).toMatchObject({ state: 'idle', pending: 0 });

    // A host without the contract (test doubles) gets no fields and no wait.
    expect(await sceneReadyFields(undefined)).toEqual({});

    // The verbs really spread it.
    const tools = (await import('../src/plugins/mcp-bridge/rv-mcp-project-tools.ts?raw')).default as string;
    expect(tools.match(/\.\.\.\(await sceneReadyFields\(this\.viewer\)\)/g)?.length).toBe(3);
    expect(tools).toContain('...(ok ? await sceneReadyFields(this.viewer) : {})');
    const bridge = (await import('../src/plugins/mcp-bridge-plugin.ts?raw')).default as string;
    expect(bridge).toContain('placements: placementsStatus(this.viewer)');
  });

  it('(e) a save while materializing writes EVERY reference — the body is bytes + op log, not the scene graph', async () => {
    const { h, openSlow } = await boot();
    const source = await documentBytes(LINE);
    await h.viewer.loadModel('line.glb', { data: source.slice(0) });
    await sleep(80);
    expect(h.viewer.placements.progress.pending).toBe(1);

    // What `SceneStore._writeBody` does, with the registry of the HALF scene.
    const registry = h.viewer.registry!;
    const frames = h.viewer.lastLoadResult?.composition?.frames ?? [];
    const result = await bakeIntoGlb(source.slice(0), materialise([]), makeRegistryBakeResolver(registry, frames), {
      expectedNames: registry.getGltfNodeNames(),
    });
    const json = parseGlbChunks(result.glb).json as {
      nodes?: Array<{ name?: string; extras?: { realvirtual?: Record<string, unknown> } }>;
    };
    const references = (json.nodes ?? []).filter((n) => n.extras?.realvirtual?.AssetReference);
    expect(references.map((n) => n.name).sort()).toEqual(['ConveyorA', 'ConveyorB']);

    openSlow();
    await h.viewer.whenSceneReady();
  });

  it('consumers that judge the WHOLE scene join the contract (source pins)', async () => {
    // Orphaned-binding self-heal: a carrier inside a late placement is not orphaned.
    const bind = (await import('../src/plugins/signal-bind/SignalBindPlugin.ts?raw')).default as string;
    const readyAt = bind.indexOf('await viewer.whenSceneReady?.();');
    expect(readyAt).toBeGreaterThan(-1);
    expect(readyAt, 'BEFORE the registry is asked').toBeLessThan(bind.indexOf('findOrphanedBindingCarriers(overlay, registry)'));
    // DES re-binds once the references exist; model-loaded stays what it was. Since
    // plan-612 CP1d-b (2026-10-20) the hook calls `rebindScene()` (tears down the
    // scene-discovered instances and rediscovers) instead of `reset()`, which never
    // rediscovered once the runner held instances (direct DES start bound nothing).
    const viewerSrc = (await import('../src/core/rv-viewer.ts?raw')).default as string;
    // plan-645 L4: still on placements-materialized, now skipping a served scene generation.
    expect(viewerSrc).toContain("if (info.aborted || info.materialized <= 0) return;");
    expect(viewerSrc).toContain("if (served !== null && served === this._sceneGeneration) return;");
    expect(viewerSrc).toContain("this.emit('model-loaded', { result });\n".replace('\n', ''));
    expect(viewerSrc.indexOf('this.placements.sealLoad();')).toBeGreaterThan(viewerSrc.indexOf("this.emit('model-loaded', { result });"));
  });

  it('(f) the camera re-frames the complete layout when it was left alone — and only then', async () => {
    // Unmoved: the load framed an EMPTY root (the references sit far from the origin).
    const first = await boot();
    await first.h.viewer.loadModel('line.glb', { data: await documentBytes(LINE) });
    const framedEmpty = first.h.viewer.controls.target.clone();
    first.openSlow();
    await first.h.viewer.whenSceneReady();
    expect(first.h.viewer.controls.target.distanceTo(framedEmpty), 'refit onto the line at x≈41').toBeGreaterThan(10);
    expect(first.h.viewer.controls.target.x).toBeGreaterThan(38);
    first.h.dispose();
    handle = null;

    // Moved by the user while the placements were still coming: hands off.
    const second = await boot();
    await second.h.viewer.loadModel('line.glb', { data: await documentBytes(LINE) });
    second.h.viewer.camera.position.set(3, 4, 5);
    second.h.viewer.controls.target.set(1, 0, 1);
    second.openSlow();
    await second.h.viewer.whenSceneReady();
    expect(second.h.viewer.controls.target.toArray()).toEqual([1, 0, 1]);
    expect(second.h.viewer.camera.position.toArray()).toEqual([3, 4, 5]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// (g) plan-757 Phase 2 — nested placements are part of the SAME contract
// ═══════════════════════════════════════════════════════════════════════

describe('scene-ready contract (g) — a reference inside a placed asset is a placement too (plan-757 Phase 2)', () => {
  let nested: NestedBooted | null = null;
  afterEach(() => { nested?.h.dispose(); nested = null; });

  it('whenSceneReady resolves only after the INNERMOST materialisation; ONE placements-materialized; no gap between the levels', async () => {
    nested = await bootNestedViewer({ gate: INNER_URL });
    const { h, open, settled, order } = nested;
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]) });
    expect(order[0]).toBe('model-loaded');

    let ready = false;
    const readyP = h.viewer.whenSceneReady().then(() => { ready = true; order.push('ready'); });
    // The outer asset lands on its own; its nested reference is now queued and gated.
    await sleep(80);
    expect(order.filter((e) => e.startsWith('added:'))).toEqual(['added:Machine_1']);
    expect(ready, 'not ready while the nested asset bakes').toBe(false);
    expect(settled, 'no settle between the outer and its nested placement').toHaveLength(0);
    expect(h.viewer.placements.progress).toMatchObject({ state: 'materializing', total: 2, materialized: 1, pending: 1 });
    expect(h.viewer.placements.isMaterializing(`plc-machine/${CELL_REF_NODE_ID}`)).toBe(true);
    expect(h.viewer.simulationPauseReasons).toContain(PLACEMENTS_PAUSE_REASON);

    open();
    await readyP;
    expect(order).toEqual(['model-loaded', 'added:Machine_1', 'added:Cell_1', 'materialized', 'ready']);
    expect(settled).toEqual([{ aborted: false, total: 2, materialized: 2, missing: 0 }]);
    expect(h.viewer.placements.progress).toMatchObject({ state: 'idle', pending: 0, materialized: 2, missing: 0 });
    expect(h.viewer.simulationPauseReasons).not.toContain(PLACEMENTS_PAUSE_REASON);
  });

  it('a document change mid-nesting: ONE aborted settle for the old load, the orphaned nested bake writes nothing', async () => {
    nested = await bootNestedViewer({ gate: INNER_URL });
    const { h, open, settled, order } = nested;
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]) });
    await sleep(80);
    expect(order.filter((e) => e.startsWith('added:'))).toEqual(['added:Machine_1']);
    expect(h.viewer.placements.state).toBe('materializing');
    const waiter = h.viewer.whenSceneReady();

    await h.viewer.loadModel('plain.glb', { data: await nestedPlainBytes() });
    expect(settled.map((s) => s.aborted)).toEqual([true, false]);
    await waiter;
    expect(h.viewer.placements.state).toBe('idle');

    const before = order.length;
    open();
    await sleep(80);
    expect(order.slice(before)).toEqual([]);
    expect(settled).toHaveLength(2);
    // Only the plain model's identity instance is alive.
    expect(h.viewer.bakeRegistry.stats().instances).toBe(1);
    expect(h.viewer.placements.progress).toMatchObject({ total: 0, materialized: 0, pending: 0 });
  });
});
